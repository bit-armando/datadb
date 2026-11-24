import { cellText } from "./cell-value";
import { columnKey } from "./query-columns";
import { quoteIdentifier, type SqlDialect } from "./quote";
import type { QueryResult } from "./types";

export type ExportFormat =
  | "csv"
  | "json"
  | "markdown"
  | "pretty"
  | "sql"
  | "sql-update"
  | "sql-delete"
  | "pandas";

export interface ExportOptions {
  tableName?: string;
  /** Columna(s) clave primaria, requeridas para generar UPDATE/DELETE por fila. */
  pkColumns?: string[];
  /**
   * Dialecto SQL del destino (fase 14, D4).
   *
   * Decide cómo se entrecomillan los identificadores y los literales:
   *
   *   - `postgres`  → `"tabla"`, booleanos `TRUE`/`FALSE`;
   *   - `mysql`     → `` `tabla` `` (lo que este archivo hacía SIEMPRE, y por eso es el valor por
   *     defecto: un llamador que no lo pase sigue obteniendo exactamente el texto de antes);
   *   - `sqlserver` → `[tabla]` y booleanos `1`/`0` (T-SQL no tiene literales `TRUE`/`FALSE`).
   *
   * El bug que esto arregla, medido en la línea base: el INSERT/UPDATE/DELETE exportado salía con
   * comillas invertidas contra cualquier motor, así que contra Postgres o SQL Server **no
   * ejecutaba**. Se pide con `session.type`, que ya es exactamente este union.
   */
  dialecto?: SqlDialect;
  /**
   * Esquema de la tabla (fase 14, T4).
   *
   * Se entrecomilla POR SEPARADO de la tabla (`"public"."clientes"`, `` `public`.`clientes` ``,
   * `[public].[clientes]`): el nombre cualificado son DOS identificadores y cada uno necesita su
   * cierre propio. Un solo identificador `"public.clientes"` no existe en ningún motor.
   *
   * Si `tableName` ya viene cualificado (`ventas.clientes` — lo que enseña el campo «Tabla» del
   * exportador cuando la rejilla viene de una tabla), se respeta tal cual y este campo se ignora:
   * lo que el usuario escribió manda.
   */
  schema?: string;
}

/** Dialecto con el que se ha comportado este archivo desde siempre: comillas invertidas de MySQL. */
const DIALECTO_POR_DEFECTO: SqlDialect = "mysql";

/**
 * Escapador de CSV del proyecto — el ÚNICO (fase 14, T4).
 *
 * Se exporta porque hasta ahora había TRES copias del mismo escapado (`export-formats.ts`,
 * `grid/clipboard.ts` y `results-grid.tsx`) y bastaba con que una divergiera (una entrecomilla el
 * `\r` y otra no, una dobla comillas y otra no) para que el mismo dato saliera distinto según por
 * dónde se hubiera copiado. «Copiar como» (T5) usa esta misma a través de `formatCsv`.
 *
 * Regla: comillas dobles sólo cuando hacen falta (coma, comilla, salto de línea o retorno de
 * carro) y las comillas internas se doblan. Un NULL se escribe vacío, no como `[NULL]`: ese literal
 * es de la PINTURA de la celda (fase 11), y colarlo en un CSV mete como dato una cadena que no lo
 * era.
 */
export function escaparCsv(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = cellText(value) ?? "";
  if (/[",\n\r]/.test(text)) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

/**
 * Literal SQL de un valor, para el dialecto pedido.
 *
 * - NULL/undefined → `NULL`, sin comillas.
 * - booleanos → `TRUE`/`FALSE`, salvo en SQL Server: T-SQL no tiene literales booleanos, así que
 *   allí van `1`/`0` (que es como T-SQL los escribe en un INSERT). Antes esto era siempre
 *   `TRUE`/`FALSE` y el INSERT de SQL Server no compilaba.
 * - números → tal cual.
 * - todo lo demás → cadena entre comillas simples, doblando las internas (`O'Brien` →
 *   `'O''Brien'`), que es el escapado de SQL estándar y vale igual en los tres motores.
 *
 * Ojo con los números que llegan como CADENA (`numeric` y `bigint` los manda el driver así para no
 * perder precisión): salen entrecomillados, y es lo correcto — el motor los castea al tipo de la
 * columna y las cifras llegan intactas, mientras que pasarlos por `Number()` perdería dígitos.
 *
 * Hueco conocido, anotado y no colado: en SQL Server las cadenas salen sin el prefijo `N'…'`, así
 * que un texto con caracteres fuera de la página de códigos de la base podría no llegar intacto.
 * Esta fase no lo pide; si se pide, se arregla aquí y no en cada llamador.
 */
function sqlLiteral(value: unknown, dialecto: SqlDialect): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") {
    if (dialecto === "sqlserver") return value ? "1" : "0";
    return value ? "TRUE" : "FALSE";
  }
  if (typeof value === "number") return String(value);
  const text = cellText(value) ?? "";
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * Nombre de la tabla listo para el SQL, con cada parte entrecomillada según el dialecto.
 *
 * Reglas (fase 14, T4):
 *
 * 1. Si no hay nombre, se usa `tabla` y se marca `desconocida`. Antes era `exported_table`: un
 *    nombre en inglés que además PARECÍA real, así que el INSERT se ejecutaba contra una tabla
 *    inexistente sin que nada avisara. El aviso en la primera línea lo pone el INSERT (solo el
 *    INSERT), que es la única sentencia que puede meter filas donde no debe.
 * 2. Si el nombre escrito ya trae esquema (`ventas.clientes`), cada parte se entrecomilla por
 *    separado y `options.schema` se ignora: el nombre que escribió el usuario manda.
 * 3. Si es un nombre simple y hay `options.schema`, se antepone el esquema, entrecomillado también
 *    por separado (`"public"."clientes"`).
 */
function nombreDeTablaSql(options: ExportOptions): { sql: string; desconocida: boolean } {
  const dialecto = options.dialecto ?? DIALECTO_POR_DEFECTO;
  const esquema = (options.schema ?? "").trim();
  const partes = (options.tableName ?? "")
    .trim()
    .split(".")
    .map((p) => p.trim())
    .filter((p) => p !== "");

  if (partes.length === 0) {
    const tabla = quoteIdentifier("tabla", dialecto);
    return {
      sql: esquema === "" ? tabla : `${quoteIdentifier(esquema, dialecto)}.${tabla}`,
      desconocida: true,
    };
  }
  if (partes.length > 1) {
    return {
      sql: partes.map((p) => quoteIdentifier(p, dialecto)).join("."),
      desconocida: false,
    };
  }
  return {
    sql:
      esquema === ""
        ? quoteIdentifier(partes[0], dialecto)
        : `${quoteIdentifier(esquema, dialecto)}.${quoteIdentifier(partes[0], dialecto)}`,
    desconocida: false,
  };
}

/**
 * Primera línea que acompaña al INSERT cuando no se sabe a qué tabla apunta.
 *
 * Va en la PRIMERA línea a propósito: quien copia el bloque entero y lo pega en una consola tiene
 * que leerlo antes de ejecutar, no después. Se elige avisar en vez de adivinar la tabla a partir
 * del SQL (que falla con joins y subconsultas) porque un INSERT contra la tabla equivocada es peor
 * que uno que no ejecuta.
 */
function avisoTablaDesconocida(tablaSql: string): string {
  return (
    "-- La tabla de destino es desconocida (el resultado viene de una consulta libre, no de una tabla): " +
    `cambia ${tablaSql} por el nombre real de la tabla antes de ejecutar este INSERT.`
  );
}

function pythonLiteral(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  const text = cellText(value) ?? "";
  return `r"""${text.replace(/"""/g, '\\"""')}"""`;
}

export function formatCsv(result: QueryResult): string {
  const headers = result.columns.map((c) => c.name);
  const keys = result.columns.map((c) => columnKey(c));
  const lines = [
    headers.join(","),
    ...result.rows.map((row) =>
      keys.map((k) => escaparCsv(row[k])).join(",")
    ),
  ];
  return lines.join("\n");
}

export function formatJson(result: QueryResult): string {
  return JSON.stringify(result.rows, null, 2);
}

export function formatMarkdown(result: QueryResult): string {
  const widths = result.columns.map((c) => {
    const key = columnKey(c);
    return Math.max(
      c.name.length,
      ...result.rows.map((row) => (cellText(row[key]) ?? "").length)
    );
  });

  function pad(value: unknown, width: number): string {
    const text = cellText(value) ?? "";
    return text.padEnd(width, " ");
  }

  const headerRow = `| ${result.columns.map((c, i) => pad(c.name, widths[i])).join(" | ")} |`;
  const separator = `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`;
  const dataRows = result.rows.map(
    (row) =>
      `| ${result.columns.map((c, i) => pad(row[columnKey(c)], widths[i])).join(" | ")} |`
  );

  return [headerRow, separator, ...dataRows].join("\n");
}

export function formatPretty(result: QueryResult): string {
  const widths = result.columns.map((c) => {
    const key = columnKey(c);
    return Math.max(
      c.name.length,
      ...result.rows.map((row) => (cellText(row[key]) ?? "").length)
    );
  });

  function pad(value: unknown, width: number): string {
    const text = cellText(value) ?? "NULL";
    return text.padEnd(width, " ");
  }

  const hRule =
    "+" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  const headerRow =
    "| " + result.columns.map((c, i) => pad(c.name, widths[i])).join(" | ") + " |";
  const dataRows = result.rows.map(
    (row) =>
      "| " +
      result.columns.map((c, i) => pad(row[columnKey(c)], widths[i])).join(" | ") +
      " |"
  );

  return [hRule, headerRow, hRule, ...dataRows, hRule].join("\n");
}

export function formatSqlInserts(
  result: QueryResult,
  options: ExportOptions = {}
): string {
  const dialecto = options.dialecto ?? DIALECTO_POR_DEFECTO;
  const tabla = nombreDeTablaSql(options);
  if (result.columns.length === 0 || result.rows.length === 0) return "";

  const header = `INSERT INTO ${tabla.sql} (${result.columns
    .map((c) => quoteIdentifier(c.name, dialecto))
    .join(", ")}) VALUES`;

  const values = result.rows.map(
    (row) =>
      `  (${result.columns.map((c) => sqlLiteral(row[columnKey(c)], dialecto)).join(", ")})`
  );

  const sentencia = `${header}\n${values.join(",\n")};`;
  return tabla.desconocida
    ? `${avisoTablaDesconocida(tabla.sql)}\n${sentencia}`
    : sentencia;
}

/**
 * Resuelve cada PK indicada contra `result.columns` (por `columnKey(c)` o `c.name`) para
 * entrecomillar el identificador SQL real (`c.name`) y leer el valor por `columnKey(c)`.
 */
function resolverPkColumns(
  result: QueryResult,
  pkColumns: readonly string[]
): { ident: string; key: string }[] {
  return pkColumns.map((pk) => {
    const col = result.columns.find((c) => columnKey(c) === pk || c.name === pk);
    return col ? { ident: col.name, key: columnKey(col) } : { ident: pk, key: pk };
  });
}

/**
 * Genera un UPDATE por fila, seteando todas las columnas que no son PK y
 * filtrando por la(s) columna(s) PK. Requiere `options.pkColumns` no vacío;
 * si falta, devuelve cadena vacía (el llamador debe validar antes).
 */
export function formatSqlUpdates(
  result: QueryResult,
  options: ExportOptions = {}
): string {
  const dialecto = options.dialecto ?? DIALECTO_POR_DEFECTO;
  const tabla = nombreDeTablaSql(options);
  const pkColumns = options.pkColumns ?? [];
  if (pkColumns.length === 0) return "";

  const pkResolved = resolverPkColumns(result, pkColumns);
  const pkKeys = new Set(pkResolved.map((p) => p.key));
  const setColumns = result.columns.filter((c) => !pkKeys.has(columnKey(c)));
  if (setColumns.length === 0 || result.rows.length === 0) return "";

  const statements = result.rows.map((row) => {
    const setClause = setColumns
      .map((c) => `${quoteIdentifier(c.name, dialecto)} = ${sqlLiteral(row[columnKey(c)], dialecto)}`)
      .join(", ");
    const whereClause = pkResolved
      .map((p) => `${quoteIdentifier(p.ident, dialecto)} = ${sqlLiteral(row[p.key], dialecto)}`)
      .join(" AND ");
    return `UPDATE ${tabla.sql} SET ${setClause} WHERE ${whereClause};`;
  });

  return statements.join("\n");
}

/**
 * Genera un DELETE por fila filtrando por la(s) columna(s) PK. Requiere
 * `options.pkColumns` no vacío; si falta, devuelve cadena vacía.
 *
 * A diferencia del INSERT, aquí no va el aviso de tabla desconocida: un DELETE sin saber a qué
 * tabla apunta no es «casi correcto», es un error del llamador, y el nombre por defecto `tabla`
 * (que no existe) lo deja en una sentencia que no ejecuta — que es el comportamiento seguro.
 */
export function formatSqlDeletes(
  result: QueryResult,
  options: ExportOptions = {}
): string {
  const dialecto = options.dialecto ?? DIALECTO_POR_DEFECTO;
  const tabla = nombreDeTablaSql(options);
  const pkColumns = options.pkColumns ?? [];
  if (pkColumns.length === 0 || result.rows.length === 0) return "";

  const pkResolved = resolverPkColumns(result, pkColumns);
  const statements = result.rows.map((row) => {
    const whereClause = pkResolved
      .map((p) => `${quoteIdentifier(p.ident, dialecto)} = ${sqlLiteral(row[p.key], dialecto)}`)
      .join(" AND ");
    return `DELETE FROM ${tabla.sql} WHERE ${whereClause};`;
  });

  return statements.join("\n");
}

export function formatPandas(result: QueryResult): string {
  const keys = result.columns.map((c) => columnKey(c));
  const rows = result.rows
    .map(
      (row) =>
        "    {" +
        keys
          .map((k) => `${JSON.stringify(k)}: ${pythonLiteral(row[k])}`)
          .join(", ") +
        "}"
    )
    .join(",\n");

  return `import pandas as pd

df = pd.DataFrame([\n${rows}\n])`;
}

export function formatResult(
  format: ExportFormat,
  result: QueryResult,
  options: ExportOptions = {}
): string {
  switch (format) {
    case "csv":
      return formatCsv(result);
    case "json":
      return formatJson(result);
    case "markdown":
      return formatMarkdown(result);
    case "pretty":
      return formatPretty(result);
    case "sql":
      return formatSqlInserts(result, options);
    case "sql-update":
      return formatSqlUpdates(result, options);
    case "sql-delete":
      return formatSqlDeletes(result, options);
    case "pandas":
      return formatPandas(result);
    default:
      return "";
  }
}

export function downloadText(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function copyToClipboard(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

export function extensionForFormat(format: ExportFormat): string {
  switch (format) {
    case "csv":
      return "csv";
    case "json":
      return "json";
    case "markdown":
      return "md";
    case "pretty":
      return "txt";
    case "sql":
    case "sql-update":
    case "sql-delete":
      return "sql";
    case "pandas":
      return "py";
    default:
      return "txt";
  }
}
