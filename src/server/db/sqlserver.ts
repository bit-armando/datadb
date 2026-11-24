import mssql from "mssql";
import { XMLParser } from "fast-xml-parser";
import { assignUniqueColumnKeys } from "@/lib/query-columns";
import type {
  ColumnMeta,
  ConnectionProfile,
  ExplainNode,
  ForeignKeyRef,
  QueryColumn,
  QueryResult,
  RoutineMeta,
  SchemaNode,
  TableMeta,
  TriggerMeta,
} from "@/lib/types";
import type { BatchEditInput, DatabaseDriver } from "./types";
import { DEFAULT_LIMIT } from "./limit";
import { normalizeArrayRow } from "./normalize-row";

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export class SqlServerDriver implements DatabaseDriver {
  private pool: mssql.ConnectionPool;
  private connectPromise: Promise<mssql.ConnectionPool> | null = null;
  private config: ConnectionProfile;
  private activeRequests = new Set<mssql.Request>();

  constructor(config: ConnectionProfile) {
    this.config = config;
    this.pool = new mssql.ConnectionPool({
      server: config.host,
      port: config.port || 1433,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionTimeout: 8000,
      requestTimeout: 30000,
      pool: { max: 5 },
      options: {
        // trustServerCertificate=true por default: la mayoría de instancias
        // self-hosted/dev no tienen un certificado válido para TLS. Azure SQL
        // sigue funcionando igual porque su certificado sí es de confianza.
        encrypt: true,
        trustServerCertificate: true,
      },
    });
  }

  private async ensureConnected(): Promise<mssql.ConnectionPool> {
    if (this.pool.connected) return this.pool;
    if (!this.connectPromise) {
      this.connectPromise = this.pool.connect().catch((err) => {
        this.connectPromise = null;
        throw err;
      });
    }
    return this.connectPromise;
  }

  async testConnection(): Promise<void> {
    const pool = await this.ensureConnected();
    await pool.request().query("SELECT 1");
  }

  async listDatabases(): Promise<string[]> {
    const pool = await this.ensureConnected();
    // database_id > 4 excluye las bases del sistema (master, tempdb, model, msdb).
    const result = await pool.request().query<{ name: string }>(
      "SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name"
    );
    return result.recordset.map((r) => r.name);
  }

  async getSchema(): Promise<SchemaNode[]> {
    const pool = await this.ensureConnected();

    const schemaResult = await pool.request().query<{ schema_name: string }>(`
      SELECT s.name AS schema_name
      FROM sys.schemas s
      WHERE s.name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest', 'db_owner', 'db_accessadmin',
        'db_securityadmin', 'db_ddladmin', 'db_backupoperator', 'db_datareader',
        'db_datawriter', 'db_denydatareader', 'db_denydatawriter')
      ORDER BY s.name
    `);

    const schemas: SchemaNode[] = [];

    for (const { schema_name: schemaName } of schemaResult.recordset) {
      const tableResult = await pool
        .request()
        .input("schema", mssql.NVarChar, schemaName)
        .query<{ table_name: string; table_type: string }>(`
          SELECT TABLE_NAME AS table_name, TABLE_TYPE AS table_type
          FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = @schema
          ORDER BY TABLE_NAME
        `);

      const tables: TableMeta[] = [];

      for (const { table_name: tableName, table_type: tableType } of tableResult.recordset) {
        const type = tableType === "VIEW" ? "view" : "table";

        const columnResult = await pool
          .request()
          .input("schema", mssql.NVarChar, schemaName)
          .input("table", mssql.NVarChar, tableName)
          .query<{ column_name: string; data_type: string; is_nullable: string }>(`
            SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table
            ORDER BY ORDINAL_POSITION
          `);

        const pkResult = await pool
          .request()
          .input("schema", mssql.NVarChar, schemaName)
          .input("table", mssql.NVarChar, tableName)
          .query<{ column_name: string }>(`
            SELECT kcu.COLUMN_NAME AS column_name
            FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
              ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
             AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
            WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
              AND tc.TABLE_SCHEMA = @schema AND tc.TABLE_NAME = @table
          `);
        const pkSet = new Set(pkResult.recordset.map((r) => r.column_name));

        const fkResult = await pool
          .request()
          .input("schema", mssql.NVarChar, schemaName)
          .input("table", mssql.NVarChar, tableName)
          .query<{
            column_name: string;
            foreign_schema_name: string;
            foreign_table_name: string;
            foreign_column_name: string;
          }>(`
            SELECT
              kcu.COLUMN_NAME AS column_name,
              kcu2.TABLE_SCHEMA AS foreign_schema_name,
              kcu2.TABLE_NAME AS foreign_table_name,
              kcu2.COLUMN_NAME AS foreign_column_name
            FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
              ON rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
             AND rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu2
              ON rc.UNIQUE_CONSTRAINT_NAME = kcu2.CONSTRAINT_NAME
             AND rc.UNIQUE_CONSTRAINT_SCHEMA = kcu2.TABLE_SCHEMA
             AND kcu.ORDINAL_POSITION = kcu2.ORDINAL_POSITION
            WHERE kcu.TABLE_SCHEMA = @schema AND kcu.TABLE_NAME = @table
          `);

        const fkMap = new Map<string, ForeignKeyRef>();
        for (const fk of fkResult.recordset) {
          fkMap.set(fk.column_name, {
            schema: fk.foreign_schema_name,
            table: fk.foreign_table_name,
            column: fk.foreign_column_name,
          });
        }

        const columns: ColumnMeta[] = columnResult.recordset.map((col) => ({
          name: col.column_name,
          type: col.data_type,
          isPrimaryKey: pkSet.has(col.column_name),
          nullable: col.is_nullable === "YES",
          fk: fkMap.get(col.column_name),
        }));

        tables.push({ name: tableName, type, columns });
      }

      schemas.push({
        name: schemaName,
        tables,
        routines: await this.fetchRoutines(schemaName),
        triggers: await this.fetchTriggers(schemaName),
      });
    }

    return schemas;
  }

  private async fetchRoutines(schemaName: string): Promise<RoutineMeta[]> {
    const pool = await this.ensureConnected();
    const result = await pool
      .request()
      .input("schema", mssql.NVarChar, schemaName)
      .query<{ routine_name: string; routine_type: string }>(`
        SELECT ROUTINE_NAME AS routine_name, ROUTINE_TYPE AS routine_type
        FROM INFORMATION_SCHEMA.ROUTINES
        WHERE ROUTINE_SCHEMA = @schema
          AND ROUTINE_TYPE IN ('FUNCTION', 'PROCEDURE')
        ORDER BY ROUTINE_NAME
      `);
    return result.recordset.map((r) => ({
      name: r.routine_name,
      type: r.routine_type === "PROCEDURE" ? "procedure" : "function",
    }));
  }

  private async fetchTriggers(schemaName: string): Promise<TriggerMeta[]> {
    const pool = await this.ensureConnected();
    const result = await pool
      .request()
      .input("schema", mssql.NVarChar, schemaName)
      .query<{
        trigger_name: string;
        event_object_table: string;
        timing: string;
        event: string;
      }>(`
        SELECT
          t.name AS trigger_name,
          tb.name AS event_object_table,
          CASE WHEN t.is_instead_of_trigger = 1 THEN 'INSTEAD OF' ELSE 'AFTER' END AS timing,
          ISNULL(STUFF((
            SELECT ', ' + te.type_desc
            FROM sys.trigger_events te
            WHERE te.object_id = t.object_id
              AND te.is_first = 1
            FOR XML PATH(''), TYPE
          ).value('.', 'NVARCHAR(MAX)'), 1, 2, ''), 'INSERT OR UPDATE OR DELETE') AS event
        FROM sys.triggers t
        JOIN sys.tables tb ON tb.object_id = t.parent_id
        JOIN sys.schemas s ON s.schema_id = tb.schema_id
        WHERE s.name = @schema
        ORDER BY t.name
      `);
    return result.recordset.map((r) => ({
      name: r.trigger_name,
      targetTable: r.event_object_table,
      timing: r.timing,
      event: r.event,
    }));
  }

  async executeQuery(sql: string, tx?: unknown): Promise<QueryResult> {
    const start = Date.now();
    const txHandle = tx as mssql.Transaction | undefined;
    const pool = await this.ensureConnected();
    const request = txHandle ? txHandle.request() : pool.request();
    // Solo trackeamos para cancelación las requests propias (no las de
    // transacción, que el usuario controla explícitamente con Commit/Rollback).
    if (!txHandle) this.activeRequests.add(request);

    try {
      request.arrayRowMode = true;
      const result = await request.query(sql);
      const durationMs = Date.now() - start;

      const recordset = result.recordset;
      const rawCols = (
        result as unknown as { columns?: Array<Array<{ name: string; type: unknown }>> }
      ).columns?.[0];
      if (recordset && rawCols && rawCols.length > 0) {
        const columns: QueryColumn[] = assignUniqueColumnKeys(
          rawCols.map((meta) => ({
            name: meta.name,
            type: this.sqlTypeName(meta.type),
          }))
        );
        const rows = (recordset as unknown as unknown[][]).map((row) =>
          normalizeArrayRow(row, columns, (buf) => buf.toString("hex"))
        );
        return {
          columns,
          rows,
          rowCount: rows.length,
          durationMs,
          limitApplied: false,
          effectiveLimit: DEFAULT_LIMIT,
        };
      }

      const affectedRows = Array.isArray(result.rowsAffected)
        ? result.rowsAffected.reduce((acc, n) => acc + n, 0)
        : 0;

      return {
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows,
        durationMs,
        limitApplied: false,
        effectiveLimit: DEFAULT_LIMIT,
      };
    } finally {
      if (!txHandle) this.activeRequests.delete(request);
    }
  }

  private sqlTypeName(type: unknown): string {
    if (typeof type === "function") return type.name || "unknown";
    if (type && typeof type === "object" && "name" in type) {
      return String((type as { name: unknown }).name ?? "unknown");
    }
    return "unknown";
  }

  async beginTransaction(): Promise<unknown> {
    const pool = await this.ensureConnected();
    const tx = new mssql.Transaction(pool);
    await tx.begin();
    return tx;
  }

  async commitTransaction(tx: unknown): Promise<void> {
    await (tx as mssql.Transaction).commit();
  }

  async rollbackTransaction(tx: unknown): Promise<void> {
    await (tx as mssql.Transaction).rollback();
  }

  async explainQuery(sql: string): Promise<ExplainNode> {
    const cleaned = sql.trim().replace(/;+\s*$/, "");
    const pool = await this.ensureConnected();
    // SHOWPLAN_XML no ejecuta la query, solo devuelve el plan estimado — debe
    // activarse/desactivarse en la misma conexión que la query, por eso usamos
    // una transacción (fija una única conexión del pool) y la revertimos al
    // final aunque no haya escritura real de por medio.
    const tx = new mssql.Transaction(pool);
    await tx.begin();
    try {
      await tx.request().batch("SET SHOWPLAN_XML ON");
      const result = await tx.request().query(cleaned);
      await tx.request().batch("SET SHOWPLAN_XML OFF");
      await tx.rollback();

      const row = result.recordset?.[0] as Record<string, unknown> | undefined;
      const xml = row ? String(Object.values(row)[0] ?? "") : "";
      if (!xml) {
        return { type: "unknown", detail: "No se pudo obtener el plan", children: [] };
      }
      return this.parseShowplanXml(xml);
    } catch (err) {
      await tx.rollback().catch(() => undefined);
      throw err;
    }
  }

  private parseShowplanXml(xml: string): ExplainNode {
    try {
      const parsed = xmlParser.parse(xml) as Record<string, unknown>;
      const showplan = parsed["ShowPlanXML"] as Record<string, unknown> | undefined;
      const batchStmts = showplan?.["BatchSequence"] as Record<string, unknown> | undefined;
      const batch = batchStmts?.["Batch"];
      const batchNode = Array.isArray(batch) ? batch[0] : batch;
      const stmts = (batchNode as Record<string, unknown> | undefined)?.["Statements"] as
        | Record<string, unknown>
        | undefined;
      const stmt = stmts?.["StmtSimple"] ?? stmts?.["StmtCursor"];
      const stmtNode = (Array.isArray(stmt) ? stmt[0] : stmt) as Record<string, unknown> | undefined;
      const queryPlan = stmtNode?.["QueryPlan"] as Record<string, unknown> | undefined;
      const relOp = queryPlan?.["RelOp"];
      if (!relOp) {
        return { type: "unknown", detail: "No se pudo interpretar el plan", children: [] };
      }
      const cost = typeof stmtNode?.["@_StatementSubTreeCost"] !== "undefined"
        ? Number(stmtNode["@_StatementSubTreeCost"])
        : undefined;
      const root = this.convertRelOp(relOp as Record<string, unknown>);
      if (cost !== undefined && !Number.isNaN(cost)) root.cost = cost;
      return root;
    } catch {
      return { type: "unknown", detail: "No se pudo interpretar el plan XML", children: [] };
    }
  }

  private convertRelOp(node: Record<string, unknown>): ExplainNode {
    const physicalOp = String(node["@_PhysicalOp"] ?? "unknown");
    const estRows = node["@_EstimateRows"] !== undefined ? Number(node["@_EstimateRows"]) : undefined;
    const estCost = node["@_EstimatedTotalSubtreeCost"] !== undefined
      ? Number(node["@_EstimatedTotalSubtreeCost"])
      : undefined;

    // Buscar referencia de objeto (tabla/índice) en cualquiera de los nodos
    // hijos típicos (IndexScan, TableScan, Seek, Clustered Index Scan, etc.)
    let objectRef: Record<string, unknown> | undefined;
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (val && typeof val === "object" && "Object" in (val as Record<string, unknown>)) {
        const objVal = (val as Record<string, unknown>)["Object"];
        objectRef = (Array.isArray(objVal) ? objVal[0] : objVal) as Record<string, unknown> | undefined;
        break;
      }
    }
    const table = objectRef?.["@_Table"] ? String(objectRef["@_Table"]).replace(/[[\]]/g, "") : undefined;
    const index = objectRef?.["@_Index"] ? String(objectRef["@_Index"]).replace(/[[\]]/g, "") : undefined;

    const detailParts: string[] = [];
    if (table) detailParts.push(`en ${table}`);
    if (index) detailParts.push(`usando índice ${index}`);
    else if (/Scan/i.test(physicalOp) && table) detailParts.push("sin índice (scan)");

    // Table/Clustered Index Scan sin índice específico y con muchas filas
    // estimadas: el patrón clásico de "falta un índice".
    const expensive = /Scan/i.test(physicalOp) && (estRows ?? 0) > 1000;

    const children: ExplainNode[] = [];
    const relOpList = node["RelOp"];
    if (relOpList) {
      const list = Array.isArray(relOpList) ? relOpList : [relOpList];
      for (const child of list) {
        children.push(this.convertRelOp(child as Record<string, unknown>));
      }
    }
    // Los hijos reales suelen anidarse bajo un nodo intermedio (NestedLoops,
    // Hash Match, etc.) que a su vez contiene más RelOp — buscarlos también
    // dentro de las claves que no sean RelOp/Object directamente.
    for (const key of Object.keys(node)) {
      if (key === "RelOp" || key.startsWith("@_")) continue;
      const val = node[key];
      if (val && typeof val === "object") {
        const nested = (val as Record<string, unknown>)["RelOp"];
        if (nested) {
          const list = Array.isArray(nested) ? nested : [nested];
          for (const child of list) {
            children.push(this.convertRelOp(child as Record<string, unknown>));
          }
        }
      }
    }

    return {
      type: physicalOp,
      detail: detailParts.length > 0 ? detailParts.join(" — ") : undefined,
      cost: estCost,
      rows: estRows,
      expensive,
      children,
    };
  }

  async cancelQuery(): Promise<void> {
    for (const request of this.activeRequests) {
      try {
        request.cancel();
      } catch {
        // La query pudo haber terminado antes de que llegara la cancelación; ignorar.
      }
    }
  }

  async executeBatch({
    schema,
    table,
    pkColumn,
    operations,
  }: BatchEditInput): Promise<{ affectedRows: number }> {
    const pool = await this.ensureConnected();
    const tx = new mssql.Transaction(pool);
    let affectedRows = 0;

    await tx.begin();
    try {
      const tableRef = schema
        ? `${this.quote(schema)}.${this.quote(table)}`
        : this.quote(table);

      for (const op of operations) {
        if (op.type === "update") {
          const entries = Object.entries(op.changes);
          if (entries.length === 0) continue;

          const request = tx.request();
          const setClauses = entries.map(([col], idx) => {
            const paramName = `p${idx}`;
            request.input(paramName, entries[idx][1]);
            return `${this.quote(col)} = @${paramName}`;
          });
          request.input("pkValue", op.pkValue);

          const sql = `UPDATE ${tableRef} SET ${setClauses.join(", ")} WHERE ${this.quote(pkColumn)} = @pkValue`;
          const result = await request.query(sql);
          affectedRows += this.sumAffected(result.rowsAffected);
        } else if (op.type === "insert") {
          const entries = Object.entries(op.values);
          if (entries.length === 0) continue;

          const request = tx.request();
          const columns = entries.map(([col]) => this.quote(col)).join(", ");
          const placeholders = entries
            .map(([, v], idx) => {
              const paramName = `p${idx}`;
              request.input(paramName, v);
              return `@${paramName}`;
            })
            .join(", ");

          const sql = `INSERT INTO ${tableRef} (${columns}) VALUES (${placeholders})`;
          const result = await request.query(sql);
          affectedRows += this.sumAffected(result.rowsAffected);
        } else if (op.type === "delete") {
          const request = tx.request();
          request.input("pkValue", op.pkValue);
          const sql = `DELETE FROM ${tableRef} WHERE ${this.quote(pkColumn)} = @pkValue`;
          const result = await request.query(sql);
          affectedRows += this.sumAffected(result.rowsAffected);
        }
      }

      await tx.commit();
    } catch (err) {
      await tx.rollback().catch(() => undefined);
      throw err;
    }

    return { affectedRows };
  }

  private sumAffected(rowsAffected: number[] | undefined): number {
    return Array.isArray(rowsAffected) ? rowsAffected.reduce((acc, n) => acc + n, 0) : 0;
  }

  async close(): Promise<void> {
    await this.pool.close();
  }

  async getTableDdl(schema: string, table: string): Promise<string> {
    const pool = await this.ensureConnected();

    const objectDefResult = await pool
      .request()
      .input("fullName", mssql.NVarChar, `${schema}.${table}`)
      .query<{ definition: string | null; is_view: number }>(`
        SELECT OBJECT_DEFINITION(OBJECT_ID(@fullName)) AS definition,
               CASE WHEN OBJECTPROPERTY(OBJECT_ID(@fullName), 'IsView') = 1 THEN 1 ELSE 0 END AS is_view
      `);
    const row = objectDefResult.recordset[0];
    if (row?.is_view && row.definition) {
      return row.definition;
    }

    const columnResult = await pool
      .request()
      .input("schema", mssql.NVarChar, schema)
      .input("table", mssql.NVarChar, table)
      .query<{
        column_name: string;
        data_type: string;
        character_maximum_length: number | null;
        numeric_precision: number | null;
        numeric_scale: number | null;
        is_nullable: string;
        column_default: string | null;
      }>(`
        SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type,
               CHARACTER_MAXIMUM_LENGTH AS character_maximum_length,
               NUMERIC_PRECISION AS numeric_precision, NUMERIC_SCALE AS numeric_scale,
               IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table
        ORDER BY ORDINAL_POSITION
      `);

    const pkResult = await pool
      .request()
      .input("schema", mssql.NVarChar, schema)
      .input("table", mssql.NVarChar, table)
      .query<{ column_name: string }>(`
        SELECT kcu.COLUMN_NAME AS column_name
        FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
        JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
          ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
        WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
          AND tc.TABLE_SCHEMA = @schema AND tc.TABLE_NAME = @table
        ORDER BY kcu.ORDINAL_POSITION
      `);
    const pkSet = new Set(pkResult.recordset.map((r) => r.column_name));

    const fkResult = await pool
      .request()
      .input("schema", mssql.NVarChar, schema)
      .input("table", mssql.NVarChar, table)
      .query<{
        constraint_name: string;
        column_name: string;
        foreign_schema_name: string;
        foreign_table_name: string;
        foreign_column_name: string;
      }>(`
        SELECT
          rc.CONSTRAINT_NAME AS constraint_name,
          kcu.COLUMN_NAME AS column_name,
          kcu2.TABLE_SCHEMA AS foreign_schema_name,
          kcu2.TABLE_NAME AS foreign_table_name,
          kcu2.COLUMN_NAME AS foreign_column_name
        FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
        JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
          ON rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA
        JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu2
          ON rc.UNIQUE_CONSTRAINT_NAME = kcu2.CONSTRAINT_NAME
         AND rc.UNIQUE_CONSTRAINT_SCHEMA = kcu2.TABLE_SCHEMA
         AND kcu.ORDINAL_POSITION = kcu2.ORDINAL_POSITION
        WHERE kcu.TABLE_SCHEMA = @schema AND kcu.TABLE_NAME = @table
        ORDER BY rc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
      `);

    const columnLines = columnResult.recordset.map((col) => {
      let typeStr = col.data_type;
      if (col.character_maximum_length) {
        typeStr += `(${col.character_maximum_length === -1 ? "MAX" : col.character_maximum_length})`;
      } else if (col.numeric_precision && /decimal|numeric/i.test(col.data_type)) {
        typeStr += col.numeric_scale
          ? `(${col.numeric_precision},${col.numeric_scale})`
          : `(${col.numeric_precision})`;
      }
      let line = `  ${this.quote(col.column_name)} ${typeStr}`;
      if (col.is_nullable === "NO") line += " NOT NULL";
      if (col.column_default !== null) line += ` DEFAULT ${col.column_default}`;
      return line;
    });

    if (pkSet.size > 0) {
      columnLines.push(`  PRIMARY KEY (${[...pkSet].map((c) => this.quote(c)).join(", ")})`);
    }

    const fkByConstraint = new Map<string, typeof fkResult.recordset[number][]>();
    for (const fk of fkResult.recordset) {
      const list = fkByConstraint.get(fk.constraint_name) ?? [];
      list.push(fk);
      fkByConstraint.set(fk.constraint_name, list);
    }
    for (const [constraintName, fks] of fkByConstraint) {
      const cols = fks.map((f) => this.quote(f.column_name)).join(", ");
      const refSchema = fks[0].foreign_schema_name;
      const refTable = fks[0].foreign_table_name;
      const refCols = fks.map((f) => this.quote(f.foreign_column_name)).join(", ");
      columnLines.push(
        `  CONSTRAINT ${this.quote(constraintName)} FOREIGN KEY (${cols}) REFERENCES ${this.quote(refSchema)}.${this.quote(refTable)} (${refCols})`
      );
    }

    return `CREATE TABLE ${this.quote(schema)}.${this.quote(table)} (\n${columnLines.join(",\n")}\n);`;
  }

  async getRoutineDdl(
    schema: string,
    name: string,
    type: "function" | "procedure"
  ): Promise<string> {
    const pool = await this.ensureConnected();
    const kindCheck = type === "procedure" ? "P, PC" : "FN, IF, TF, FS, FT";
    const result = await pool
      .request()
      .input("schema", mssql.NVarChar, schema)
      .input("name", mssql.NVarChar, name)
      .query<{ definition: string | null }>(`
        SELECT OBJECT_DEFINITION(OBJECT_ID(QUOTENAME(@schema) + '.' + QUOTENAME(@name))) AS definition
        WHERE EXISTS (
          SELECT 1
          FROM sys.objects o
          JOIN sys.schemas s ON s.schema_id = o.schema_id
          WHERE s.name = @schema AND o.name = @name AND o.type IN (${kindCheck})
        )
      `);
    return result.recordset[0]?.definition ?? "";
  }

  async getTriggerDdl(schema: string, name: string): Promise<string> {
    const pool = await this.ensureConnected();
    const result = await pool
      .request()
      .input("schema", mssql.NVarChar, schema)
      .input("name", mssql.NVarChar, name)
      .query<{ definition: string | null }>(`
        SELECT OBJECT_DEFINITION(OBJECT_ID(QUOTENAME(@schema) + '.' + QUOTENAME(@name))) AS definition
        WHERE EXISTS (
          SELECT 1
          FROM sys.triggers t
          JOIN sys.tables tb ON tb.object_id = t.parent_id
          JOIN sys.schemas s ON s.schema_id = tb.schema_id
          WHERE s.name = @schema AND t.name = @name
        )
      `);
    return result.recordset[0]?.definition ?? "";
  }

  private quote(ident: string): string {
    return `[${ident.replace(/\]/g, "]]")}]`;
  }
}
