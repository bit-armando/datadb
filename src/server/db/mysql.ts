import { generarTokenIam } from "@/server/auth/rds-iam";
import { sslParaDriver } from "@/server/net/tls-sql";
import { normalizarAuth } from "@/shared/connection-net";
import mysql, {
  type FieldPacket,
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
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
import { isDateLike, safeIsoString } from "./date-utils";
import { mysqlTipoDeCampo, origenMysql } from "./mysql-types";
import { MYSQL_READ_ONLY_SQL } from "./read-only-session";

export class MysqlDriver implements DatabaseDriver {
  private pool: Pool;
  private config: ConnectionProfile;
  private activeThreadIds = new Set<number>();

  constructor(config: ConnectionProfile) {
    this.config = config;
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port || 3306,
      user: config.user,
      password: config.password,
      ...(normalizarAuth(config.auth)
        ? {
            // Aurora responde con un auth switch a mysql_clear_password; el token va ahí, firmado al momento.
            authPlugins: {
              mysql_clear_password: () => async () => Buffer.from(`${await generarTokenIam(config)}\0`),
            },
          }
        : {}),
      database: config.database,
      ssl: sslParaDriver(config.tls, config.auth),
      connectionLimit: 5,
      connectTimeout: 8000,
      // DATE, DATETIME y TIMESTAMP llegan como TEXTO, tal cual los tiene el servidor, en vez de
      // como objetos `Date`. Mismo motivo que en Postgres (ver `pg-types.ts`): DATE y DATETIME son
      // valores de reloj de pared, sin instante asociado, y convertirlos a `Date` obliga a
      // interpretarlos en la zona del proceso — en América/Ciudad Juárez eso movía la hora que veía
      // el usuario respecto a la que hay en la base.
      dateStrings: true,
    });
    if (config.readOnly) {
      // R53: cada conexión nueva del pool queda en solo lectura (ver read-only-session.ts). El evento llega antes de
      // que el pool entregue la conexión y los comandos de una conexión se ejecutan en orden, así que el SET va
      // delante de la primera consulta del usuario. Si el SET falla se DESTRUYE la conexión: es preferible que la
      // consulta falle a que corra sin la protección que el perfil promete (fail-closed).
      this.pool.pool.on("connection", (conn) => {
        conn.query(MYSQL_READ_ONLY_SQL, (err) => {
          if (!err) return;
          console.error("[mysql] No se pudo activar el solo lectura de la sesión; se cierra la conexión", err);
          conn.destroy();
        });
      });
    }
  }

  async testConnection(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async listDatabases(): Promise<string[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>("SHOW DATABASES");
    return rows.map((r) => String(Object.values(r)[0]));
  }

  async getSchema(): Promise<SchemaNode[]> {
    const schemaName = this.config.database;

    const [tableRows] = await this.pool.query<RowDataPacket[]>(
      `
      SELECT TABLE_NAME, TABLE_TYPE
      FROM information_schema.tables
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME
      `,
      [schemaName]
    );

    const tables: TableMeta[] = [];

    for (const rawTable of tableRows) {
      const tableName = String(rawTable.TABLE_NAME);
      const tableType = String(rawTable.TABLE_TYPE);
      const type = tableType === "VIEW" ? "view" : "table";

      const [columnRows] = await this.pool.query<RowDataPacket[]>(
        `
        SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_KEY
        FROM information_schema.columns
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION
        `,
        [schemaName, tableName]
      );

      const [fkRows] = await this.pool.query<RowDataPacket[]>(
        `
        SELECT COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY ORDINAL_POSITION
        `,
        [schemaName, tableName]
      );

      const fkMap = new Map<string, ForeignKeyRef>();
      for (const fk of fkRows) {
        fkMap.set(String(fk.COLUMN_NAME), {
          schema: String(fk.REFERENCED_TABLE_SCHEMA),
          table: String(fk.REFERENCED_TABLE_NAME),
          column: String(fk.REFERENCED_COLUMN_NAME),
        });
      }

      const columns: ColumnMeta[] = columnRows.map((col) => ({
        name: String(col.COLUMN_NAME),
        type: String(col.DATA_TYPE),
        isPrimaryKey: col.COLUMN_KEY === "PRI",
        nullable: col.IS_NULLABLE === "YES",
        fk: fkMap.get(String(col.COLUMN_NAME)),
      }));

      tables.push({
        name: tableName,
        type,
        columns,
      });
    }

    return [
      {
        name: schemaName,
        tables,
        routines: await this.fetchRoutines(schemaName),
        triggers: await this.fetchTriggers(schemaName),
      },
    ];
  }

  private async fetchRoutines(schemaName: string): Promise<RoutineMeta[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `
      SELECT routine_name, routine_type
      FROM information_schema.routines
      WHERE routine_schema = ?
        AND routine_type IN ('FUNCTION', 'PROCEDURE')
      ORDER BY routine_name
      `,
      [schemaName]
    );
    return rows.map((r) => ({
      name: String(r.ROUTINE_NAME ?? r.routine_name),
      type: String(r.ROUTINE_TYPE ?? r.routine_type) === "PROCEDURE" ? "procedure" : "function",
    }));
  }

  private async fetchTriggers(schemaName: string): Promise<TriggerMeta[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `
      SELECT trigger_name, event_object_table, action_timing, event_manipulation
      FROM information_schema.triggers
      WHERE trigger_schema = ?
      ORDER BY trigger_name
      `,
      [schemaName]
    );
    return rows.map((r) => ({
      name: String(r.TRIGGER_NAME ?? r.trigger_name),
      targetTable: String(r.EVENT_OBJECT_TABLE ?? r.event_object_table),
      timing: String(r.ACTION_TIMING ?? r.action_timing),
      event: String(r.EVENT_MANIPULATION ?? r.event_manipulation),
    }));
  }

  async executeQuery(sql: string, tx?: unknown): Promise<QueryResult> {
    const start = Date.now();
    const txConn = tx as PoolConnection | undefined;
    const conn = txConn ?? (await this.pool.getConnection());
    // Solo trackeamos para cancelación las conexiones propias (no las de
    // transacción, que el usuario controla explícitamente con Commit/Rollback).
    const threadId = !txConn ? conn.threadId : null;
    if (threadId !== null) this.activeThreadIds.add(threadId);

    try {
      const [rows, fields] = await conn.query(sql);
      const durationMs = Date.now() - start;

      if (Array.isArray(fields) && fields.length > 0) {
        // `mysql2` da el tipo como número del protocolo; se traduce al mismo nombre que usa
        // `information_schema` para que la rejilla clasifique igual venga del resultado o del
        // esquema (antes valía "12" y `getColumnKind()` lo trataba como texto).
        //
        // `origen` (R94): el paquete de campo trae la tabla y la columna REALES (`orgTable`,
        // `orgName`, sin alias) y la base (`db`). Con eso la rejilla puede editar un resultado con
        // JOIN o con alias, como DataGrip. En una expresión (`count(*)`, `concat(…)`) MySQL deja
        // `orgTable` vacío, y entonces no hay origen: esa columna es de solo lectura.
        const columns: QueryColumn[] = (fields as FieldPacket[]).map((f) => ({
          name: String(f.name ?? ""),
          // R98: con el ancho, para que `TINYINT(1)`/`BIT(1)` lleguen como booleanos (casilla).
          type: mysqlTipoDeCampo(f),
          ...origenMysql(f),
        }));

        const resultRows = Array.isArray(rows)
          ? (rows as RowDataPacket[])
          : [];

        return {
          columns,
          rows: resultRows.map((row) => this.normalizeRow(row, columns)),
          rowCount: resultRows.length,
          durationMs,
          limitApplied: false,
          effectiveLimit: DEFAULT_LIMIT,
        };
      }

      const header = rows as ResultSetHeader;
      const affectedRows =
        header && typeof header === "object" && "affectedRows" in header
          ? header.affectedRows
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
      if (threadId !== null) this.activeThreadIds.delete(threadId);
      // Si la query vino de una transacción manual, el cliente lo libera
      // quien hizo commit/rollback, no aquí.
      if (!txConn) conn.release();
    }
  }

  async beginTransaction(): Promise<unknown> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      return conn;
    } catch (err) {
      conn.release();
      throw err;
    }
  }

  async commitTransaction(tx: unknown): Promise<void> {
    const conn = tx as PoolConnection;
    try {
      await conn.commit();
    } finally {
      conn.release();
    }
  }

  async rollbackTransaction(tx: unknown): Promise<void> {
    const conn = tx as PoolConnection;
    try {
      await conn.rollback();
    } finally {
      conn.release();
    }
  }

  async explainQuery(sql: string): Promise<ExplainNode> {
    const cleaned = sql.trim().replace(/;+\s*$/, "");
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `EXPLAIN FORMAT=JSON ${cleaned}`
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    const raw = row?.EXPLAIN;
    if (!raw) {
      return { type: "unknown", detail: "No se pudo obtener el plan", children: [] };
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return { type: "unknown", detail: "No se pudo interpretar el plan", children: [] };
    }

    const queryBlock = parsed.query_block as Record<string, unknown> | undefined;
    if (!queryBlock) {
      return { type: "unknown", detail: "No se pudo interpretar el plan", children: [] };
    }

    const queryCost = this.extractMysqlCost(queryBlock.cost_info);
    return {
      type: "query_block",
      cost: queryCost,
      children: this.convertMysqlQueryBlockChildren(queryBlock),
    };
  }

  private extractMysqlCost(costInfo: unknown): number | undefined {
    if (!costInfo || typeof costInfo !== "object") return undefined;
    const raw = (costInfo as Record<string, unknown>).query_cost;
    const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : undefined;
    return n !== undefined && !Number.isNaN(n) ? n : undefined;
  }

  /**
   * El JSON de MySQL anida el plan bajo claves variables según la forma de
   * la query ("table", "nested_loop", "ordering_operation",
   * "grouping_operation", "union_result", etc). Recorremos todas las claves
   * de un objeto plan buscando nodos reconocibles en vez de asumir un shape
   * fijo, y devolvemos la lista de hijos encontrados en ese nivel.
   */
  private convertMysqlQueryBlockChildren(
    node: Record<string, unknown>
  ): ExplainNode[] {
    const children: ExplainNode[] = [];

    if (node.table && typeof node.table === "object") {
      children.push(this.convertMysqlTableNode(node.table as Record<string, unknown>));
    }

    if (Array.isArray(node.nested_loop)) {
      for (const entry of node.nested_loop as Record<string, unknown>[]) {
        children.push(...this.convertMysqlQueryBlockChildren(entry));
      }
    }

    for (const key of [
      "ordering_operation",
      "grouping_operation",
      "duplicates_removal",
      "materialized_from_subquery",
    ]) {
      const child = node[key];
      if (child && typeof child === "object") {
        const inner = this.convertMysqlQueryBlockChildren(child as Record<string, unknown>);
        children.push({
          type: key,
          children: inner,
        });
      }
    }

    if (Array.isArray(node.query_specifications)) {
      for (const spec of node.query_specifications as Record<string, unknown>[]) {
        const qb = spec.query_block as Record<string, unknown> | undefined;
        if (qb) {
          children.push({
            type: "query_specification",
            cost: this.extractMysqlCost(qb.cost_info),
            children: this.convertMysqlQueryBlockChildren(qb),
          });
        }
      }
    }

    return children;
  }

  private convertMysqlTableNode(table: Record<string, unknown>): ExplainNode {
    const tableName = table.table_name ? String(table.table_name) : undefined;
    const accessType = table.access_type ? String(table.access_type) : "table";
    const key = table.key ? String(table.key) : undefined;
    const rowsExamined =
      typeof table.rows_examined_per_scan === "number" ? table.rows_examined_per_scan : undefined;
    const attachedCondition = table.attached_condition ? String(table.attached_condition) : undefined;
    const cost = this.extractMysqlCost(table.cost_info);

    const detailParts: string[] = [];
    if (tableName) detailParts.push(`en ${tableName}`);
    if (key) detailParts.push(`usando índice ${key}`);
    else if (accessType === "ALL") detailParts.push("sin índice (full scan)");
    if (attachedCondition) detailParts.push(attachedCondition);

    // ALL = full table scan sin usar índice, el equivalente MySQL del
    // Seq Scan de Postgres: el patrón clásico de "falta un índice".
    const expensive = accessType === "ALL" && (rowsExamined ?? 0) > 1000;

    return {
      type: accessType,
      detail: detailParts.length > 0 ? detailParts.join(" — ") : undefined,
      cost,
      rows: rowsExamined,
      expensive,
      children: [],
    };
  }

  async cancelQuery(): Promise<void> {
    const ids = [...this.activeThreadIds];
    for (const threadId of ids) {
      try {
        await this.pool.query(`KILL QUERY ${threadId}`);
      } catch {
        // La query pudo haber terminado antes de que llegara el KILL; ignorar.
      }
    }
  }

  async executeBatch({
    schema,
    table,
    pkColumn,
    operations,
  }: BatchEditInput): Promise<{ affectedRows: number }> {
    const conn = await this.pool.getConnection();
    let affectedRows = 0;

    try {
      await conn.beginTransaction();

      for (const op of operations) {
        if (op.type === "update") {
          const entries = Object.entries(op.changes);
          if (entries.length === 0) continue;

          const setClauses = entries.map(([col]) => `${this.quote(col)} = ?`);
          const values = entries.map(([, v]) => v);

          const tableRef = schema
            ? `${this.quote(schema)}.${this.quote(table)}`
            : this.quote(table);

          const sql = `UPDATE ${tableRef} SET ${setClauses.join(", ")} WHERE ${this.quote(pkColumn)} = ?`;
          const [res] = await conn.query(sql, [...values, op.pkValue]);
          affectedRows += this.extractAffectedRows(res);
        } else if (op.type === "insert") {
          const entries = Object.entries(op.values);
          if (entries.length === 0) continue;

          const columns = entries.map(([col]) => this.quote(col)).join(", ");
          const placeholders = entries.map(() => "?").join(", ");
          const values = entries.map(([, v]) => v);

          const tableRef = schema
            ? `${this.quote(schema)}.${this.quote(table)}`
            : this.quote(table);

          const sql = `INSERT INTO ${tableRef} (${columns}) VALUES (${placeholders})`;
          const [res] = await conn.query(sql, values);
          affectedRows += this.extractAffectedRows(res);
        } else if (op.type === "delete") {
          const tableRef = schema
            ? `${this.quote(schema)}.${this.quote(table)}`
            : this.quote(table);

          const sql = `DELETE FROM ${tableRef} WHERE ${this.quote(pkColumn)} = ?`;
          const [res] = await conn.query(sql, [op.pkValue]);
          affectedRows += this.extractAffectedRows(res);
        }
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => undefined);
      throw err;
    } finally {
      conn.release();
    }

    return { affectedRows };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async getTableDdl(schema: string, table: string): Promise<string> {
    const tableRef = schema ? `${this.quote(schema)}.${this.quote(table)}` : this.quote(table);
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SHOW CREATE TABLE ${tableRef}`
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return "";
    return String(row["Create Table"] ?? row["Create View"] ?? "");
  }

  async getRoutineDdl(
    _schema: string,
    name: string,
    type: "function" | "procedure"
  ): Promise<string> {
    const kind = type === "procedure" ? "PROCEDURE" : "FUNCTION";
    try {
      const [rows] = await this.pool.query<RowDataPacket[]>(
        `SHOW CREATE ${kind} ${this.quote(name)}`
      );
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) return "";
      return String(row[`Create ${kind.charAt(0) + kind.slice(1).toLowerCase()}`] ?? "");
    } catch {
      return "";
    }
  }

  async getTriggerDdl(_schema: string, name: string): Promise<string> {
    try {
      const [rows] = await this.pool.query<RowDataPacket[]>(
        `SHOW CREATE TRIGGER ${this.quote(name)}`
      );
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) return "";
      return String(row["Create Trigger"] ?? "");
    } catch {
      return "";
    }
  }

  private quote(ident: string): string {
    return `\`${ident.replace(/`/g, "``")}\``;
  }

  private extractAffectedRows(res: unknown): number {
    if (res && typeof res === "object" && "affectedRows" in res) {
      return (res as ResultSetHeader).affectedRows ?? 0;
    }
    return 0;
  }

  private normalizeRow(
    row: RowDataPacket,
    columns: QueryColumn[]
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const col of columns) {
      const value = row[col.name];
      if (isDateLike(value)) {
        out[col.name] = safeIsoString(value);
      } else if (Buffer.isBuffer(value)) {
        out[col.name] = value.toString("hex");
      } else {
        out[col.name] = value;
      }
    }
    return out;
  }
}
