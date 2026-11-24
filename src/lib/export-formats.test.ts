import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  escaparCsv,
  extensionForFormat,
  formatCsv,
  formatJson,
  formatMarkdown,
  formatPandas,
  formatPretty,
  formatResult,
  formatSqlDeletes,
  formatSqlInserts,
  formatSqlUpdates,
} from "./export-formats";
import type { QueryResult } from "./types";

/**
 * Primer test del formateador de exportación (fase 14, T4).
 *
 * Hasta aquí `export-formats.ts` tenía 264 líneas y CERO tests, y por eso el bug de D4 vivió sin
 * que nadie lo notara: el INSERT salía con comillas invertidas contra cualquier motor y con
 * `TRUE`/`FALSE` también para SQL Server, así que el SQL exportado **no ejecutaba** fuera de
 * MySQL. Lo que se fija aquí es, sobre todo, el texto exacto por dialecto — es la única forma de
 * que una regresión de entrecomillado se vea en `npm test` y no en la consola del usuario.
 *
 * El INSERT de Postgres que se genera aquí es el que además se ejecuta de verdad contra un Postgres
 * desechable como parte de la verificación de la tarea (no basta con que el test diga que el texto
 * es bonito).
 */

function resultadoDe(
  filas: Record<string, unknown>[],
  columnas?: string[]
): QueryResult {
  const nombres = columnas ?? Object.keys(filas[0] ?? {});
  return {
    columns: nombres.map((name) => ({ name, type: "text" })),
    rows: filas,
    rowCount: filas.length,
    durationMs: 0,
    limitApplied: false,
    effectiveLimit: filas.length,
  };
}

describe("formatSqlInserts: un dialecto por motor (fase 14, D4)", () => {
  const fila = [{ id: 1, nombre: "Ana" }];

  test("postgres: comillas dobles y esquema y tabla entrecomillados POR SEPARADO", () => {
    // `"public.clientes"` (un solo identificador) no existe: son dos.
    const sql = formatSqlInserts(resultadoDe(fila), {
      tableName: "clientes",
      schema: "public",
      dialecto: "postgres",
    });
    assert.equal(
      sql,
      'INSERT INTO "public"."clientes" ("id", "nombre") VALUES\n  (1, \'Ana\');'
    );
  });

  test("mysql: comillas invertidas", () => {
    const sql = formatSqlInserts(resultadoDe(fila), {
      tableName: "clientes",
      schema: "public",
      dialecto: "mysql",
    });
    assert.equal(
      sql,
      "INSERT INTO `public`.`clientes` (`id`, `nombre`) VALUES\n  (1, 'Ana');"
    );
  });

  test("sqlserver: corchetes", () => {
    const sql = formatSqlInserts(resultadoDe(fila), {
      tableName: "clientes",
      schema: "public",
      dialecto: "sqlserver",
    });
    assert.equal(
      sql,
      "INSERT INTO [public].[clientes] ([id], [nombre]) VALUES\n  (1, 'Ana');"
    );
  });

  test("sin dialecto el texto es EXACTAMENTE el de siempre (comillas invertidas)", () => {
    // Compatibilidad: el exportador de la app pasaba a llamar sin dialecto hasta la fase 14, y
    // cualquier otro llamador que no lo pase tiene que seguir viendo el mismo texto de antes.
    const sql = formatSqlInserts(resultadoDe(fila), { tableName: "clientes" });
    assert.equal(sql, "INSERT INTO `clientes` (`id`, `nombre`) VALUES\n  (1, 'Ana');");
  });

  test("un nombre ya cualificado manda sobre `schema`", () => {
    // Es lo que se teclea en el campo «Tabla» del exportador: "ventas.clientes". Cada parte se
    // entrecomilla sola y el esquema de al lado no se duplica.
    const sql = formatSqlInserts(resultadoDe(fila), {
      tableName: "ventas.clientes",
      schema: "public",
      dialecto: "postgres",
    });
    assert.ok(sql.includes('INSERT INTO "ventas"."clientes"'), sql);
    assert.ok(!sql.includes("public"), "el esquema no se cuela dos veces");
  });

  test("los identificadores con comillas se escapan (no rompen la sentencia)", () => {
    const sql = formatSqlInserts(
      resultadoDe([{ 'co"lumna': 1 }], ['co"lumna']),
      { tableName: 'tabla"rara', dialecto: "postgres" }
    );
    assert.ok(sql.includes('"tabla""rara"'), sql);
    assert.ok(sql.includes('"co""lumna"'), sql);
  });
});

describe("formatSqlInserts: valores (fase 14, T4)", () => {
  test("O'Brien: la comilla simple se dobla", () => {
    // Sin doblar, el INSERT corta la cadena a la mitad y la sentencia no ejecuta.
    const sql = formatSqlInserts(resultadoDe([{ id: 1, nombre: "O'Brien" }]), {
      tableName: "clientes",
      dialecto: "postgres",
    });
    assert.ok(sql.includes("(1, 'O''Brien')"), sql);
  });

  test("NULL va sin comillas", () => {
    const sql = formatSqlInserts(resultadoDe([{ id: 1, nota: null }]), {
      tableName: "clientes",
      dialecto: "postgres",
    });
    assert.ok(sql.includes("(1, NULL)"), sql);
  });

  test("booleanos: TRUE/FALSE en postgres y mysql, 1/0 en sqlserver", () => {
    // T-SQL no tiene literales booleanos: `TRUE` no compila. Es el segundo bug de D4.
    const filas = [{ id: 1, activo: true, borrado: false }];
    const postgres = formatSqlInserts(resultadoDe(filas), {
      tableName: "t",
      dialecto: "postgres",
    });
    assert.ok(postgres.includes("(1, TRUE, FALSE)"), postgres);
    const mysql = formatSqlInserts(resultadoDe(filas), {
      tableName: "t",
      dialecto: "mysql",
    });
    assert.ok(mysql.includes("(1, TRUE, FALSE)"), mysql);
    const sqlserver = formatSqlInserts(resultadoDe(filas), {
      tableName: "t",
      dialecto: "sqlserver",
    });
    assert.ok(sqlserver.includes("(1, 1, 0)"), sqlserver);
  });

  test("un entero grande que llega como CADENA sale entrecomillado y completo", () => {
    // `bigint` y `numeric` llegan del driver como texto para no perder precisión. Si esto pasara
    // por `Number()`, el 9 007 199 254 740 993 se convertiría en ...992.
    const sql = formatSqlInserts(resultadoDe([{ id: "9007199254740993" }]), {
      tableName: "clientes",
      dialecto: "postgres",
    });
    assert.ok(sql.includes("('9007199254740993')"), sql);
  });

  test("los saltos de línea dentro de un valor llegan al literal tal cual", () => {
    // Nada de recortes ni de aplanarlos a espacios: el valor es el dato.
    const sql = formatSqlInserts(
      resultadoDe([{ id: 1, nota: "linea1\nlinea2" }]),
      { tableName: "clientes", dialecto: "postgres" }
    );
    assert.ok(sql.includes("'linea1\nlinea2'"), JSON.stringify(sql));
  });

  test("un jsonb (objeto JS) se serializa como JSON, no como [object Object]", () => {
    const sql = formatSqlInserts(
      resultadoDe([{ id: 1, meta: { vip: true } }]),
      { tableName: "clientes", dialecto: "postgres" }
    );
    assert.ok(sql.includes('\'{"vip":true}\''), sql);
  });
});

describe("formatSqlInserts: nombre por defecto y su aviso", () => {
  test("sin tabla conocida usa `tabla` y avisa en la PRIMERA línea", () => {
    // Antes el nombre por defecto era `exported_table`: parecía real y el INSERT apuntaba a una
    // tabla inexistente sin decir nada.
    const sql = formatSqlInserts(resultadoDe([{ id: 1 }]));
    const lineas = sql.split("\n");
    assert.ok(lineas[0].startsWith("-- "), `primera línea de aviso: ${lineas[0]}`);
    assert.match(lineas[0], /desconocida/);
    assert.match(lineas[0], /consulta libre/);
    assert.equal(lineas[1], "INSERT INTO `tabla` (`id`) VALUES");
    assert.equal(lineas[2], "  (1);");
  });

  test("con esquema pero sin tabla, el aviso sigue", () => {
    const sql = formatSqlInserts(resultadoDe([{ id: 1 }]), {
      schema: "public",
      dialecto: "postgres",
    });
    assert.ok(sql.startsWith("-- "), sql);
    assert.ok(sql.includes('INSERT INTO "public"."tabla"'), sql);
  });

  test("con tabla conocida NO hay aviso", () => {
    const sql = formatSqlInserts(resultadoDe([{ id: 1 }]), {
      tableName: "clientes",
      dialecto: "postgres",
    });
    assert.ok(!sql.startsWith("-- "), sql);
  });

  test("UPDATE y DELETE sin tabla usan `tabla` y no llevan aviso", () => {
    // Un DELETE contra la tabla equivocada no es «casi correcto»: el nombre por defecto no existe,
    // así que la sentencia no ejecuta, que es el fallo seguro.
    const updates = formatSqlUpdates(resultadoDe([{ id: 1, nombre: "Ana" }]), {
      pkColumns: ["id"],
    });
    assert.equal(updates, "UPDATE `tabla` SET `nombre` = 'Ana' WHERE `id` = 1;");
    const deletes = formatSqlDeletes(resultadoDe([{ id: 1 }]), { pkColumns: ["id"] });
    assert.equal(deletes, "DELETE FROM `tabla` WHERE `id` = 1;");
  });
});

describe("formatSqlUpdates / formatSqlDeletes: dialecto y PK", () => {
  const filas = [{ id: 7, nombre: "O'Brien" }];

  test("UPDATE con esquema, PK y comilla doblada, en los tres dialectos", () => {
    assert.equal(
      formatSqlUpdates(resultadoDe(filas), {
        tableName: "clientes",
        schema: "public",
        pkColumns: ["id"],
        dialecto: "postgres",
      }),
      'UPDATE "public"."clientes" SET "nombre" = \'O\'\'Brien\' WHERE "id" = 7;'
    );
    assert.equal(
      formatSqlUpdates(resultadoDe(filas), {
        tableName: "clientes",
        schema: "public",
        pkColumns: ["id"],
        dialecto: "mysql",
      }),
      "UPDATE `public`.`clientes` SET `nombre` = 'O''Brien' WHERE `id` = 7;"
    );
    assert.equal(
      formatSqlUpdates(resultadoDe(filas), {
        tableName: "clientes",
        schema: "public",
        pkColumns: ["id"],
        dialecto: "sqlserver",
      }),
      "UPDATE [public].[clientes] SET [nombre] = 'O''Brien' WHERE [id] = 7;"
    );
  });

  test("DELETE en los tres dialectos", () => {
    assert.equal(
      formatSqlDeletes(resultadoDe(filas), {
        tableName: "clientes",
        schema: "public",
        pkColumns: ["id"],
        dialecto: "postgres",
      }),
      'DELETE FROM "public"."clientes" WHERE "id" = 7;'
    );
    assert.equal(
      formatSqlDeletes(resultadoDe(filas), {
        tableName: "clientes",
        schema: "public",
        pkColumns: ["id"],
        dialecto: "sqlserver",
      }),
      "DELETE FROM [public].[clientes] WHERE [id] = 7;"
    );
  });

  test("sin PK no se genera nada (el llamador tiene que validarlo antes)", () => {
    assert.equal(formatSqlUpdates(resultadoDe(filas), { tableName: "clientes" }), "");
    assert.equal(formatSqlDeletes(resultadoDe(filas), { tableName: "clientes" }), "");
  });
});

describe("escaparCsv (el único escapador de CSV del proyecto)", () => {
  test("entrecomilla sólo cuando hace falta y dobla las comillas internas", () => {
    assert.equal(escaparCsv("hola"), "hola");
    assert.equal(escaparCsv(5), "5");
    assert.equal(escaparCsv("con,coma"), '"con,coma"');
    assert.equal(escaparCsv('di "hola"'), '"di ""hola"""');
    assert.equal(escaparCsv("linea1\nlinea2"), '"linea1\nlinea2"');
    assert.equal(escaparCsv("retorno\rde carro"), '"retorno\rde carro"');
  });

  test("un NULL se escribe vacío, no como [NULL]", () => {
    assert.equal(escaparCsv(null), "");
    assert.equal(escaparCsv(undefined), "");
  });

  test("formatCsv lo usa de verdad (cabecera + filas)", () => {
    const csv = formatCsv(
      resultadoDe([{ id: 1, nombre: "O'Brien, Ana" }])
    );
    assert.equal(csv, 'id,nombre\n1,"O\'Brien, Ana"');
  });
});

describe("formatResult", () => {
  test("pasa las opciones al INSERT (dialecto incluido)", () => {
    // Es el camino que usa el exportador y el que usa «copiar como»: si las opciones no llegaran,
    // todo lo de arriba no serviría de nada en la app.
    const sql = formatResult("sql", resultadoDe([{ id: 1 }]), {
      tableName: "clientes",
      schema: "public",
      dialecto: "postgres",
    });
    assert.equal(sql, 'INSERT INTO "public"."clientes" ("id") VALUES\n  (1);');
  });

  test("un result vacío no genera SQL", () => {
    assert.equal(formatResult("sql", resultadoDe([], ["id"])), "");
    assert.equal(
      formatResult("sql-update", resultadoDe([], ["id"]), { pkColumns: ["id"] }),
      ""
    );
    assert.equal(
      formatResult("sql-delete", resultadoDe([], ["id"]), { pkColumns: ["id"] }),
      ""
    );
  });
});

describe("columnas con nombre duplicado (key disambiguada)", () => {
  const duplicadas: QueryResult = {
    columns: [
      { name: "name", type: "varchar" },
      { name: "id", type: "int4" },
      { name: "name", key: "name_2", type: "varchar" },
    ],
    rows: [{ name: "Banco Uno", id: 7, name_2: "Cuenta A" }],
    rowCount: 1,
    durationMs: 0,
    limitApplied: false,
    effectiveLimit: 1,
  };

  test("CSV conserva encabezados originales y lee valores por `columnKey`", () => {
    assert.equal(formatCsv(duplicadas), "name,id,name\nBanco Uno,7,Cuenta A");
  });

  test("JSON conserva ambos valores con sus claves disambiguadas", () => {
    assert.deepEqual(JSON.parse(formatJson(duplicadas)), [
      { name: "Banco Uno", id: 7, name_2: "Cuenta A" },
    ]);
  });

  test("Markdown usa `c.name` en cabecera y valores distintos en celdas", () => {
    assert.equal(
      formatMarkdown(duplicadas),
      "| name      | id | name     |\n| --------- | -- | -------- |\n| Banco Uno | 7  | Cuenta A |"
    );
  });

  test("Pretty usa `c.name` en cabecera y valores distintos en celdas", () => {
    assert.equal(
      formatPretty(duplicadas),
      "+-----------+----+----------+\n| name      | id | name     |\n+-----------+----+----------+\n| Banco Uno | 7  | Cuenta A |\n+-----------+----+----------+"
    );
  });

  test("SQL INSERT cita `c.name` y lee valores por `columnKey`", () => {
    assert.equal(
      formatSqlInserts(duplicadas, { tableName: "cuentas", dialecto: "postgres" }),
      'INSERT INTO "cuentas" ("name", "id", "name") VALUES\n  (\'Banco Uno\', 7, \'Cuenta A\');'
    );
  });

  test("Pandas usa `columnKey` como clave de diccionario Python para no sobrescribir", () => {
    const py = formatPandas(duplicadas);
    assert.ok(py.includes('"name": r"""Banco Uno"""'), py);
    assert.ok(py.includes('"id": 7'), py);
    assert.ok(py.includes('"name_2": r"""Cuenta A"""'), py);
  });
});

describe("extensionForFormat", () => {
  test("devuelve xlsx para el formato Excel (.xlsx)", () => {
    assert.equal(extensionForFormat("xlsx"), "xlsx");
  });
});
