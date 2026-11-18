import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConnectionProfile } from "@/lib/types";
import { PostgresDriver } from "./postgres";
import { MysqlDriver } from "./mysql";

const base = (type: "postgres" | "mysql", extra: Partial<ConnectionProfile> = {}): ConnectionProfile => ({
  id: "1",
  name: "Aurora",
  type,
  host: "x.cluster-abc.us-east-2.rds.amazonaws.com",
  port: 0,
  user: "iam_user",
  password: "",
  database: "app",
  tls: { mode: "requerido" },
  auth: { mode: "iam", region: "us-east-2" },
  ...extra,
});

test("PostgreSQL con IAM pide la contraseña como función y usa TLS", async () => {
  const driver = new PostgresDriver(base("postgres"));
  const opciones = (driver as unknown as { pool: { options: { password: unknown; ssl: unknown } } }).pool.options;
  assert.equal(typeof opciones.password, "function");
  assert.deepEqual(opciones.ssl, { rejectUnauthorized: false });
  await driver.close();
});

test("PostgreSQL sin IAM sigue con la contraseña de siempre", async () => {
  const driver = new PostgresDriver(base("postgres", { auth: undefined, password: "clave", tls: undefined }));
  const opciones = (driver as unknown as { pool: { options: { password: unknown; ssl: unknown } } }).pool.options;
  assert.equal(opciones.password, "clave");
  assert.equal(opciones.ssl, undefined);
  await driver.close();
});

test("MySQL con IAM registra el plugin mysql_clear_password y TLS", async () => {
  const driver = new MysqlDriver(base("mysql"));
  const cfg = (driver as unknown as { pool: { pool: { config: { connectionConfig: Record<string, unknown> } } } }).pool.pool.config.connectionConfig;
  assert.equal(typeof (cfg.authPlugins as Record<string, unknown>).mysql_clear_password, "function");
  assert.ok(cfg.ssl);
  await driver.close();
});

test("IAM sin TLS no crea el driver", () => {
  assert.throws(() => new PostgresDriver(base("postgres", { tls: undefined })), /IAM: requiere TLS/);
  assert.throws(() => new MysqlDriver(base("mysql", { tls: undefined })), /IAM: requiere TLS/);
});
