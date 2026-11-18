/**
 * Fase 80 — los perfiles con TLS y túnel SSH se guardan SIN secretos, y sobreviven a la ida y
 * vuelta por `connections.json`.
 *
 * Mismo patrón que `profiles.test.ts`: directorio temporal y transporte de secretos falso en
 * memoria. Lo que se verifica es la frontera del disco (qué se escribe y qué no) y que los campos
 * nuevos no se pierden al guardar, que es el fallo silencioso clásico de una lista blanca.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "perfiles-mongo-"));
process.env.DATADB_DATA_DIR = dataDir;

const secretos = new Map<string, string>();

let mod: typeof import("./profiles") | undefined;
async function load() {
  if (!mod) {
    const secrets = await import("@/server/secrets-client");
    secrets.setSecretTransport(async (op, name, value) => {
      if (op === "get") return { value: secretos.get(name) ?? null };
      if (op === "has") return { has: secretos.has(name) };
      if (op === "set") {
        secretos.set(name, value ?? "");
        return { has: true };
      }
      secretos.delete(name);
      return { has: false };
    });
    mod = await import("./profiles");
  }
  return mod;
}

test("un perfil de Mongo con TLS y salto SSH se guarda sin contraseñas", async () => {
  const m = await load();
  const perfil = await m.createProfile({
    name: "Mongo producción",
    type: "mongodb",
    host: "mongo.interno",
    port: 27017,
    user: "datadb",
    password: "claveDeLaBase",
    database: "sonda",
    readOnly: false,
    tls: { mode: "verificar-ca", caFile: "/tmp/ca.pem", serverName: "mongo.interno" },
    ssh: { enabled: true, host: "jump.interno", port: 2222, user: "salto", auth: "password" },
    sshPassword: "claveDelSalto",
  });

  const disco = await readFile(path.join(dataDir, "connections.json"), "utf8");
  assert.equal(disco.includes("claveDeLaBase"), false, "la contraseña de la base no va al JSON");
  assert.equal(disco.includes("claveDelSalto"), false, "la contraseña del salto no va al JSON");

  // Los secretos SÍ se guardan, en su propia familia de nombres.
  assert.equal(secretos.get(`db.${perfil.id}`), "claveDeLaBase");
  assert.equal(secretos.get(`ssh.${perfil.id}`), "claveDelSalto");

  // Los archivos de TLS son rutas y sí se persisten: el formulario tiene que poder mostrarlas.
  const json = JSON.parse(disco) as { profiles?: unknown } | unknown[];
  const lista = Array.isArray(json) ? json : ((json as { profiles: unknown[] }).profiles ?? []);
  const guardado = lista.find((p) => (p as { id: string }).id === perfil.id) as Record<string, unknown>;
  assert.deepEqual(
    (guardado.tls as { caFile: string }).caFile,
    "/tmp/ca.pem",
    "la ruta del certificado de CA se conserva"
  );
  assert.equal(((guardado.ssh as { host: string }).host), "jump.interno");

  // Y el perfil en memoria no arrastra los secretos del salto.
  assert.equal((perfil as unknown as Record<string, unknown>).sshPassword, undefined);
});

test("la contraseña del salto se puede releer para conectar", async () => {
  const m = await load();
  const perfil = await m.createProfile({
    name: "Mongo con clave",
    type: "mongodb",
    host: "mongo.interno",
    port: 27017,
    user: "datadb",
    password: "",
    database: "",
    readOnly: false,
    ssh: { enabled: true, host: "jump.interno", port: 22, user: "salto", auth: "key", keyFile: "/k" },
    sshPassphrase: "frase",
  });
  const secretosSsh = await m.getProfileSshSecrets(perfil.id);
  assert.equal(secretosSsh.passphrase, "frase");
  assert.equal(secretosSsh.password, "");
});

test("borrar el perfil borra también los secretos del salto", async () => {
  const m = await load();
  const perfil = await m.createProfile({
    name: "Mongo temporal",
    type: "mongodb",
    host: "h",
    port: 27017,
    user: "u",
    password: "",
    database: "",
    readOnly: false,
    ssh: { enabled: true, host: "j", port: 22, user: "s", auth: "password" },
    sshPassword: "efimera",
  });
  assert.equal(secretos.has(`ssh.${perfil.id}`), true);
  await m.deleteProfile(perfil.id);
  assert.equal(secretos.has(`ssh.${perfil.id}`), false);
  assert.equal(secretos.has(`db.${perfil.id}`), false);
});

test("un perfil IAM guarda región y perfil AWS en disco, sin secretos", async () => {
  const m = await load();
  const perfil = await m.createProfile({
    name: "Aurora IAM",
    type: "postgres",
    host: "x.cluster-abc.us-east-2.rds.amazonaws.com",
    port: 5432,
    user: "iam_user",
    password: "",
    database: "postgres",
    tls: { mode: "requerido" },
    auth: { mode: "iam", region: "us-east-2", awsProfile: "axios-wallet" },
  });
  const guardado = (await m.loadProfiles()).find((p) => p.id === perfil.id);
  assert.deepEqual(guardado?.auth, { mode: "iam", region: "us-east-2", awsProfile: "axios-wallet" });
  assert.equal(secretos.has(`db.${perfil.id}`), false);
});
