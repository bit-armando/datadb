import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { escaparCsv } from "@/lib/export-formats";
import {
  copiarComo,
  desdeGridSelection,
  esFormatoDeCopia,
  extraerSeleccion,
  ETIQUETA_DE_FORMATO,
  FORMATOS_DE_COPIA,
  type FormatoDeCopia,
  type OpcionesDeCopia,
} from "./copy-as";

/**
 * «Copiar como» (fase 14, T5).
 *
 * Es el «data extractor» de DataGrip, en su parte pura: resolver la selección y formatearla. Los
 * casos que se fijan aquí son los que la rejilla de hoy falla o no cubre — el NULL como `[NULL]`,
 * el valor recortado con «…», y una selección que tiene que salir en orden VISIBLE pero con los
 * valores de la fila ORIGINAL (la regla de las fases 11-13: orden y filtro son listas de índices).
 */

const COLUMNAS = [{ name: "id" }, { name: "nombre" }];

/**
 * Tres filas con los ids desordenados a propósito, para que se note si la salida se armara por
 * posición visible en vez de por índice original.
 */
const FILAS = [
  { id: 3, nombre: "tres" },
  { id: 1, nombre: "uno" },
  { id: 2, nombre: "dos" },
];

/** Posición visible → índice original: la rejilla ordenada por id ascendente (fase 14). */
const VISIBLES = [1, 2, 0];

const OPCIONES: OpcionesDeCopia = {
  dialecto: "postgres",
  tabla: "clientes",
  schema: "public",
};

describe("extraerSeleccion", () => {
  test("un rango sale en orden VISIBLE y con los valores de la fila ORIGINAL", () => {
    const ex = extraerSeleccion(
      { rango: { x: 0, y: 0, ancho: 2, alto: 2 } },
      VISIBLES,
      COLUMNAS
    );
    assert.deepEqual(ex.columnas, ["id", "nombre"]);
    // Visibles 0 y 1 → originales 1 y 2 (NO 0 y 1): si se copiara por posición, saldría «3/tres».
    assert.deepEqual(ex.indicesOriginales, [1, 2]);
    assert.equal(copiarComo("tsv", FILAS, ex, OPCIONES), "1\tuno\n2\tdos");
  });

  test("un rango sobre una rejilla FILTRADA (subconjunto de visibles)", () => {
    // El filtro de la fase 13 deja sólo los visibles [2, 0]: las filas de la salida tienen que ser
    // las originales 2 y 0, no las 0 y 1.
    const visiblesFiltrados = [2, 0];
    const ex = extraerSeleccion(
      { rango: { x: 0, y: 0, ancho: 1, alto: 2 } },
      visiblesFiltrados,
      COLUMNAS
    );
    assert.deepEqual(ex.indicesOriginales, [2, 0]);
    assert.equal(copiarComo("tsv", FILAS, ex, OPCIONES), "2\n3");
  });

  test("un rango que se sale de los datos no revienta: copia lo que existe", () => {
    const ex = extraerSeleccion(
      { rango: { x: 1, y: 2, ancho: 5, alto: 5 } },
      VISIBLES,
      COLUMNAS
    );
    assert.deepEqual(ex.columnas, ["nombre"], "las columnas que no existen se ignoran");
    assert.deepEqual(ex.indicesOriginales, [0], "sólo queda la fila visible 2");
  });

  test("filas marcadas: todas sus columnas, en orden visible", () => {
    // Se marcan en orden inverso a propósito: la salida tiene que ir de arriba abajo.
    const ex = extraerSeleccion({ filas: [2, 0] }, VISIBLES, COLUMNAS);
    assert.deepEqual(ex.columnas, ["id", "nombre"], "todas las columnas de la rejilla");
    assert.deepEqual(ex.indicesOriginales, [1, 0]);
    assert.equal(copiarComo("tsv", FILAS, ex, OPCIONES), "1\tuno\n3\ttres");
  });

  test("columnas seleccionadas: todas las filas visibles, en orden visible", () => {
    const ex = extraerSeleccion({ columnas: [1] }, VISIBLES, COLUMNAS);
    assert.deepEqual(ex.columnas, ["nombre"]);
    assert.deepEqual(ex.indicesOriginales, [1, 2, 0]);
    assert.equal(copiarComo("tsv", FILAS, ex, OPCIONES), "uno\ndos\ntres");
  });

  test("las columnas salen de izquierda a derecha aunque se marquen al revés", () => {
    const ex = extraerSeleccion({ columnas: [1, 0] }, VISIBLES, COLUMNAS);
    assert.deepEqual(ex.columnas, ["id", "nombre"]);
  });

  test("precedencia: rango → filas marcadas → columnas", () => {
    // Las tres a la vez: manda el rango.
    const conRango = extraerSeleccion(
      { rango: { x: 0, y: 0, ancho: 1, alto: 1 }, filas: [2], columnas: [1] },
      VISIBLES,
      COLUMNAS
    );
    assert.deepEqual(conRango.columnas, ["id"]);
    assert.deepEqual(conRango.indicesOriginales, [1]);

    // Sin rango: mandan las filas marcadas (y traen todas las columnas, no la marcada).
    const conFilas = extraerSeleccion({ filas: [2], columnas: [1] }, VISIBLES, COLUMNAS);
    assert.deepEqual(conFilas.columnas, ["id", "nombre"]);
    assert.deepEqual(conFilas.indicesOriginales, [0]);

    // Filas marcadas vacías: caen a las columnas.
    const soloColumnas = extraerSeleccion({ filas: [], columnas: [1] }, VISIBLES, COLUMNAS);
    assert.deepEqual(soloColumnas.columnas, ["nombre"]);
    assert.deepEqual(soloColumnas.indicesOriginales, [1, 2, 0]);
  });

  test("sin selección no hay extracción", () => {
    for (const vacia of [undefined, {}, { filas: [], columnas: [] }]) {
      assert.deepEqual(extraerSeleccion(vacia, VISIBLES, COLUMNAS), {
        columnas: [],
        indicesOriginales: [],
      });
    }
  });
});

describe("copiarComo: los cinco formatos", () => {
  const ex = extraerSeleccion(
    { rango: { x: 0, y: 0, ancho: 2, alto: 2 } },
    VISIBLES,
    COLUMNAS
  );

  test("TSV: sin cabecera, tabuladores y saltos", () => {
    assert.equal(copiarComo("tsv", FILAS, ex, OPCIONES), "1\tuno\n2\tdos");
  });

  test("CSV: con fila de nombres (D6)", () => {
    assert.equal(copiarComo("csv", FILAS, ex, OPCIONES), "id,nombre\n1,uno\n2,dos");
  });

  test("Markdown: tabla con cabecera y separador (D6)", () => {
    assert.equal(
      copiarComo("markdown", FILAS, ex, OPCIONES),
      "| id | nombre |\n| -- | ------ |\n| 1  | uno    |\n| 2  | dos    |"
    );
  });

  test("JSON: array de objetos con los nombres como claves", () => {
    const json = copiarComo("json", FILAS, ex, OPCIONES);
    assert.deepEqual(JSON.parse(json), [
      { id: 1, nombre: "uno" },
      { id: 2, nombre: "dos" },
    ]);
  });

  test("JSON: sólo las columnas elegidas", () => {
    const soloNombre = extraerSeleccion({ columnas: [1] }, VISIBLES, COLUMNAS);
    const json = copiarComo("json", FILAS, soloNombre, OPCIONES);
    assert.deepEqual(JSON.parse(json), [
      { nombre: "uno" },
      { nombre: "dos" },
      { nombre: "tres" },
    ]);
  });

  test("INSERT: lista de columnas y tabla cualificada", () => {
    assert.equal(
      copiarComo("insert", FILAS, ex, OPCIONES),
      'INSERT INTO "public"."clientes" ("id", "nombre") VALUES\n  (1, \'uno\'),\n  (2, \'dos\');'
    );
  });

  test("INSERT sin tabla conocida: `tabla` y el aviso en la primera línea", () => {
    const sql = copiarComo("insert", FILAS, ex, { dialecto: "postgres" });
    assert.ok(sql.startsWith("-- "), sql);
    assert.ok(sql.includes('INSERT INTO "tabla" ("id", "nombre") VALUES'), sql);
  });
});

describe("copiarComo: NULL en los cinco formatos", () => {
  const filas = [{ id: 1, nombre: null }];
  const ex = extraerSeleccion(
    { rango: { x: 0, y: 0, ancho: 2, alto: 1 } },
    [0],
    COLUMNAS
  );

  test("TSV: campo vacío (nunca [NULL])", () => {
    assert.equal(copiarComo("tsv", filas, ex, OPCIONES), "1\t");
  });

  test("CSV: campo vacío", () => {
    assert.equal(copiarComo("csv", filas, ex, OPCIONES), "id,nombre\n1,");
  });

  test("Markdown: celda vacía", () => {
    assert.equal(
      copiarComo("markdown", filas, ex, OPCIONES),
      "| id | nombre |\n| -- | ------ |\n| 1  |        |"
    );
  });

  test("JSON: null de JSON, no la cadena \"[NULL]\"", () => {
    assert.deepEqual(JSON.parse(copiarComo("json", filas, ex, OPCIONES)), [
      { id: 1, nombre: null },
    ]);
  });

  test("INSERT: NULL sin comillas", () => {
    assert.ok(copiarComo("insert", filas, ex, OPCIONES).includes("(1, NULL)"));
  });

  test("en ningún formato se cuela el literal [NULL] de la pintura", () => {
    for (const formato of ["tsv", "csv", "insert", "json", "markdown"] as FormatoDeCopia[]) {
      assert.ok(
        !copiarComo(formato, filas, ex, OPCIONES).includes("[NULL]"),
        `${formato} no debe llevar [NULL]`
      );
    }
  });
});

describe("copiarComo: valores crudos", () => {
  test("un valor de 10 000 caracteres llega ENTERO (sin el «…» de la pintura)", () => {
    // El recorte a 4 096 es de la rejilla, no del dato (fase 12). Si se colara aquí, el
    // portapapeles llevaría un valor truncado sin que nadie lo notara hasta pegarlo.
    const largo = "x".repeat(10_000);
    const filas = [{ id: 1, nombre: largo }];
    const ex = extraerSeleccion(
      { rango: { x: 1, y: 0, ancho: 1, alto: 1 } },
      [0],
      COLUMNAS
    );
    assert.equal(copiarComo("tsv", filas, ex, OPCIONES), largo);
    assert.equal(copiarComo("csv", filas, ex, OPCIONES), `nombre\n${largo}`);
    assert.equal(
      JSON.parse(copiarComo("json", filas, ex, OPCIONES))[0].nombre.length,
      10_000
    );
    assert.ok(!copiarComo("tsv", filas, ex, OPCIONES).includes("…"));
  });

  test("TSV: tabulador, salto de línea y comillas se escapan como en glide", () => {
    // Mismo criterio que `copy-paste.js` de glide (escapeIfNeeded): comillas dobles si el valor
    // tiene \t, \n o ", doblando las internas. Es lo que entiende una hoja de cálculo al pegar.
    const filas = [
      { id: 1, nombre: "con\ttab" },
      { id: 2, nombre: "linea1\nlinea2" },
      { id: 3, nombre: 'di "hola"' },
      { id: 4, nombre: "sin nada" },
    ];
    const ex = extraerSeleccion(
      { rango: { x: 1, y: 0, ancho: 1, alto: 4 } },
      [0, 1, 2, 3],
      COLUMNAS
    );
    assert.equal(
      copiarComo("tsv", filas, ex, OPCIONES),
      '"con\ttab"\n"linea1\nlinea2"\n"di ""hola"""\nsin nada'
    );
  });

  test("CSV: la coma y las comillas usan el escapador único de export-formats", () => {
    const filas = [{ id: 1, nombre: "O'Brien, Ana" }];
    const ex = extraerSeleccion(
      { rango: { x: 0, y: 0, ancho: 2, alto: 1 } },
      [0],
      COLUMNAS
    );
    assert.equal(
      copiarComo("csv", filas, ex, OPCIONES),
      'id,nombre\n1,"O\'Brien, Ana"'
    );
  });

  test("CSV: la salida es EXACTAMENTE la del escapador único, valor a valor", () => {
    // Fija la coherencia que pide T4 («un solo escapador»): lo que «copiar como CSV» escribe para
    // cada valor es lo que devuelve `escaparCsv`, sin una segunda implementación por medio.
    const raros = ["O'Brien, Ana", 'di "hola"', "linea1\nlinea2", "simple", ""];
    const filas = raros.map((nombre, i) => ({ id: i + 1, nombre }));
    const ex = extraerSeleccion(
      { rango: { x: 1, y: 0, ancho: 1, alto: raros.length } },
      raros.map((_, i) => i),
      COLUMNAS
    );
    assert.equal(
      copiarComo("csv", filas, ex, OPCIONES),
      ["nombre", ...raros.map((v) => escaparCsv(v))].join("\n")
    );
  });
});

describe("copiarComo: selección vacía", () => {
  test("devuelve \"\" en los cinco formatos", () => {
    const vacia = extraerSeleccion(undefined, VISIBLES, COLUMNAS);
    for (const formato of ["tsv", "csv", "insert", "json", "markdown"] as FormatoDeCopia[]) {
      assert.equal(copiarComo(formato, FILAS, vacia, OPCIONES), "", formato);
    }
  });

  test("una extracción con filas fuera de rango también queda vacía", () => {
    const ex = { columnas: ["id"], indicesOriginales: [99] };
    assert.equal(copiarComo("tsv", FILAS, ex, OPCIONES), "");
  });
});

/* ─── T6/T7: la lista de formatos y la traducción de la selección de glide ─────────────── */

describe("los cinco formatos (T6)", () => {
  test("FORMATOS_DE_COPIA cubre exactamente el tipo, y ETIQUETA_DE_FORMATO también", () => {
    // Si alguien añade un formato al union y se olvida de la lista, el selector de la barra y el
    // submenú «Copiar como ▸» no lo ofrecerían y `esFormatoDeCopia` lo rechazaría: el formato
    // existiría en el tipo y no en la UI. Esta comprobación es la que lo caza.
    const delTipo: Record<FormatoDeCopia, true> = {
      tsv: true,
      csv: true,
      insert: true,
      json: true,
      markdown: true,
    };
    assert.deepEqual([...FORMATOS_DE_COPIA].sort(), Object.keys(delTipo).sort());
    for (const formato of FORMATOS_DE_COPIA) {
      assert.equal(typeof ETIQUETA_DE_FORMATO[formato], "string");
      assert.ok(ETIQUETA_DE_FORMATO[formato].length > 0);
    }
    // Y las etiquetas son las que enseña la UI, en el orden del selector.
    assert.deepEqual(
      FORMATOS_DE_COPIA.map((f) => ETIQUETA_DE_FORMATO[f]),
      ["TSV", "CSV", "INSERT", "JSON", "Markdown"]
    );
  });

  test("esFormatoDeCopia: sólo los cinco, y `tsv` es el primero (el de por defecto)", () => {
    for (const formato of FORMATOS_DE_COPIA) assert.equal(esFormatoDeCopia(formato), true);
    assert.equal(FORMATOS_DE_COPIA[0], "tsv");
    for (const basura of [undefined, null, 0, "", "TSV", "sql", "klingon", {}, ["json"]]) {
      assert.equal(esFormatoDeCopia(basura), false, String(basura));
    }
  });
});

describe("desdeGridSelection: la traducción desde glide (T6/T7)", () => {
  /** Doble de un `GridSelection`: `rows`/`columns` son iterables, como el `CompactSelection` real. */
  const sel = (partes: {
    range?: { x: number; y: number; width: number; height: number };
    filas?: number[];
    columnas?: number[];
  }) => ({
    current: partes.range ? { cell: [partes.range.x, partes.range.y], range: partes.range, rangeStack: [] } : undefined,
    rows: new Set(partes.filas ?? []),
    columns: new Set(partes.columnas ?? []),
  });

  test("sin nada seleccionado devuelve `undefined` (no una selección vacía)", () => {
    assert.equal(desdeGridSelection(undefined), undefined);
    assert.equal(desdeGridSelection(sel({})), undefined);
    // El `GridSelection` real de glide nunca trae `rows`/`columns` ausentes, pero el tipo es
    // estructural: si llegara a faltar una de las dos, tampoco puede reventar.
    assert.equal(desdeGridSelection({ current: undefined }), undefined);
  });

  test("el rango se copia TAL CUAL: `x` es columna de DATOS, sin el marcador de fila", () => {
    // La medición de la ventana real (sonda f14-t6-seleccion.mjs) es la que fija esto: un rango que
    // empieza en la 2ª columna de datos copia la 2ª columna. Si la traducción sumara 1 (creyendo
    // que `x` cuenta el canal de números), aquí se vería `x: 2` y en la ventana se copiaría una
    // columna de más a la izquierda.
    const datos = desdeGridSelection(sel({ range: { x: 1, y: 0, width: 3, height: 5 } }));
    assert.deepEqual(datos, {
      rango: { x: 1, y: 0, ancho: 3, alto: 5 },
      filas: [],
      columnas: [],
    });
    // Y el mismo objeto alimenta `extraerSeleccion`: columnas 1..3 y filas visibles 0..4.
    const ex = extraerSeleccion(datos, VISIBLES, [{ name: "id" }, { name: "nombre" }, { name: "ciudad" }, { name: "activo" }]);
    assert.deepEqual(ex.columnas, ["nombre", "ciudad", "activo"]);
    assert.deepEqual(ex.indicesOriginales, [1, 2, 0]);
  });

  test("filas y columnas marcadas salen como arrays, en el orden del iterable", () => {
    const datos = desdeGridSelection(sel({ filas: [2, 0], columnas: [3] }));
    assert.deepEqual(datos?.filas, [2, 0]);
    assert.deepEqual(datos?.columnas, [3]);
    assert.equal(datos?.rango, undefined);
    // Precedencia de siempre: con rango manda el rango; sin él, las filas.
    const conRango = desdeGridSelection(sel({ range: { x: 0, y: 0, width: 1, height: 1 }, filas: [2] }));
    const ex = extraerSeleccion(conRango, VISIBLES, COLUMNAS);
    assert.deepEqual(ex.columnas, ["id"]);
    assert.deepEqual(ex.indicesOriginales, [1]);
  });

  test("de punta a punta: la selección de glide sobre una rejilla ordenada y filtrada", () => {
    // Mismo caso que la sonda: `VISIBLES` es la rejilla ordenada por id ascendente; el usuario
    // selecciona la primera columna de las dos primeras filas visibles.
    const datos = desdeGridSelection(sel({ range: { x: 0, y: 0, width: 1, height: 2 } }));
    const ex = extraerSeleccion(datos, VISIBLES, COLUMNAS);
    assert.equal(copiarComo("tsv", FILAS, ex, OPCIONES), "1\n2");
  });
});

describe("copiarComo con columnas homónimas (key disambiguada)", () => {
  const colsDup = [{ name: "name" }, { name: "id" }, { name: "name", key: "name_2" }];
  const filasDup = [
    { name: "Banco Norte", id: 10, name_2: "Cuenta Principal" },
    { name: "Banco Sur", id: 20, name_2: "Cuenta Ahorro" },
  ];

  test("preserva los valores de ambas columnas en TSV, CSV, JSON, Markdown e INSERT", () => {
    const ex = extraerSeleccion(
      { rango: { x: 0, y: 0, ancho: 3, alto: 2 } },
      [0, 1],
      colsDup
    );
    assert.deepEqual(ex.columnas, ["name", "id", "name"]);
    assert.deepEqual(ex.definiciones, [
      { name: "name" },
      { name: "id" },
      { name: "name", key: "name_2" },
    ]);

    assert.equal(
      copiarComo("tsv", filasDup, ex, OPCIONES),
      "Banco Norte\t10\tCuenta Principal\nBanco Sur\t20\tCuenta Ahorro"
    );
    assert.equal(
      copiarComo("csv", filasDup, ex, OPCIONES),
      "name,id,name\nBanco Norte,10,Cuenta Principal\nBanco Sur,20,Cuenta Ahorro"
    );
    assert.deepEqual(JSON.parse(copiarComo("json", filasDup, ex, OPCIONES)), filasDup);
    assert.equal(
      copiarComo("markdown", filasDup, ex, OPCIONES),
      "| name        | id | name             |\n| ----------- | -- | ---------------- |\n| Banco Norte | 10 | Cuenta Principal |\n| Banco Sur   | 20 | Cuenta Ahorro    |"
    );
    assert.equal(
      copiarComo("insert", filasDup, ex, OPCIONES),
      'INSERT INTO "public"."clientes" ("name", "id", "name") VALUES\n  (\'Banco Norte\', 10, \'Cuenta Principal\'),\n  (\'Banco Sur\', 20, \'Cuenta Ahorro\');'
    );
  });

  test("seleccionar solo la segunda columna duplicada copia únicamente sus valores", () => {
    const ex = extraerSeleccion({ columnas: [2] }, [0, 1], colsDup);
    assert.equal(copiarComo("tsv", filasDup, ex, OPCIONES), "Cuenta Principal\nCuenta Ahorro");
    assert.equal(
      copiarComo("csv", filasDup, ex, OPCIONES),
      "name\nCuenta Principal\nCuenta Ahorro"
    );
  });
});
