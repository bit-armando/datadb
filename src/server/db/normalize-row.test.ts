import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { QueryColumn } from "@/lib/types";
import { normalizeArrayRow } from "./normalize-row";

describe("normalizeArrayRow", () => {
  test("conserva valores distintos cuando hay columnas con el mismo `name`", () => {
    const columns: QueryColumn[] = [
      { name: "name", type: "varchar" },
      { name: "id", type: "int4" },
      { name: "name", key: "name_2", type: "varchar" },
    ];
    const row = normalizeArrayRow(["Banco Central", 42, "Cuenta Nómina"], columns, (b) => b.toString("hex"));
    assert.deepEqual(row, {
      name: "Banco Central",
      id: 42,
      name_2: "Cuenta Nómina",
    });
  });

  test("convierte Date a ISO y maneja Date inválido como null", () => {
    const columns: QueryColumn[] = [
      { name: "created_at", type: "timestamptz" },
      { name: "broken_at", type: "timestamptz" },
    ];
    const valid = new Date("2026-05-01T12:30:00.000Z");
    const invalid = new Date("invalid-date");
    const row = normalizeArrayRow([valid, invalid], columns, (b) => b.toString("hex"));
    assert.equal(row.created_at, "2026-05-01T12:30:00.000Z");
    assert.equal(row.broken_at, null);
  });

  test("formatea Buffer usando el formateador binario (Postgres `\\\\x` vs hex)", () => {
    const columns: QueryColumn[] = [{ name: "payload", type: "bytea" }];
    const buf = Buffer.from([0xde, 0xad, 0xbe, 0xef]);

    const pgRow = normalizeArrayRow([buf], columns, (b) => `\\x${b.toString("hex")}`);
    assert.equal(pgRow.payload, "\\xdeadbeef");

    const mysqlRow = normalizeArrayRow([buf], columns, (b) => b.toString("hex"));
    assert.equal(mysqlRow.payload, "deadbeef");
  });

  test("preserva null, undefined y objetos JSON", () => {
    const columns: QueryColumn[] = [
      { name: "a", type: "text" },
      { name: "b", type: "text" },
      { name: "meta", type: "jsonb" },
    ];
    const meta = { ok: true, tags: ["x", "y"] };
    const row = normalizeArrayRow([null, undefined, meta], columns, (b) => b.toString("hex"));
    assert.equal(row.a, null);
    assert.equal(row.b, undefined);
    assert.deepEqual(row.meta, meta);
  });
});
