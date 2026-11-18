import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claveDeRed,
  normalizarAuth,
  normalizarSsh,
  normalizarTls,
  problemasDeRed,
  regionDeHost,
  PUERTO_POR_MOTOR,
} from "./connection-net";

test("un perfil viejo, sin tls ni ssh, queda deshabilitado en los dos", () => {
  assert.deepEqual(normalizarTls(undefined), { mode: "deshabilitado" });
  assert.deepEqual(normalizarSsh(undefined), {
    enabled: false,
    host: "",
    port: 22,
    user: "",
    auth: "password",
  });
});

test("un modo de TLS inventado no cifra a medias: cae a deshabilitado", () => {
  assert.equal(normalizarTls({ mode: "a-medias" }).mode, "deshabilitado");
  assert.equal(normalizarTls({ mode: "mutuo", caFile: " ca.pem ", keyFile: "k.pem", certFile: "c.pem" }).caFile, "ca.pem");
});

test("apagar SSH borra host y usuario: no quedan restos en el JSON", () => {
  assert.deepEqual(normalizarSsh({ enabled: false, host: "jump", user: "yo" }), {
    enabled: false,
    host: "",
    port: 22,
    user: "",
    auth: "password",
  });
});

test("el puerto de SSH se acota: basura vuelve a 22", () => {
  assert.equal(normalizarSsh({ enabled: true, host: "h", user: "u", port: "abc" }).port, 22);
  assert.equal(normalizarSsh({ enabled: true, host: "h", user: "u", port: 0 }).port, 22);
  assert.equal(normalizarSsh({ enabled: true, host: "h", user: "u", port: 70000 }).port, 22);
  assert.equal(normalizarSsh({ enabled: true, host: "h", user: "u", port: "2222" }).port, 2222);
});

test("los sellos de secretos de SSH sobreviven a la normalización", () => {
  const s = normalizarSsh({ enabled: true, host: "h", user: "u", auth: "key", keyFile: "id", hasPassphrase: true });
  assert.equal(s.hasPassphrase, true);
  assert.equal(s.hasPassword, false);
  assert.equal(s.keyFile, "id");
});

test("faltantes de configuración se nombran antes de conectar", () => {
  assert.deepEqual(
    problemasDeRed({ mode: "verificar-ca" }, { enabled: true, host: "", port: 22, user: "", auth: "key" }),
    ["TLS: falta el archivo de CA", "SSH: falta el host del salto", "SSH: falta el usuario del salto", "SSH: falta la clave privada"]
  );
  assert.deepEqual(
    problemasDeRed({ mode: "verificar-ca", caFile: "ca.pem" }, { enabled: true, host: "j", port: 22, user: "u", auth: "password" }),
    []
  );
  assert.deepEqual(problemasDeRed({ mode: "requerido" }, undefined), []);
});

test("la caché de drivers separa cifrado de no cifrado y con túnel de sin túnel", () => {
  const a = claveDeRed(undefined, undefined);
  const b = claveDeRed({ mode: "requerido" }, undefined);
  const c = claveDeRed({ mode: "requerido" }, { enabled: true, host: "j", port: 22, user: "u", auth: "password" });
  assert.notEqual(a, b);
  assert.notEqual(b, c);
  assert.equal(c, claveDeRed({ mode: "requerido" }, { enabled: true, host: "j", port: 22, user: "u", auth: "password" }));
});

test("MongoDB tiene su puerto por defecto", () => {
  assert.equal(PUERTO_POR_MOTOR.mongodb, 27017);
});

test("normalizarAuth solo reconoce IAM y descarta basura", () => {
  assert.equal(normalizarAuth(undefined), undefined);
  assert.equal(normalizarAuth({ mode: "password" }), undefined);
  assert.deepEqual(normalizarAuth({ mode: "iam", region: " us-east-2 ", awsProfile: "", x: 1 }), { mode: "iam", region: "us-east-2" });
  assert.deepEqual(normalizarAuth({ mode: "iam", region: "us-east-2", awsProfile: "axios-wallet" }), {
    mode: "iam",
    region: "us-east-2",
    awsProfile: "axios-wallet",
  });
});

test("regionDeHost lee la región de clusters, instancias y proxies de RDS", () => {
  assert.equal(regionDeHost("x.cluster-abc.us-east-2.rds.amazonaws.com"), "us-east-2");
  assert.equal(regionDeHost("x.proxy-abc.ap-southeast-1.rds.amazonaws.com"), "ap-southeast-1");
  assert.equal(regionDeHost("x.abc.us-gov-west-1.rds.amazonaws.com"), "us-gov-west-1");
  assert.equal(regionDeHost("db.miempresa.com"), "");
});

test("IAM exige región y TLS; la clave de caché distingue la autenticación", () => {
  const iam = { mode: "iam" as const, region: "" };
  assert.deepEqual(problemasDeRed({ mode: "deshabilitado" }, undefined, iam), ["IAM: falta la región", "IAM: requiere TLS"]);
  assert.deepEqual(problemasDeRed({ mode: "requerido" }, undefined, { ...iam, region: "us-east-2" }), []);
  assert.notEqual(claveDeRed(undefined, undefined, iam), claveDeRed(undefined, undefined));
});
