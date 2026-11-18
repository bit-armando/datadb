import { Signer } from "@aws-sdk/rds-signer";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import type { ConnectionProfile } from "@/lib/types";
import { normalizarAuth, PUERTO_POR_MOTOR } from "@/shared/connection-net";

export interface PeticionToken {
  hostname: string;
  port: number;
  username: string;
  region: string;
  profile?: string;
}

export type Firmador = (peticion: PeticionToken) => Promise<string>;

const firmarConSdk: Firmador = ({ profile, ...peticion }) =>
  new Signer({ ...peticion, credentials: fromNodeProviderChain(profile ? { profile } : {}) }).getAuthToken();

/** Token de RDS IAM (15 min, solo sirve para abrir la conexión). Se firma con el host real, no el del túnel. */
export async function generarTokenIam(config: ConnectionProfile, firmar: Firmador = firmarConSdk): Promise<string> {
  const auth = normalizarAuth(config.auth);
  if (!auth) throw new Error("El perfil no usa autenticación IAM");
  try {
    return await firmar({
      hostname: config.host,
      port: config.port || PUERTO_POR_MOTOR[config.type],
      username: config.user,
      region: auth.region,
      profile: auth.awsProfile,
    });
  } catch (err) {
    const motivo = err instanceof Error ? err.message : String(err);
    if (/sso|token is expired|expired/i.test(motivo)) {
      const perfil = auth.awsProfile ? ` --profile ${auth.awsProfile}` : "";
      throw new Error(`La sesión de AWS venció: corre \`aws sso login${perfil}\``);
    }
    throw new Error(`No se pudo firmar el token IAM: ${motivo}`);
  }
}
