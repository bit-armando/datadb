import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { assignUniqueColumnKeys, columnKey } from "./query-columns";
import type { QueryColumn } from "./types";

describe("columnKey", () => {
  test("devuelve `name` cuando `key` es undefined", () => {
    assert.equal(columnKey({ name: "id" }), "id");
  });

  test("devuelve `key` cuando está presente", () => {
    assert.equal(columnKey({ name: "name", key: "name_2" }), "name_2");
  });
});

describe("assignUniqueColumnKeys", () => {
  test("columnas únicas no reciben `key`", () => {
    const input: QueryColumn[] = [
      { name: "id", type: "int4" },
      { name: "name", type: "text" },
      { name: "email", type: "text" },
    ];
    const result = assignUniqueColumnKeys(input);
    assert.deepEqual(result, input);
    assert.equal("key" in result[0], false);
    assert.equal("key" in result[1], false);
    assert.equal("key" in result[2], false);
  });

  test("duplicados estilo `banko.name, cuenta.*` desambiguan desde la segunda ocurrencia", () => {
    const input: QueryColumn[] = [
      { name: "name", type: "varchar" },
      { name: "id", type: "int4" },
      { name: "name", type: "varchar" },
    ];
    const result = assignUniqueColumnKeys(input);
    assert.equal(result[0].key, undefined);
    assert.equal(result[1].key, undefined);
    assert.equal(result[2].key, "name_2");
    assert.deepEqual(result.map(columnKey), ["name", "id", "name_2"]);
  });

  test("evita colisión con una columna existente llamada `name_2`", () => {
    const input: QueryColumn[] = [
      { name: "name", type: "text" },
      { name: "name_2", type: "text" },
      { name: "name", type: "text" },
    ];
    const result = assignUniqueColumnKeys(input);
    assert.equal(result[0].key, undefined);
    assert.equal(result[1].key, undefined);
    assert.equal(result[2].key, "name_3");
    assert.deepEqual(result.map(columnKey), ["name", "name_2", "name_3"]);
  });

  test("3+ duplicados reciben sufijos consecutivos", () => {
    const input: QueryColumn[] = [
      { name: "id", type: "int4" },
      { name: "id", type: "int4" },
      { name: "id", type: "int4" },
      { name: "id", type: "int4" },
    ];
    const result = assignUniqueColumnKeys(input);
    assert.deepEqual(result.map(columnKey), ["id", "id_2", "id_3", "id_4"]);
  });

  test("nombres vacíos duplicados también se desambiguan", () => {
    const input: QueryColumn[] = [
      { name: "", type: "text" },
      { name: "", type: "text" },
    ];
    const result = assignUniqueColumnKeys(input);
    assert.equal(result[0].key, undefined);
    assert.equal(result[1].key, "_2");
    assert.deepEqual(result.map(columnKey), ["", "_2"]);
  });

  test("preserva metadatos `origen` y `type`", () => {
    const origen1 = { schema: "public", table: "banks_bank", column: "name" };
    const origen2 = { schema: "public", table: "accounts_account", column: "name" };
    const input: QueryColumn[] = [
      { name: "name", type: "varchar", origen: origen1 },
      { name: "name", type: "text", origen: origen2 },
    ];
    const result = assignUniqueColumnKeys(input);
    assert.deepEqual(result[0], { name: "name", type: "varchar", origen: origen1 });
    assert.deepEqual(result[1], { name: "name", key: "name_2", type: "text", origen: origen2 });
  });
});
