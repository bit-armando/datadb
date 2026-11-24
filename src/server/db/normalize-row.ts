import { columnKey } from "@/lib/query-columns";
import type { QueryColumn } from "@/lib/types";
import { isDateLike, safeIsoString } from "./date-utils";

/**
 * Normaliza una fila posicional (array de valores devuelto por el driver en modo array) a un
 * objeto indexado por `columnKey(columns[i])`, preservando valores distintos cuando varias
 * columnas comparten el mismo `name`.
 */
export function normalizeArrayRow(
  values: readonly unknown[],
  columns: readonly QueryColumn[],
  formatBinary: (buf: Buffer) => string
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < columns.length; i++) {
    const value = values[i];
    const key = columnKey(columns[i]);
    if (isDateLike(value)) {
      out[key] = safeIsoString(value);
    } else if (Buffer.isBuffer(value)) {
      out[key] = formatBinary(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
