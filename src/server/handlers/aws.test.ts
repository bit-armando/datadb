import { test } from "node:test";
import assert from "node:assert/strict";
import { nombresDePerfilesAws } from "./aws";

test("lista los perfiles de config y credentials sin duplicados ni sesiones SSO", () => {
  const config = "[default]\nregion = us-east-2\n[profile axios-wallet]\nrole_arn = x\n[sso-session corp]\nsso_region = us-east-1\n";
  const credenciales = "[default]\naws_access_key_id = AKIA\n[otro]\n";
  assert.deepEqual(nombresDePerfilesAws(config, credenciales), ["axios-wallet", "default", "otro"]);
});

test("sin archivos no hay perfiles", () => {
  assert.deepEqual(nombresDePerfilesAws("", ""), []);
});
