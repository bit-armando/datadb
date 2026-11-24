import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { contextoDesdeOrigenes, motivoDeSoloLectura, tieneOrigenes } from "./result-origin";
import { parseSingleTable } from "./sql-parser";
import { origenMysql } from "@/server/db/mysql-types";
import { oidsDeOrigen, origenesPg } from "@/server/db/pg-types";
import type { ColumnMeta, QueryColumn, SchemaNode } from "./types";

/*
  R94 — editar un resultado con JOIN o con alias, como DataGrip. El caso de los tests es el que
  reportó el usuario (2026-10-21): `ficha.id`, `ficha.datetime_deposit` de
  `clients_deposits_clientdeposit ficha` con dos INNER JOIN.
*/

const col = (name: string, isPrimaryKey = false): ColumnMeta => ({
  name,
  type: "int",
  isPrimaryKey,
  nullable: !isPrimaryKey,
});

function esquema(nombre: string, tablas: Record<string, ColumnMeta[]>): SchemaNode {
  return {
    name: nombre,
    tables: Object.entries(tablas).map(([name, columns]) => ({ name, type: "table" as const, columns })),
    routines: [],
    triggers: [],
  };
}

const DEPOSITOS = "clients_deposits_clientdeposit";
const ESQUEMAS: SchemaNode[] = [
  esquema("acme", {
    [DEPOSITOS]: [col("id", true), col("datetime_deposit"), col("plataform_account_id")],
    plataforms_plataform: [col("id", true), col("name")],
  }),
];

const deFicha = (name: string, column = name): QueryColumn => ({
  name,
  type: "int",
  origen: { schema: "acme", table: DEPOSITOS, column },
});

describe("contextoDesdeOrigenes", () => {
  test("el JOIN del usuario: las columnas de ficha se editan y solo se permite UPDATE", () => {
    const columnas = [deFicha("id"), deFicha("datetime_deposit")];
    const ctx = contextoDesdeOrigenes(columnas, ESQUEMAS);
    assert.ok(ctx, "un JOIN cuyas columnas salen de una tabla con su clave tiene que ser editable");
    assert.equal(ctx.schema, "acme");
    assert.equal(ctx.table, DEPOSITOS);
    assert.equal(ctx.pkEnResultado, "id");
    assert.deepEqual(ctx.columnasDelResultado, { id: "id", datetime_deposit: "datetime_deposit" });
    assert.equal(motivoDeSoloLectura("datetime_deposit", ctx, columnas), null);
    assert.match(motivoDeSoloLectura("id", ctx, columnas) ?? "", /clave primaria/);
  });

  test("con columnas de otra tabla del JOIN: esas quedan de solo lectura y no se agregan filas", () => {
    const columnas: QueryColumn[] = [
      deFicha("id"),
      deFicha("datetime_deposit"),
      { name: "name", type: "varchar", origen: { schema: "acme", table: "plataforms_plataform", column: "name" } },
    ];
    const ctx = contextoDesdeOrigenes(columnas, ESQUEMAS);
    assert.equal(ctx?.table, DEPOSITOS, "gana la tabla con más columnas Y su clave en el resultado");
    assert.equal(ctx?.soloActualizar, true);
    assert.match(motivoDeSoloLectura("name", ctx, columnas) ?? "", /no sale de/);
  });

  test("con alias: la clave y la columna se leen con el alias y se escriben con el nombre real", () => {
    const columnas = [deFicha("ficha_id", "id"), deFicha("fecha", "datetime_deposit")];
    const ctx = contextoDesdeOrigenes(columnas, ESQUEMAS);
    assert.equal(ctx?.pkEnResultado, "ficha_id");
    assert.deepEqual(ctx?.columnasDelResultado, { ficha_id: "id", fecha: "datetime_deposit" });
    assert.equal(ctx?.soloActualizar, true, "con alias una fila nueva no casa con la tabla");
  });

  test("sin la clave primaria en el resultado NO hay contexto (no se sabría qué fila actualizar)", () => {
    assert.equal(contextoDesdeOrigenes([deFicha("datetime_deposit")], ESQUEMAS), null);
  });

  test("una clave con nombre repetido en el resultado NO cuenta: el valor de la fila puede ser del otro", () => {
    const columnas: QueryColumn[] = [
      deFicha("id"),
      deFicha("datetime_deposit"),
      { name: "id", type: "int", origen: { schema: "acme", table: "plataforms_plataform", column: "id" } },
    ];
    assert.equal(contextoDesdeOrigenes(columnas, ESQUEMAS), null);
  });

  test("SELECT * de una tabla sola: contexto completo (se pueden agregar filas)", () => {
    const columnas = [deFicha("id"), deFicha("datetime_deposit"), deFicha("plataform_account_id")];
    assert.equal(contextoDesdeOrigenes(columnas, ESQUEMAS)?.soloActualizar, false);
  });

  test("la misma tabla en dos bases y origen sin base: no se adivina", () => {
    const dos = [...ESQUEMAS, esquema("otra", { [DEPOSITOS]: [col("id", true), col("datetime_deposit")] })];
    const sinBase: QueryColumn[] = [
      { name: "id", type: "int", origen: { table: DEPOSITOS, column: "id" } },
      { name: "datetime_deposit", type: "int", origen: { table: DEPOSITOS, column: "datetime_deposit" } },
    ];
    assert.equal(contextoDesdeOrigenes(sinBase, dos), null);
    // Con la base del origen, sí: es la que dijo el servidor.
    assert.equal(contextoDesdeOrigenes([deFicha("id"), deFicha("datetime_deposit")], dos)?.schema, "acme");
  });

  test("tieneOrigenes distingue un resultado con origen (MySQL/Postgres) de uno sin él", () => {
    assert.equal(tieneOrigenes([deFicha("id")]), true);
    assert.equal(tieneOrigenes([{ name: "count", type: "bigint" }]), false);
  });

  test("sin contexto, el motivo de solo lectura lo explica", () => {
    assert.match(motivoDeSoloLectura("x", null, []) ?? "", /clave primaria/);
  });

  test("JOIN con columnas homónimas desambiguadas (`banko.name` + `cuenta.id, cuenta.name`)", () => {
    const esquemasConBanco: SchemaNode[] = [
      esquema("public", {
        banks_bank: [col("id", true), col("name")],
        accounts_account: [col("id", true), col("name"), col("bank_id")],
      }),
    ];
    const columnas: QueryColumn[] = [
      {
        name: "name",
        type: "varchar",
        origen: { schema: "public", table: "banks_bank", column: "name" },
      },
      {
        name: "id",
        type: "int4",
        origen: { schema: "public", table: "accounts_account", column: "id" },
      },
      {
        name: "name",
        key: "name_2",
        type: "varchar",
        origen: { schema: "public", table: "accounts_account", column: "name" },
      },
    ];
    const ctx = contextoDesdeOrigenes(columnas, esquemasConBanco);
    assert.ok(ctx, "cuenta tiene su PK `id` y más columnas");
    assert.equal(ctx.table, "accounts_account");
    assert.equal(ctx.pkEnResultado, "id");
    assert.deepEqual(ctx.columnasDelResultado, { id: "id", name_2: "name" });
    assert.equal(ctx.soloActualizar, true);
    assert.equal(motivoDeSoloLectura("name_2", ctx, columnas), null);
    assert.match(motivoDeSoloLectura("name", ctx, columnas) ?? "", /no sale de accounts_account/);
  });

  test("la misma columna real repetida dentro de la misma tabla se excluye de edición y de PK", () => {
    const columnas: QueryColumn[] = [
      deFicha("id"),
      { ...deFicha("id"), key: "id_2" },
      deFicha("datetime_deposit"),
    ];
    assert.equal(contextoDesdeOrigenes(columnas, ESQUEMAS), null);

    const conOtraRepetida: QueryColumn[] = [
      deFicha("id"),
      deFicha("datetime_deposit"),
      { ...deFicha("datetime_deposit"), key: "datetime_deposit_2" },
    ];
    const ctx = contextoDesdeOrigenes(conOtraRepetida, ESQUEMAS);
    assert.ok(ctx);
    assert.deepEqual(ctx.columnasDelResultado, { id: "id" });
    assert.match(motivoDeSoloLectura("datetime_deposit_2", ctx, conOtraRepetida) ?? "", /no sale de/);
  });
});

describe("origen en los drivers", () => {
  test("MySQL: orgTable/orgName/db, sin alias; una expresión no tiene origen", () => {
    assert.deepEqual(
      origenMysql({ db: "acme", orgTable: DEPOSITOS, orgName: "datetime_deposit" }),
      { origen: { schema: "acme", table: DEPOSITOS, column: "datetime_deposit" } }
    );
    assert.deepEqual(origenMysql({ db: "acme", orgTable: "", orgName: "" }), {});
  });

  test("Postgres: (tableID, columnID) contra el catálogo; tableID 0 es una expresión", () => {
    const campos = [
      { tableID: 16384, columnID: 1 },
      { tableID: 0, columnID: 0 },
      { tableID: 16384, columnID: 2 },
    ];
    assert.deepEqual(oidsDeOrigen(campos), [16384]);
    const filas = [
      { oid: 16384, attnum: 1, esquema: "public", tabla: "clientes", columna: "id" },
      { oid: 16384, attnum: 2, esquema: "public", tabla: "clientes", columna: "nombre" },
    ];
    assert.deepEqual(origenesPg(campos, filas), [
      { schema: "public", table: "clientes", column: "id" },
      undefined,
      { schema: "public", table: "clientes", column: "nombre" },
    ]);
  });
});

describe("parseSingleTable con alias (R94)", () => {
  test("FROM tabla alias y FROM tabla AS alias dan la tabla, sin el alias", () => {
    assert.deepEqual(parseSingleTable(`SELECT * FROM ${DEPOSITOS} ficha WHERE ficha.id = 1`), { table: DEPOSITOS });
    assert.deepEqual(parseSingleTable("select * from public.clientes AS c"), { schema: "public", table: "clientes" });
    assert.deepEqual(parseSingleTable('select * from "mi tabla"'), { table: "mi tabla" });
    assert.deepEqual(parseSingleTable('select * from "mi tabla" t'), { table: "mi tabla" });
  });
});
