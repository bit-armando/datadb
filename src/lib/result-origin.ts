/**
 * R94 — qué se puede editar de un resultado, a partir del ORIGEN de sus columnas.
 *
 * El problema que resuelve (reportado por el usuario el 2026-10-21, con la misma consulta abierta
 * en DataGrip al lado):
 *
 *     SELECT ficha.id, ficha.datetime_deposit
 *     FROM clients_deposits_clientdeposit ficha
 *     INNER JOIN plataforms_plataformaccount pa ON …
 *     WHERE ficha.id = 6300196;
 *
 * En DataGrip ese resultado se edita: las dos columnas salen de `clients_deposits_clientdeposit` y
 * su clave primaria (`id`) está en el resultado, así que un cambio es un `UPDATE … WHERE id = …`
 * sin ambigüedad. En DataDB el contexto de edición salía SOLO del parseo del texto
 * (`parseSingleTable`), que rechaza cualquier JOIN y ni siquiera entendía el alias (`FROM tabla
 * ficha` buscaba la tabla «tabla ficha»): el resultado quedaba sin contexto, sin «Guardar», y el
 * editor de celda aceptaba un valor que se tiraba en silencio.
 *
 * Ahora el driver dice de dónde sale cada columna (`QueryColumn.origen`: MySQL lo trae en el
 * paquete de campo, Postgres en `tableID`/`columnID`) y aquí se decide, sin mirar el SQL:
 *
 * 1. Se agrupan las columnas por tabla de origen.
 * 2. Una tabla es candidata si está en el esquema cargado, tiene UNA sola clave primaria (el lote
 *    de edición actualiza por una columna) y esa clave está en el resultado con un nombre que no se
 *    repite.
 * 3. Gana la candidata con más columnas en el resultado (en empate, la primera en aparecer).
 * 4. Son editables las columnas de esa tabla cuyo nombre NO se repite en el resultado. Con nombres
 *    repetidos (`SELECT * FROM a JOIN b` con dos `id`) la fila llega como objeto y uno de los dos
 *    valores pisa al otro: editar ahí podría mandar el UPDATE a otra fila, así que se excluye.
 *
 * Hueco conocido (anotado en R94): DataGrip deja editar columnas de VARIAS tablas del mismo JOIN a
 * la vez; aquí se edita una tabla por resultado (la de más columnas). El lote de edición
 * (`batchEdit`) es de una tabla, y partirlo por tablas es un cambio aparte.
 */
import { columnKey } from "./query-columns";
import type { QueryColumn, SchemaNode, TableContext, TableMeta } from "@/lib/types";

/** Busca la tabla de un origen en el esquema cargado: primero por esquema exacto, luego por nombre único. */
function buscarTabla(
  esquemas: readonly SchemaNode[],
  schema: string | undefined,
  tabla: string
): { schema: string; tabla: TableMeta } | null {
  if (schema) {
    const nodo = esquemas.find((s) => s.name === schema);
    const t = nodo?.tables.find((x) => x.name === tabla);
    if (nodo && t) return { schema: nodo.name, tabla: t };
  }
  // Sin esquema (o con uno que el árbol no trae con ese nombre): solo vale si el nombre es ÚNICO
  // en todo lo cargado. Con la misma tabla en dos bases (pasa en el MySQL del usuario) adivinar
  // cuál es sería mandar el UPDATE a la base equivocada.
  const coincidencias = esquemas.flatMap((s) =>
    s.tables.filter((t) => t.name === tabla).map((t) => ({ schema: s.name, tabla: t }))
  );
  return coincidencias.length === 1 ? coincidencias[0] : null;
}

/**
 * El contexto de edición de un resultado según el origen de sus columnas, o `null` si ninguna
 * tabla cumple (sin origen, sin clave primaria única, clave fuera del resultado…).
 */
export function contextoDesdeOrigenes(
  columnas: readonly QueryColumn[],
  esquemas: readonly SchemaNode[] | null | undefined
): TableContext | null {
  if (!esquemas || esquemas.length === 0) return null;

  const repeticiones = new Map<string, number>();
  for (const c of columnas) {
    const clave = columnKey(c);
    repeticiones.set(clave, (repeticiones.get(clave) ?? 0) + 1);
  }
  const repetido = (clave: string) => (repeticiones.get(clave) ?? 0) > 1;

  // 1. Agrupar por tabla de origen, en orden de aparición.
  const grupos = new Map<string, { schema?: string; tabla: string; columnas: QueryColumn[] }>();
  for (const c of columnas) {
    if (!c.origen) continue;
    const clave = `${c.origen.schema ?? ""}\u0000${c.origen.table}`;
    const grupo = grupos.get(clave) ?? { schema: c.origen.schema, tabla: c.origen.table, columnas: [] };
    grupo.columnas.push(c);
    grupos.set(clave, grupo);
  }

  let mejor: TableContext | null = null;
  let mejorCuenta = 0;
  for (const grupo of grupos.values()) {
    const encontrada = buscarTabla(esquemas, grupo.schema, grupo.tabla);
    if (!encontrada) continue;
    const pks = encontrada.tabla.columns.filter((c) => c.isPrimaryKey);
    if (pks.length !== 1) continue;
    const pk = pks[0];

    // Si la misma columna real de esta tabla aparece más de una vez en el resultado, no se
    // sabe cuál edición gana al escribir, así que se excluye de la edición y de la PK.
    const repeticionesReales = new Map<string, number>();
    for (const c of grupo.columnas) {
      if (!c.origen) continue;
      repeticionesReales.set(c.origen.column, (repeticionesReales.get(c.origen.column) ?? 0) + 1);
    }
    const realRepetida = (colReal: string) => (repeticionesReales.get(colReal) ?? 0) > 1;

    // 2. La clave primaria tiene que estar en el resultado, con clave única y sin repetirse en la tabla.
    const pkEnResultado = grupo.columnas.find(
      (c) => c.origen?.column === pk.name && !repetido(columnKey(c)) && !realRepetida(pk.name)
    );
    if (!pkEnResultado) continue;

    // 4. Columnas editables (y la clave, que identifica la fila pero no se edita).
    const mapa: Record<string, string> = {};
    for (const c of grupo.columnas) {
      const key = columnKey(c);
      if (repetido(key) || !c.origen || realRepetida(c.origen.column)) continue;
      if (!encontrada.tabla.columns.some((m) => m.name === c.origen?.column)) continue;
      mapa[key] = c.origen.column;
    }
    const cuenta = Object.keys(mapa).length;
    // 3. La de más columnas; en empate se queda la primera.
    if (cuenta <= mejorCuenta) continue;
    mejorCuenta = cuenta;

    // Solo es «la tabla tal cual» si TODAS las columnas del resultado son de ella y con su
    // propio nombre: entonces una fila nueva del resultado es una fila de la tabla.
    const tablaTalCual = columnas.every(
      (c) => columnKey(c) === c.name && mapa[columnKey(c)] === c.name
    );
    mejor = {
      schema: encontrada.schema,
      table: encontrada.tabla.name,
      pkColumns: [pk],
      columns: encontrada.tabla.columns,
      columnasDelResultado: mapa,
      pkEnResultado: columnKey(pkEnResultado),
      soloActualizar: !tablaTalCual,
    };
  }
  return mejor;
}

/** ¿Trae el resultado alguna columna con origen? Si no, el contexto sale del parseo del SQL. */
export function tieneOrigenes(columnas: readonly QueryColumn[]): boolean {
  return columnas.some((c) => c.origen !== undefined);
}

/**
 * Por qué una columna del resultado NO se puede editar, en palabras del usuario; `null` si sí se
 * puede. Es el texto del editor de solo lectura y del rótulo de la barra: una celda que no se deja
 * cambiar tiene que decir por qué, en vez de aceptar el valor y tirarlo.
 */
export function motivoDeSoloLectura(
  columna: string,
  contexto: TableContext | null,
  columnasDelResultado: readonly QueryColumn[]
): string | null {
  if (!contexto) {
    return "Solo lectura: no se encontró una tabla con clave primaria única cuya clave venga en este resultado.";
  }
  const col = columnasDelResultado.find((c) => columnKey(c) === columna);
  const etiqueta = col?.name ?? columna;
  const repetida = columnasDelResultado.filter((c) => columnKey(c) === columna).length > 1;
  if (repetida) return `Solo lectura: hay más de una columna «${etiqueta}» en el resultado.`;
  const real = contexto.columnasDelResultado ? contexto.columnasDelResultado[columna] : columna;
  if (real === undefined) {
    return `Solo lectura: la columna no sale de ${contexto.table} (se editan las columnas de esa tabla).`;
  }
  const meta = contexto.columns.find((c) => c.name === real);
  if (!meta) return `Solo lectura: ${contexto.table} no tiene la columna «${real}».`;
  if (meta.isPrimaryKey) return "Solo lectura: es la clave primaria (identifica la fila en el UPDATE).";
  return null;
}
