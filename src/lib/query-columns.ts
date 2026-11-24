import type { QueryColumn } from "./types";

/**
 * Devuelve la clave única con la que se accede al valor de una columna en las filas del
 * resultado y en el estado de la rejilla (`col.key ?? col.name`).
 */
export function columnKey(col: Pick<QueryColumn, "name" | "key">): string {
  return col.key ?? col.name;
}

/**
 * Asigna claves únicas (`key`) a las columnas cuando hay nombres repetidos en el resultado.
 *
 * - Si todos los `name` son únicos, devuelve una copia superficial sin añadir `key`.
 * - Si un `name` aparece más de una vez, la primera ocurrencia conserva `name` como clave (sin
 *   `key`) y las siguientes reciben el menor sufijo `_${n}` (`n >= occurrence`) que no colisione
 *   ni con los nombres originales del resultado ni con claves ya asignadas.
 */
export function assignUniqueColumnKeys<T extends QueryColumn>(columns: readonly T[]): T[] {
  const counts = new Map<string, number>();
  for (const col of columns) {
    counts.set(col.name, (counts.get(col.name) ?? 0) + 1);
  }

  let hasDuplicates = false;
  for (const count of counts.values()) {
    if (count > 1) {
      hasDuplicates = true;
      break;
    }
  }
  if (!hasDuplicates) {
    return [...columns];
  }

  const allNames = new Set(columns.map((c) => c.name));
  const used = new Set<string>();
  for (const [name, count] of counts) {
    if (count === 1) {
      used.add(name);
    }
  }

  const seen = new Map<string, number>();
  return columns.map((col) => {
    const count = counts.get(col.name) ?? 0;
    if (count <= 1) {
      return col;
    }

    const occurrence = (seen.get(col.name) ?? 0) + 1;
    seen.set(col.name, occurrence);

    if (occurrence === 1 && !used.has(col.name)) {
      used.add(col.name);
      return col;
    }

    let n = occurrence;
    let candidate = `${col.name}_${n}`;
    while (allNames.has(candidate) || used.has(candidate)) {
      n += 1;
      candidate = `${col.name}_${n}`;
    }
    used.add(candidate);
    return { ...col, key: candidate };
  });
}
