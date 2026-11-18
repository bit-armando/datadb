import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConnectionProfile } from "@/lib/types";
import { generarTokenIam, type PeticionToken } from "./rds-iam";

const perfil = (extra: Partial<ConnectionProfile> = {}): ConnectionProfile => ({
  id: "1",
  name: "Aurora",
  type: "postgres",
  host: "x.cluster-abc.us-east-2.rds.amazonaws.com",
  port: 0,
  user: "iam_user",
  password: "",
  database: "postgres",
  auth: { mode: "iam", region: "us-east-2", awsProfile: "axios-wallet" },
  ...extra,
});

test("firma con el host real, el puerto por defecto del motor y el perfil AWS", async () => {
  let recibida: PeticionToken | undefined;
  const token = await generarTokenIam(perfil(), async (p) => ((recibida = p), "tok"));
  assert.equal(token, "tok");
  assert.deepEqual(recibida, {
    hostname: "x.cluster-abc.us-east-2.rds.amazonaws.com",
    port: 5432,
    username: "iam_user",
    region: "us-east-2",
    profile: "axios-wallet",
  });
});

test("MySQL firma con el puerto 3306", async () => {
  let puerto = 0;
  await generarTokenIam(perfil({ type: "mysql" }), async (p) => ((puerto = p.port), "tok"));
  assert.equal(puerto, 3306);
});

test("una sesión SSO vencida pide aws sso login", async () => {
  await assert.rejects(
    generarTokenIam(perfil(), async () => Promise.reject(new Error("The SSO session token is expired"))),
    /aws sso login --profile axios-wallet/
  );
});

test("un perfil sin IAM no firma", async () => {
  await assert.rejects(generarTokenIam(perfil({ auth: undefined }), async () => "tok"), /no usa autenticación IAM/);
});
