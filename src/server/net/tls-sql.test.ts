import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sslParaDriver } from "./tls-sql";

const dir = mkdtempSync(path.join(os.tmpdir(), "tls-sql-"));
const ca = path.join(dir, "ca.pem");
writeFileSync(ca, "CA");

test("sin TLS no hay ssl", () => {
  assert.equal(sslParaDriver(undefined), undefined);
  assert.equal(sslParaDriver({ mode: "deshabilitado" }), undefined);
});

test("requerido cifra sin validar el certificado", () => {
  assert.deepEqual(sslParaDriver({ mode: "requerido" }), { rejectUnauthorized: false });
});

test("verificar-ca valida contra la CA y respeta serverName", () => {
  const ssl = sslParaDriver({ mode: "verificar-ca", caFile: ca, serverName: "db.local" });
  assert.equal(ssl?.rejectUnauthorized, true);
  assert.equal(ssl?.ca?.toString(), "CA");
  assert.equal(ssl?.servername, "db.local");
});

test("verificar-ca sin CA falla con un mensaje del formulario", () => {
  assert.throws(() => sslParaDriver({ mode: "verificar-ca" }), /falta el archivo de CA/);
});

test("IAM con TLS deshabilitado falla en vez de conectar sin cifrar", () => {
  assert.throws(() => sslParaDriver(undefined, { mode: "iam", region: "us-east-2" }), /IAM: requiere TLS/);
});
