import { generarTokenIam } from "@/server/auth/rds-iam";
import { sslParaDriver } from "@/server/net/tls-sql";
import { normalizarAuth } from "@/shared/connection-net";
import { Pool, types as pgTypes, type PoolClient, type QueryResult as PgQueryResult } from "pg";
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
import { pgReadOnlyPoolOptions } from "./read-only-session";
import {
  OIDS_TEXTO_CRUDO,
  OIDS_TEXTO_CRUDO_ARRAY,
  oidsDeOrigen,
  origenesPg,
  pgTypeName,
  type FilaDeOrigenPg,
} from "./pg-types";

/**
 * `date`, `time`, `timetz` y `timestamp` (sin zona) se leen como TEXTO CRUDO, sin que `pg` los
 * convierta a `Date`.
 *
 * Medido el 2026-10-11 contra Postgres 16: un `timestamp without time zone` con '2026-01-02
 * 08:00:00' llegaba al renderer como '2026-01-02T15:00:00.000Z' porque `pg` lo interpretaba en la
 * zona del proceso (UTC-7) y `normalizeRow` lo pasaba por `toISOString()`. La app enseñaba una hora
 * que no es la que hay en la base. Son valores de reloj de pared: no tienen instante, así que
 * convertirlos obliga a inventar una zona.
 *
 * `timestamptz` (OID 1184) se queda como está: ahí el instante es real y normalizarlo a UTC no
 * pierde nada.
 *
 * Se hace una sola vez por proceso (el db-worker), no por conexión: `pg` guarda los parseadores en
 * un registro global del módulo.
 */
let parseadoresListos = false;
function configurarParseadoresDeFecha() {
  if (parseadoresListos) return;
  parseadoresListos = true;
  const tal_cual = (valor: string) => valor;
  // Los tipos de `pg` declaran `setTypeParser(oid: TypeId, ...)` con una unión cerrada de OIDs
  // "conocidos" que no incluye los de arrays de fecha; en ejecución acepta cualquier número. El
  // cast es a esa firma, no a `any`, para que un error de nombre siga saltando.
  const ponerParseador = pgTypes.setTypeParser as (oid: number, parse: (v: string) => string) => void;
  for (const oid of OIDS_TEXTO_CRUDO) ponerParseador(oid, tal_cual);
  for (const oid of OIDS_TEXTO_CRUDO_ARRAY) ponerParseador(oid, tal_cual);
}

export class PostgresDriver implements DatabaseDriver {
  private pool: Pool;
  private config: ConnectionProfile;
  private activeQueries = new Set<{ processID: number; secretKey: number }>();

  constructor(config: ConnectionProfile) {
    configurarParseadoresDeFecha();
    this.config = config;
    this.pool = new Pool({
      host: config.host,
      port: config.port || 5432,
      user: config.user,
      password: normalizarAuth(config.auth) ? () => generarTokenIam(config) : config.password,
      database: config.database,
      ssl: sslParaDriver(config.tls, config.auth),
      max: 5,
      connectionTimeoutMillis: 8000,
      // R53: en perfiles de solo lectura la propia base rechaza escrituras (ver read-only-session.ts).
      ...pgReadOnlyPoolOptions(config),
    });
  }

  async testConnection(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async listDatabases(): Promise<string[]> {
    const { rows } = await this.pool.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname`
    );
    return rows.map((r) => r.datname);
  }

  async getSchema(): Promise<SchemaNode[]> {
    const schemaQuery = `
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
        AND schema_name NOT LIKE 'pg_temp_%'
        AND schema_name NOT LIKE 'pg_toast_temp_%'
      ORDER BY schema_name
    `;
    const { rows: schemaRows } = await this.pool.query<{ schema_name: string }>(
      schemaQuery
    );

    const schemas: SchemaNode[] = [];

    for (const { schema_name: schemaName } of schemaRows) {
      const { rows: tableRows } = await this.pool.query<{
        table_name: string;
        table_type: string;
      }>(
        `
        SELECT table_name, table_type
        FROM information_schema.tables
        WHERE table_schema = $1
        ORDER BY table_name
        `,
        [schemaName]
      );

      const tables: TableMeta[] = [];

      for (const { table_name: tableName, table_type: tableType } of tableRows) {
        const type = tableType === "VIEW" ? "view" : "table";

        const { rows: columnRows } = await this.pool.query<{
          column_name: string;
          data_type: string;
          is_nullable: string;
        }>(
          `
          SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position
          `,
          [schemaName, tableName]
        );

        const { rows: pkRows } = await this.pool.query<{
          column_name: string;
        }>(
          `
          SELECT kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
          WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_schema = $1
            AND tc.table_name = $2
          ORDER BY kcu.ordinal_position
          `,
          [schemaName, tableName]
        );
        const pkSet = new Set(pkRows.map((r) => r.column_name));

        const { rows: fkRows } = await this.pool.query<{
          column_name: string;
          foreign_schema_name: string;
          foreign_table_name: string;
          foreign_column_name: string;
        }>(
          `
          SELECT
            a.attname AS column_name,
            ns.nspname AS foreign_schema_name,
            ft.relname AS foreign_table_name,
            fa.attname AS foreign_column_name
          FROM pg_catalog.pg_constraint c
          JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
          JOIN pg_catalog.pg_class ft ON ft.oid = c.confrelid
          JOIN pg_catalog.pg_namespace ns ON ns.oid = ft.relnamespace
          JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS ck(attnum, ord) ON true
          JOIN pg_catalog.pg_attribute a
            ON a.attrelid = t.oid AND a.attnum = ck.attnum
          JOIN LATERAL unnest(c.confkey) WITH ORDINALITY AS fck(attnum, ord) ON fck.ord = ck.ord
          JOIN pg_catalog.pg_attribute fa
            ON fa.attrelid = ft.oid AND fa.attnum = fck.attnum
          WHERE c.contype = 'f'
            AND n.nspname = $1
            AND t.relname = $2
          ORDER BY ck.ord
          `,
          [schemaName, tableName]
        );

        const fkMap = new Map<string, ForeignKeyRef>();
        for (const fk of fkRows) {
          fkMap.set(fk.column_name, {
            schema: fk.foreign_schema_name,
            table: fk.foreign_table_name,
            column: fk.foreign_column_name,
          });
        }

        const columns: ColumnMeta[] = columnRows.map((col) => ({
          name: col.column_name,
          type: col.data_type,
          isPrimaryKey: pkSet.has(col.column_name),
          nullable: col.is_nullable === "YES",
          fk: fkMap.get(col.column_name),
        }));

        tables.push({
          name: tableName,
          type,
          columns,
        });
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
    const { rows } = await this.pool.query<{
      routine_name: string;
      routine_type: string;
      external_language: string | null;
    }>(
      `
      SELECT routine_name, routine_type, external_language
      FROM information_schema.routines
      WHERE routine_schema = $1
        AND routine_type IN ('FUNCTION', 'PROCEDURE')
      ORDER BY routine_name
      `,
      [schemaName]
    );
    return rows.map((r) => ({
      name: r.routine_name,
      type: r.routine_type === "PROCEDURE" ? "procedure" : "function",
      language: r.external_language ?? undefined,
    }));
  }

  private async fetchTriggers(schemaName: string): Promise<TriggerMeta[]> {
    const { rows } = await this.pool.query<{
      trigger_name: string;
      event_object_table: string;
      action_timing: string;
      event_manipulation: string;
    }>(
      `
      SELECT trigger_name, event_object_table, action_timing, event_manipulation
      FROM information_schema.triggers
      WHERE trigger_schema = $1
      ORDER BY trigger_name
      `,
      [schemaName]
    );
    return rows.map((r) => ({
      name: r.trigger_name,
      targetTable: r.event_object_table,
      timing: r.action_timing,
      event: r.event_manipulation,
    }));
  }

  async getRoutineDdl(
    schema: string,
    name: string,
    type: "function" | "procedure"
  ): Promise<string> {
    const expectedKind = type === "procedure" ? "p" : "f";
    const { rows } = await this.pool.query<{ ddl: string }>(
      `
      SELECT pg_get_functiondef(p.oid) AS ddl
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind = $3
      LIMIT 1
      `,
      [schema, name, expectedKind]
    );
    return rows[0]?.ddl ?? "";
  }

  async getTriggerDdl(schema: string, name: string): Promise<string> {
    const { rows } = await this.pool.query<{ ddl: string }>(
      `
      SELECT pg_get_triggerdef(t.oid) AS ddl
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND t.tgname = $2
      LIMIT 1
      `,
      [schema, name]
    );
    return rows[0]?.ddl ?? "";
  }

  /**
   * R94 — resuelve `(tableID, columnID)` de cada campo del resultado a `esquema.tabla.columna`.
   *
   * Una sola consulta a `pg_attribute` por resultado, y solo si hay algún campo que venga de una
   * tabla. Dentro de una transacción manual NO se usa su cliente (`conexion` llega vacía): si la
   * transacción está abortada, cualquier consulta en ella falla, y el usuario no tiene por qué
   * ver un error del catálogo por eso. Un fallo aquí NO tumba el resultado: se registra y las
   * columnas se quedan sin origen (solo lectura), que es degradar, no romper.
   */
  private async resolverOrigenes(
    campos: ReadonlyArray<{ tableID: number; columnID: number }>,
    conexion?: PoolClient
  ): Promise<Array<{ schema: string; table: string; column: string } | undefined>> {
    const oids = oidsDeOrigen(campos);
    if (oids.length === 0) return campos.map(() => undefined);
    try {
      const consulta = `
        SELECT c.oid::int AS oid, a.attnum::int AS attnum, n.nspname AS esquema,
               c.relname AS tabla, a.attname AS columna
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped`;
      const { rows } = conexion
        ? await conexion.query<FilaDeOrigenPg>(consulta, [oids])
        : await this.pool.query<FilaDeOrigenPg>(consulta, [oids]);
      return origenesPg(campos, rows);
    } catch (error) {
      console.error("[postgres] no se pudo resolver el origen de las columnas", error);
      return campos.map(() => undefined);
    }
  }

  async executeQuery(sql: string, tx?: unknown): Promise<QueryResult> {
    const start = Date.now();
    const txClient = tx as PoolClient | undefined;
    const client = txClient ?? (await this.pool.connect());
    // Solo trackeamos para cancelación las conexiones propias (no las de
    // transacción, que el usuario controla explícitamente con Commit/Rollback).
    const processID = !txClient
      ? (client as unknown as { processID?: number }).processID
      : undefined;
    const marker = processID !== undefined ? { processID, secretKey: 0 } : null;
    if (marker) this.activeQueries.add(marker);

    try {
      const result = await client.query(sql);
      const durationMs = Date.now() - start;

      let last: PgQueryResult<Record<string, unknown>> | undefined;
      if (Array.isArray(result)) {
        for (let i = result.length - 1; i >= 0; i--) {
          const r = result[i];
          if (r && typeof r === "object" && "fields" in r && r.fields !== undefined) {
            last = r as PgQueryResult<Record<string, unknown>>;
            break;
          }
        }
      } else {
        last = result as PgQueryResult<Record<string, unknown>>;
      }

      if (last && last.fields && last.fields.length > 0) {
        // `pg` solo da el OID del tipo; se traduce al nombre para que `QueryColumn.type` sea
        // utilizable (antes valía "1184" y `getColumnKind()` lo clasificaba como texto).
        //
        // `origen` (R94): `tableID`/`columnID` dicen de qué columna de qué tabla sale cada una (0 en
        // una expresión); se resuelven contra el catálogo para que la rejilla pueda editar un
        // resultado con JOIN o con alias, como DataGrip.
        const origenes = await this.resolverOrigenes(last.fields, txClient ? undefined : client);
        const columns: QueryColumn[] = last.fields.map((f, i) => {
          const origen = origenes[i];
          return origen
            ? { name: f.name, type: pgTypeName(f.dataTypeID), origen }
            : { name: f.name, type: pgTypeName(f.dataTypeID) };
        });
        const rows = last.rows.map((row) => this.normalizeRow(row, columns));
        return {
          columns,
          rows,
          rowCount: rows.length,
          durationMs,
          limitApplied: false,
          effectiveLimit: DEFAULT_LIMIT,
        };
      }

      // DML/DDL without fields
      const single = Array.isArray(result) ? result[result.length - 1] : result;
      const affectedRows =
        single && typeof single === "object" && "rowCount" in single
          ? (single.rowCount ?? 0)
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
      if (marker) this.activeQueries.delete(marker);
      // Si la query vino de una transacción manual, el cliente lo libera
      // quien hizo commit/rollback, no aquí.
      if (!txClient) client.release();
    }
  }

  async beginTransaction(): Promise<unknown> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      return client;
    } catch (err) {
      client.release();
      throw err;
    }
  }

  async commitTransaction(tx: unknown): Promise<void> {
    const client = tx as PoolClient;
    try {
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  }

  async rollbackTransaction(tx: unknown): Promise<void> {
    const client = tx as PoolClient;
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }

  async explainQuery(sql: string): Promise<ExplainNode> {
    const cleaned = sql.trim().replace(/;+\s*$/, "");
    const { rows } = await this.pool.query<{ "QUERY PLAN": unknown }>(
      `EXPLAIN (FORMAT JSON) ${cleaned}`
    );
    const raw = rows[0]?.["QUERY PLAN"];
    const planRoot = Array.isArray(raw) ? raw[0] : raw;
    const plan = planRoot && typeof planRoot === "object" ? (planRoot as Record<string, unknown>).Plan : undefined;

    if (!plan || typeof plan !== "object") {
      return { type: "unknown", detail: "No se pudo obtener el plan", children: [] };
    }

    return this.convertPgPlanNode(plan as Record<string, unknown>);
  }

  private convertPgPlanNode(node: Record<string, unknown>): ExplainNode {
    const nodeType = String(node["Node Type"] ?? "unknown");
    const relation = node["Relation Name"] ? String(node["Relation Name"]) : undefined;
    const index = node["Index Name"] ? String(node["Index Name"]) : undefined;
    const cond = node["Index Cond"] ?? node["Filter"] ?? node["Hash Cond"] ?? node["Join Filter"];
    const totalCost = typeof node["Total Cost"] === "number" ? (node["Total Cost"] as number) : undefined;
    const planRows = typeof node["Plan Rows"] === "number" ? (node["Plan Rows"] as number) : undefined;

    const detailParts: string[] = [];
    if (relation) detailParts.push(`en ${relation}`);
    if (index) detailParts.push(`usando índice ${index}`);
    if (cond) detailParts.push(String(cond));

    // Marcamos como costoso un Seq Scan sobre una tabla con estimación
    // relevante de filas: es el patrón clásico de "falta un índice".
    const expensive =
      (nodeType === "Seq Scan" && (planRows ?? 0) > 1000) ||
      (totalCost !== undefined && totalCost > 10000);

    const childPlans = Array.isArray(node["Plans"]) ? (node["Plans"] as Record<string, unknown>[]) : [];

    return {
      type: nodeType,
      detail: detailParts.length > 0 ? detailParts.join(" — ") : undefined,
      cost: totalCost,
      rows: planRows,
      expensive,
      children: childPlans.map((child) => this.convertPgPlanNode(child)),
    };
  }

  async cancelQuery(): Promise<void> {
    const pids = [...this.activeQueries].map((m) => m.processID);
    for (const pid of pids) {
      try {
        await this.pool.query("SELECT pg_cancel_backend($1)", [pid]);
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
    const client = await this.pool.connect();
    let affectedRows = 0;

    try {
      await client.query("BEGIN");

      for (const op of operations) {
        if (op.type === "update") {
          const entries = Object.entries(op.changes);
          if (entries.length === 0) continue;

          const setClauses = entries.map(
            ([col], idx) => `${this.quote(col)} = $${idx + 1}`
          );
          const values = entries.map(([, v]) => v);
          const pkPlaceholder = `$${values.length + 1}`;

          const tableRef = schema
            ? `${this.quote(schema)}.${this.quote(table)}`
            : this.quote(table);

          const sql = `UPDATE ${tableRef} SET ${setClauses.join(", ")} WHERE ${this.quote(pkColumn)} = ${pkPlaceholder}`;
          const res = await client.query(sql, [...values, op.pkValue]);
          affectedRows += res.rowCount ?? 0;
        } else if (op.type === "insert") {
          const entries = Object.entries(op.values);
          if (entries.length === 0) continue;

          const columns = entries.map(([col]) => this.quote(col)).join(", ");
          const placeholders = entries
            .map((_, idx) => `$${idx + 1}`)
            .join(", ");
          const values = entries.map(([, v]) => v);

          const tableRef = schema
            ? `${this.quote(schema)}.${this.quote(table)}`
            : this.quote(table);

          const sql = `INSERT INTO ${tableRef} (${columns}) VALUES (${placeholders})`;
          const res = await client.query(sql, values);
          affectedRows += res.rowCount ?? 0;
        } else if (op.type === "delete") {
          const tableRef = schema
            ? `${this.quote(schema)}.${this.quote(table)}`
            : this.quote(table);

          const sql = `DELETE FROM ${tableRef} WHERE ${this.quote(pkColumn)} = $1`;
          const res = await client.query(sql, [op.pkValue]);
          affectedRows += res.rowCount ?? 0;
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    return { affectedRows };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async getTableDdl(schema: string, table: string): Promise<string> {
    const { rows: kindRows } = await this.pool.query<{ relkind: string }>(
      `
      SELECT c.relkind
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2
      `,
      [schema, table]
    );
    const relkind = kindRows[0]?.relkind;

    if (relkind === "v" || relkind === "m") {
      const { rows } = await this.pool.query<{ definition: string }>(
        `SELECT pg_get_viewdef(format('%I.%I', $1::text, $2::text)::regclass, true) AS definition`,
        [schema, table]
      );
      const def = rows[0]?.definition ?? "";
      return `CREATE ${relkind === "m" ? "MATERIALIZED VIEW" : "VIEW"} ${this.quote(schema)}.${this.quote(table)} AS\n${def}`;
    }

    const { rows: columnRows } = await this.pool.query<{
      column_name: string;
      data_type: string;
      character_maximum_length: number | null;
      numeric_precision: number | null;
      numeric_scale: number | null;
      is_nullable: string;
      column_default: string | null;
    }>(
      `
      SELECT column_name, data_type, character_maximum_length,
             numeric_precision, numeric_scale, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
      `,
      [schema, table]
    );

    const { rows: pkRows } = await this.pool.query<{ column_name: string }>(
      `
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = $1 AND tc.table_name = $2
      ORDER BY kcu.ordinal_position
      `,
      [schema, table]
    );

    const { rows: fkRows } = await this.pool.query<{
      constraint_name: string;
      column_name: string;
      foreign_schema_name: string;
      foreign_table_name: string;
      foreign_column_name: string;
    }>(
      `
      SELECT
        c.conname AS constraint_name,
        a.attname AS column_name,
        ns.nspname AS foreign_schema_name,
        ft.relname AS foreign_table_name,
        fa.attname AS foreign_column_name
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_catalog.pg_class ft ON ft.oid = c.confrelid
      JOIN pg_catalog.pg_namespace ns ON ns.oid = ft.relnamespace
      JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS ck(attnum, ord) ON true
      JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = ck.attnum
      JOIN LATERAL unnest(c.confkey) WITH ORDINALITY AS fck(attnum, ord) ON fck.ord = ck.ord
      JOIN pg_catalog.pg_attribute fa ON fa.attrelid = ft.oid AND fa.attnum = fck.attnum
      WHERE c.contype = 'f' AND n.nspname = $1 AND t.relname = $2
      ORDER BY c.conname, ck.ord
      `,
      [schema, table]
    );

    const pkSet = new Set(pkRows.map((r) => r.column_name));

    const columnLines = columnRows.map((col) => {
      let typeStr = col.data_type;
      if (col.character_maximum_length) {
        typeStr += `(${col.character_maximum_length})`;
      } else if (col.numeric_precision && col.data_type === "numeric") {
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
      columnLines.push(
        `  PRIMARY KEY (${[...pkSet].map((c) => this.quote(c)).join(", ")})`
      );
    }

    const fkByConstraint = new Map<string, typeof fkRows>();
    for (const fk of fkRows) {
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

  private quote(ident: string): string {
    return `"${ident.replace(/"/g, '""')}"`;
  }

  private normalizeRow(
    row: Record<string, unknown>,
    columns: QueryColumn[]
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const col of columns) {
      const value = row[col.name];
      if (isDateLike(value)) {
        out[col.name] = safeIsoString(value);
      } else if (Buffer.isBuffer(value)) {
        out[col.name] = `\\x${value.toString("hex")}`;
      } else {
        out[col.name] = value;
      }
    }
    return out;
  }
}
