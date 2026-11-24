/**
 * «Copiar como» sobre una selección de la rejilla (fase 14, T5) — el «data extractor» de DataGrip.
 *
 * DataGrip llama «data extractors» a los formateadores de copiado (Settings → Database → Data
 * Extractors): el clic derecho sobre una rejilla ofrece «Copiar como ▸ TSV / CSV / SQL Inserts /
 * JSON / Markdown» y ⌘C usa el que esté activo. Aquí vive la parte pura de eso: qué celdas forman
 * la selección y qué texto sale de ellas. La parte de UI (⌘C, el selector de la barra y el menú
 * contextual) es T6/T7, y por eso este archivo no importa React ni toca el portapapeles.
 *
 * Dos reglas que vienen de las fases 11-13 y no se negocian aquí:
 *
 * 1. **La selección se lee del array ORIGINAL, por índice.** El orden (fase 14) y el filtro (fase
 *    13) son listas de índices (`grid/sorting.ts` devuelve índices a propósito), así que la
 *    rejilla sabe para cada posición VISIBLE qué fila original está enseñando. Copiar tiene que
 *    usar ese mismo camino: si se copiara «lo que se ve» por posición, una edición pendiente o una
 *    fila duplicada apuntarían a la fila equivocada.
 * 2. **El valor crudo, no el pintado.** El texto sale de `cellText()` (fase 12), no de
 *    `pintarCelda()`: el pintado recorta a 4 096 caracteres con «…» y un NULL sale como `[NULL]`.
 *    Nada de eso puede llegar al portapapeles.
 */

import { cellText } from "@/lib/cell-value";
import { formatResult } from "@/lib/export-formats";
import { columnKey } from "@/lib/query-columns";
import type { SqlDialect } from "@/lib/quote";
import type { QueryResult } from "@/lib/types";

/** Los cinco formatos de «copiar como» (R39). `tsv` es el de por defecto (D2/D5). */
export type FormatoDeCopia = "tsv" | "csv" | "insert" | "json" | "markdown";

/**
 * Los cinco formatos, en el orden en que los enseñan el selector de la barra y el submenú
 * «Copiar como ▸» (T6/T7) — el mismo orden de la lista de «data extractors» de DataGrip.
 *
 * La lista vive aquí, junto al tipo, para que añadir un formato sea tocar UN sitio: el selector,
 * el submenú y la lectura tolerante de la preferencia guardada salen todos de ella.
 */
export const FORMATOS_DE_COPIA: readonly FormatoDeCopia[] = ["tsv", "csv", "insert", "json", "markdown"];

/**
 * Etiqueta visible de cada formato: lo que enseña el selector de la barra y el submenú.
 *
 * Son los nombres que DataGrip pone en su lista de data extractors (`TSV`, `CSV`, `SQL Inserts`,
 * `JSON`, `Markdown`); el de SQL se acorta a `INSERT` porque es lo que el formateador genera de
 * verdad (un `INSERT INTO … VALUES`), y llamarlo «SQL» prometería un UPDATE que no está.
 */
export const ETIQUETA_DE_FORMATO: Record<FormatoDeCopia, string> = {
  tsv: "TSV",
  csv: "CSV",
  insert: "INSERT",
  json: "JSON",
  markdown: "Markdown",
};

/**
 * ¿`valor` es uno de los cinco formatos?
 *
 * Es la puerta que usa `lib/data-settings.ts` al leer la preferencia guardada (T6): un valor
 * ausente, de una versión futura o editado a mano en el localStorage tiene que caer a `tsv` y no
 * llegar nunca a `copiarComo`, que se quedaría sin rama y devolvería `undefined` — y un
 * portapapeles con la cadena «undefined» es peor que uno con el formato por defecto.
 */
export function esFormatoDeCopia(valor: unknown): valor is FormatoDeCopia {
  return typeof valor === "string" && (FORMATOS_DE_COPIA as readonly string[]).includes(valor);
}

/**
 * Rango rectangular, en COORDENADAS DE DATOS.
 *
 * `x`/`ancho` cuentan columnas de DATOS (0 = primera columna de datos; el canal de números de fila
 * de glide no es una columna de datos y aquí no existe). `y`/`alto` cuentan filas VISIBLES (0 = la
 * primera fila que se ve, ya con el filtro y el orden aplicados), no filas originales.
 */
export interface RangoDeDatos {
  x: number;
  y: number;
  ancho: number;
  alto: number;
}

/**
 * Lo que el usuario tiene seleccionado, en el mínimo común que necesita este módulo.
 *
 * Es un tipo PROPIO y no el `GridSelection` de glide a propósito: T6/T7 traducen el de glide
 * (`current.range` → `rango`; `rows.toArray()` → `filas`; `columns.toArray()` → `columnas`) y este
 * archivo se queda puro y testeable sin importar el paquete del canvas. Las tres partes son
 * opcionales porque una selección de glide puede ser cualquiera de las tres cosas.
 *
 * `filas` y `columnas` van en coordenadas VISIBLES (las mismas que reporta glide: su fila 0 es la
 * primera fila que se está mostrando).
 */
export interface SeleccionDeDatos {
  rango?: RangoDeDatos;
  /** Filas marcadas con el marcador de la izquierda, como índices VISIBLES. */
  filas?: readonly number[];
  /** Columnas seleccionadas en la cabecera, como índices de columna de DATOS. */
  columnas?: readonly number[];
}

/**
 * La selección ya resuelta y traducida: qué columnas salen (por nombre, en orden) y qué filas
 * salen (por índice ORIGINAL, en el orden en que se van a escribir).
 */
export interface ExtraccionDeSeleccion {
  columnas: string[];
  /**
   * Definiciones con clave disambiguada cuando alguna columna extraída tiene `key !== undefined`;
   * ausente cuando no hay duplicados para conservar la forma simple del objeto.
   */
  definiciones?: { name: string; key?: string }[];
  indicesOriginales: number[];
}

/** Opciones de `copiarComo`: el dialecto hace falta sólo para el INSERT; tabla/esquema, si se conocen. */
export interface OpcionesDeCopia {
  dialecto: SqlDialect;
  /** Tabla destino del INSERT. Si falta, el formateador usa `tabla` y avisa en un comentario. */
  tabla?: string;
  schema?: string;
}

/** Sin duplicados y en orden ascendente: la salida siempre va de arriba abajo / de izquierda a derecha. */
function ordenarSinDuplicados(valores: readonly number[]): number[] {
  return [...new Set(valores)].sort((a, b) => a - b);
}

/** Sin duplicados conservando el orden recibido (para listas que ya vienen en orden visible). */
function sinDuplicados(valores: readonly number[]): number[] {
  return [...new Set(valores)];
}

/**
 * Forma MÍNIMA del `GridSelection` de glide que necesita la traducción (T6/T7).
 *
 * Es **estructural** a propósito, y no un `import type { GridSelection } from
 * "@glideapps/glide-data-grid"`: este módulo es puro y se prueba con `node:test` sin navegador, y
 * el paquete del canvas arrastra React y su CSS. Que el `GridSelection` real encaje con esto lo
 * comprueba `tsc` en los dos sitios que lo usan (`data-grid.tsx` para el ⌘C, `results-grid.tsx`
 * para el botón y el menú contextual).
 *
 * `rows`/`columns` se declaran `Iterable<number>` porque eso es lo que son: en glide son
 * `CompactSelection`, que implementa `Symbol.iterator` (`data-grid-types.js`) — y por eso el
 * `for (const r of s.rows)` que ya había en `data-grid.tsx` funcionaba.
 *
 * MEDIDO (2026-10-12, ventana real, `rowMarkers="clickable-number"`): las tres partes llegan en
 * **coordenadas de datos**. Glide mantiene la selección hacia fuera desplazada −1 respecto a la
 * suya interna — `shiftSelection(gridSelectionOuter, rowMarkerOffset)` al entrar y
 * `shiftSelection(newVal, -rowMarkerOffset)` al salir (`data-editor.js:126` y `:146`)—, así que
 * `range.x`/`columns` NO cuentan la columna del marcador de fila. Medido leyendo el prop controlado
 * del componente (sonda `f14-t6-seleccion.mjs`): un clic en la 1ª columna de datos deja `range.x=0`
 * y en la 2ª deja `range.x=1`. Ver el `Avance: T6 y T7` del PLAN.
 */
export interface SeleccionDeGlide {
  current?: { range: { x: number; y: number; width: number; height: number } } | undefined;
  rows?: Iterable<number> | undefined;
  columns?: Iterable<number> | undefined;
}

/**
 * Traduce la selección de glide (`GridSelection`) al mínimo común que entiende este módulo.
 *
 * Devuelve `undefined` cuando la selección no tiene NADA (ni rango, ni filas, ni columnas): así el
 * llamador distingue «no hay selección» de «hay una selección vacía», y el ⌘C puede no hacer nada
 * en el primer caso (dejando pasar el copiado nativo del navegador, que es lo que necesita un
 * input de la fila de filtros).
 */
export function desdeGridSelection(seleccion: SeleccionDeGlide | undefined): SeleccionDeDatos | undefined {
  if (!seleccion) return undefined;
  const filas = seleccion.rows ? [...seleccion.rows] : [];
  const columnas = seleccion.columns ? [...seleccion.columns] : [];
  const rango = seleccion.current
    ? {
        x: seleccion.current.range.x,
        y: seleccion.current.range.y,
        ancho: seleccion.current.range.width,
        alto: seleccion.current.range.height,
      }
    : undefined;
  if (!rango && filas.length === 0 && columnas.length === 0) return undefined;
  return { rango, filas, columnas };
}

/**
 * Resuelve la selección a `{ columnas, indicesOriginales }`.
 *
 * Precedencia — la misma que usa glide hoy al copiar, para no cambiar el gesto (plan, «Qué se
 * copia»):
 *
 * 1. **rango** — el rectángulo, tal cual.
 * 2. **filas marcadas** — todas las columnas de la rejilla, sólo esas filas.
 * 3. **columnas seleccionadas** — todas las filas visibles, sólo esas columnas.
 *
 * Si no hay ninguna de las tres, la extracción queda vacía y `copiarComo` devuelve "".
 *
 * Las filas salen SIEMPRE en orden visible (se ordenan sus índices visibles de menor a mayor) y se
 * traducen a índice original con `indicesVisibles[v]`, que es el mapa posición-visible →
 * índice-original que ya calcula la rejilla (fase 13: filtro y orden sobre índices). Un índice
 * fuera de rango se ignora en vez de reventar: una selección puede quedar desfasada del result por
 * un refresco, y ahí lo correcto es copiar lo que aún existe.
 */
function construirExtraccion(
  elegidas: readonly { name: string; key?: string }[],
  indicesOriginales: number[]
): ExtraccionDeSeleccion {
  const tieneClaves = elegidas.some((c) => c.key !== undefined);
  return {
    columnas: elegidas.map((c) => c.name),
    ...(tieneClaves
      ? {
          definiciones: elegidas.map((c) =>
            c.key !== undefined ? { name: c.name, key: c.key } : { name: c.name }
          ),
        }
      : {}),
    indicesOriginales,
  };
}

export function extraerSeleccion(
  seleccion: SeleccionDeDatos | undefined,
  indicesVisibles: readonly number[],
  columnas: readonly { name: string; key?: string }[]
): ExtraccionDeSeleccion {
  // 1) Rango. Se usa aunque venga degenerado (ancho/alto 0): una selección «vacía» explícita no
  //    debe caer a las filas marcadas, que ya no son la selección vigente.
  if (seleccion?.rango) {
    const { x, y, ancho, alto } = seleccion.rango;
    const colsElegidas: { name: string; key?: string }[] = [];
    for (let c = x; c < x + ancho; c++) {
      const col = columnas[c];
      if (col) colsElegidas.push(col);
    }
    const indices: number[] = [];
    for (let f = y; f < y + alto; f++) {
      const original = indicesVisibles[f];
      if (original !== undefined) indices.push(original);
    }
    return construirExtraccion(colsElegidas, indices);
  }

  // 2) Filas marcadas: todas las columnas de la rejilla, en el orden de la rejilla.
  const marcadas = ordenarSinDuplicados(seleccion?.filas ?? []);
  if (marcadas.length > 0) {
    const indices = marcadas
      .map((visible) => indicesVisibles[visible])
      .filter((original): original is number => original !== undefined);
    return construirExtraccion(columnas, indices);
  }

  // 3) Columnas seleccionadas: todas las filas visibles, en orden visible.
  const elegidas = ordenarSinDuplicados(seleccion?.columnas ?? []);
  if (elegidas.length > 0) {
    const colsElegidas = elegidas
      .map((c) => columnas[c])
      .filter((col): col is { name: string; key?: string } => col !== undefined);
    return construirExtraccion(colsElegidas, sinDuplicados(indicesVisibles));
  }

  return { columnas: [], indicesOriginales: [] };
}

/**
 * Escapado de TSV: el mismo que aplica glide al copiar (`copy-paste.js` → `escapeIfNeeded`).
 *
 * Se conserva a propósito (D5): lo que ya copiaba la rejilla es lo que entiende una hoja de
 * cálculo — comillas dobles alrededor del valor cuando contiene tabulador, salto de línea o
 * comilla, y las comillas internas dobladas. `aTsv` del módulo viejo (`clipboard.ts`) cambiaba los
 * tabuladores por espacios; eso se descarta porque convierte un dato con tabuladores en otro dato.
 *
 * Nota: igual que glide, NO se escapa el `\r` suelto (glide prueba `/[\t\n"]/`); un salto de línea
 * de Windows (`\r\n`) sí queda entrecomillado porque contiene `\n`.
 */
export function escaparTsv(texto: string): string {
  return /[\t\n"]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

/**
 * TSV de la selección: sin cabecera (D6, igual que hoy para poder pegar un rango en una hoja),
 * con el valor CRUDO y sin recorte, y con NULL como campo vacío.
 *
 * Las dos diferencias con el ⌘C de antes son arreglos, no cambios de gusto: el NULL salía como
 * `[NULL]` (una cadena que no es el dato) y un valor de más de 4 096 caracteres salía cortado con
 * «…» (el recorte es de PINTURA, `cell-model.ts`, y se estaba colando al portapapeles).
 */
function aTsvDeResultado(resultado: QueryResult): string {
  return resultado.rows
    .map((fila) =>
      resultado.columns
        .map((c) => escaparTsv(cellText(fila[columnKey(c)]) ?? ""))
        .join("\t")
    )
    .join("\n");
}

/**
 * Genera el texto de la selección en el formato pedido.
 *
 * Para CSV / INSERT / JSON / Markdown se reutilizan los formateadores de T4 sobre un `QueryResult`
 * recortado a la selección (sólo esas columnas, sólo esas filas, en ese orden): así «copiar como» y
 * el exportador no pueden divergir — es la misma clase de coherencia que `cellText()` fuerza entre
 * celda, editor y exportación. El TSV no tiene formateador en el exportador (allí no existe), así
 * que vive aquí.
 *
 * Detalles de cada formato, los que pide D6: CSV y Markdown llevan fila de nombres (el CSV la
 * escribe `formatCsv`, el Markdown su cabecera de tabla); JSON es un array de objetos con los
 * nombres como claves; el INSERT lleva la lista de columnas y, si no se conoce la tabla, la primera
 * línea de aviso que añade `formatSqlInserts`.
 *
 * Una selección vacía (sin columnas o sin filas) devuelve "" — no una cabecera suelta ni un
 * `[]`/`INSERT` sin datos, que al pegarse serían basura.
 */
export function copiarComo(
  formato: FormatoDeCopia,
  filas: readonly Record<string, unknown>[],
  extraccion: ExtraccionDeSeleccion,
  opciones: OpcionesDeCopia
): string {
  const { columnas, indicesOriginales } = extraccion;
  if (columnas.length === 0 || indicesOriginales.length === 0) return "";

  // Los índices fuera de rango se descartan (mismo motivo que en `extraerSeleccion`): puede haber
  // un result más corto si algo refrescó entre la selección y el copiado.
  const elegidas = indicesOriginales
    .map((i) => filas[i])
    .filter((fila): fila is Record<string, unknown> => fila !== undefined);
  if (elegidas.length === 0) return "";

  const definiciones: { name: string; key?: string }[] =
    extraccion.definiciones ?? columnas.map((name) => ({ name }));
  const recorte: QueryResult = {
    columns: definiciones.map((d) => ({
      name: d.name,
      ...(d.key !== undefined ? { key: d.key } : {}),
      type: "",
    })),
    // Copia superficial a propósito: no se mutan ni se reordenan las filas originales (la rejilla
    // guarda cambios pendientes contra su posición, fases 11-13).
    rows: elegidas.map((fila) => {
      const soloElegidas: Record<string, unknown> = {};
      for (const col of definiciones) {
        const k = columnKey(col);
        soloElegidas[k] = fila[k];
      }
      return soloElegidas;
    }),
    rowCount: elegidas.length,
    // Metadatos de relleno: este QueryResult nunca se pinta, sólo lo leen los formateadores.
    durationMs: 0,
    limitApplied: false,
    effectiveLimit: elegidas.length,
  };

  switch (formato) {
    case "tsv":
      return aTsvDeResultado(recorte);
    case "csv":
      return formatResult("csv", recorte);
    case "json":
      return formatResult("json", recorte);
    case "markdown":
      return formatResult("markdown", recorte);
    case "insert":
      return formatResult("sql", recorte, {
        tableName: opciones.tabla,
        schema: opciones.schema,
        dialecto: opciones.dialecto,
      });
  }
}
