/**
 * Perfiles de conexión en `connections.json` (fase 17, R6/R7).
 *
 * REGLA DE LA FASE (`.hermes.md` § Seguridad, R6): **el archivo no contiene contraseñas**. Guarda
 * nombre, motor, host, puerto, usuario, base, color, solo-lectura y un booleano `hasPassword`; el
 * valor vive cifrado en `data/secrets.json` bajo `db.<id del perfil>` (almacén de la fase 25, con
 * `safeStorage`). Si el cifrado del SO no está disponible, `setSecret` falla y la operación entera
 * falla: nunca se cae a texto plano.
 *
 * Qué se rompería si se dejara el campo `password` «por compatibilidad»: el JSON seguiría siendo la
 * fuente de verdad para alguien, y la próxima lectura volvería a usarlo. Por eso al leer se DESCARTA
 * el campo si apareciera, y la migración (`migratePlaintextPasswords`) lo cifra y lo borra.
 *
 * R7: la migración corre UNA vez al arrancar el worker. Un `connections.json` de antes de esta fase
 * tiene `password` con texto plano: se cifra en el almacén, se borra del JSON y se reescribe. Es
 * idempotente (sin `password` no hace nada) y no pide nada al usuario: la app conecta igual.
 */
import { promises as fs } from "node:fs";
import type { ConnectionProfile, ConnectionProfileInput } from "@/lib/types";
// Fase 5 (R2): el directorio de datos lo resuelve el único módulo src/server/data-dir.ts.
import { DATA_DIR, dataPath } from "./data-dir";
import { normalizarAuth } from "@/shared/connection-net";
import { dbSecretName, sshPassphraseSecretName, sshPasswordSecretName } from "@/shared/secrets";
import { deleteSecret, getSecret, setSecret } from "./secrets-client";

const PROFILES_PATH = dataPath("connections");

/**
 * Lo que se devuelve a la UI: sin contraseña y con `hasPassword`, que es lo único que el formulario
 * necesita para saber si hay una guardada (y poder decir «Dejar en blanco para mantener la actual»).
 */
export function sanitizeProfile(profile: ConnectionProfile): ConnectionProfile {
  return { ...profile, password: "", hasPassword: profile.hasPassword ?? false };
}

/**
 * Perfil tal como vive en disco: SIN el campo `password` (no vacío: ausente) y con el sello
 * `hasPassword`. Que la clave no exista es lo que hace imposible que alguien la lea por accidente.
 */
type StoredProfile = Omit<ConnectionProfile, "password">;

function toStored(profile: ConnectionProfile): StoredProfile {
  // Se reconstruye por lista blanca, no por descarte: si mañana alguien añade al tipo un campo con
  // un secreto, no se cuela en el JSON por olvido.
  const auth = normalizarAuth(profile.auth);
  return {
    id: profile.id,
    name: profile.name,
    type: profile.type,
    host: profile.host,
    port: profile.port,
    user: profile.user,
    hasPassword: Boolean(profile.hasPassword),
    database: profile.database,
    color: profile.color,
    readOnly: profile.readOnly,
    // Fase 80: TLS y túnel. Solo rutas y banderas; las contraseñas viven en el almacén.
    ...(profile.tls ? { tls: profile.tls } : {}),
    ...(auth ? { auth } : {}),
    ...(profile.ssh
      ? {
          ssh: {
            enabled: profile.ssh.enabled,
            host: profile.ssh.host,
            port: profile.ssh.port,
            user: profile.ssh.user,
            auth: profile.ssh.auth,
            ...(profile.ssh.keyFile ? { keyFile: profile.ssh.keyFile } : {}),
            hasPassword: Boolean(profile.ssh.hasPassword),
            hasPassphrase: Boolean(profile.ssh.hasPassphrase),
          },
        }
      : {}),
  };
}

export async function loadProfiles(): Promise<ConnectionProfile[]> {
  try {
    const raw = await fs.readFile(PROFILES_PATH, "utf-8");
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter(
          (p): p is ConnectionProfile =>
            !!p && typeof p === "object" && "id" in p && "type" in p && "host" in p
        )
        // Un `password` que se colara (JSON viejo, edición a mano) NO se propaga al resto del
        // servidor: se ignora aquí y lo cifra la migración del arranque.
        .map((p) => ({ ...p, password: "" }));
    }
    return [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function saveProfiles(profiles: ConnectionProfile[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${PROFILES_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(profiles.map(toStored), null, 2));
  await fs.rename(tmp, PROFILES_PATH);
}

export async function createProfile(
  input: ConnectionProfileInput
): Promise<ConnectionProfile> {
  const profiles = await loadProfiles();
  const id = crypto.randomUUID();
  const profile: ConnectionProfile = {
    ...input,
    id,
    // La contraseña va al almacén cifrado ANTES de escribir el perfil: si el cifrado falla, no
    // queda un perfil guardado que no puede conectar (falla la operación entera).
    password: "",
    hasPassword: Boolean(input.password),
  };
  if (input.password) await setSecret(dbSecretName(id), input.password);
  /*
   * Fase 80: `...input` traería las contraseñas del salto al objeto que se devuelve al renderer.
   * Se borran en el acto: quedan solo en el almacén cifrado, igual que `password`.
   */
  delete profile.sshPassword;
  delete profile.sshPassphrase;
  // Fase 80: los secretos del salto SSH van al mismo almacén cifrado, con su propio nombre.
  if (input.sshPassword) await setSecret(sshPasswordSecretName(id), input.sshPassword);
  if (input.sshPassphrase) await setSecret(sshPassphraseSecretName(id), input.sshPassphrase);
  if (profile.ssh) {
    profile.ssh = {
      ...profile.ssh,
      hasPassword: Boolean(input.sshPassword) || Boolean(profile.ssh.hasPassword),
      hasPassphrase: Boolean(input.sshPassphrase) || Boolean(profile.ssh.hasPassphrase),
    };
  }
  profiles.push(profile);
  await saveProfiles(profiles);
  return profile;
}

export async function deleteProfile(id: string): Promise<void> {
  const profiles = await loadProfiles();
  const index = profiles.findIndex((p) => p.id === id);
  if (index === -1) {
    throw new Error("Profile not found");
  }
  profiles.splice(index, 1);
  await saveProfiles(profiles);
  // El secreto se borra DESPUÉS del JSON: si el borrado del secreto fallara, el perfil ya no
  // existe y no hay forma de usarlo; al revés quedaría un perfil mudo.
  await deleteSecret(dbSecretName(id));
  await deleteSecret(sshPasswordSecretName(id));
  await deleteSecret(sshPassphraseSecretName(id));
}

export async function updateProfile(
  id: string,
  input: ConnectionProfileInput
): Promise<ConnectionProfile> {
  const profiles = await loadProfiles();
  const index = profiles.findIndex((p) => p.id === id);
  if (index === -1) {
    throw new Error("Profile not found");
  }
  const existing = profiles[index];
  const profile: ConnectionProfile = {
    ...existing,
    ...input,
    id,
    password: "",
    // El formulario de edición llega con la contraseña vacía cuando el usuario no escribió una
    // nueva: se conserva la guardada en el almacén (y su `hasPassword`).
    hasPassword: input.password ? true : existing.hasPassword,
  };
  if (input.password) await setSecret(dbSecretName(id), input.password);
  if (input.sshPassword) await setSecret(sshPasswordSecretName(id), input.sshPassword);
  if (input.sshPassphrase) await setSecret(sshPassphraseSecretName(id), input.sshPassphrase);
  delete profile.sshPassword;
  delete profile.sshPassphrase;
  if (profile.ssh) {
    profile.ssh = {
      ...profile.ssh,
      hasPassword: Boolean(input.sshPassword) || Boolean(existing.ssh?.hasPassword),
      hasPassphrase: Boolean(input.sshPassphrase) || Boolean(existing.ssh?.hasPassphrase),
    };
  }
  profiles[index] = profile;
  await saveProfiles(profiles);
  return profile;
}

/**
 * Contraseña descifrada de un perfil, para el momento de conectar. Único punto que lee el secreto.
 *
 * Devuelve `""` si no hay nada guardado (un perfil con autenticación de confianza, p. ej. `peer` en
 * Postgres local): no es un error y el driver debe intentar conectar sin contraseña.
 */
export async function getProfilePassword(profileId: string): Promise<string> {
  const value = await getSecret(dbSecretName(profileId));
  return value ?? "";
}

/**
 * R7 — migración ÚNICA de las contraseñas en claro que dejó la versión anterior.
 *
 * Lee el archivo CRUDO (no `loadProfiles`, que ya descarta el campo), cifra cada `password` que
 * encuentre bajo `db.<id>` y reescribe el JSON sin el campo. Idempotente: cuando no queda ninguna,
 * no hace nada. Devuelve cuántas migró para que el arranque lo pueda loguear (sin el valor, nunca).
 *
 * Si el cifrado no está disponible, LANZA: es preferible que la app diga que no puede guardar
 * credenciales a que siga arrancando con contraseñas en claro sin que nadie lo note.
 */
export async function migratePlaintextPasswords(): Promise<number> {
  let raw: string;
  try {
    raw = await fs.readFile(PROFILES_PATH, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  if (!raw.trim()) return 0;

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return 0;

  const conClave = parsed.filter(
    (p): p is Record<string, unknown> =>
      !!p &&
      typeof p === "object" &&
      typeof (p as Record<string, unknown>).password === "string" &&
      Boolean((p as Record<string, unknown>).password) &&
      typeof (p as Record<string, unknown>).id === "string"
  );

  if (conClave.length === 0) {
    // Sin contraseñas en claro. Pero el archivo puede no tener `hasPassword` todavía: se reescribe
    // una vez para dejarlo coherente (y sin el campo `password` si venía vacío).
    const necesitaSello = parsed.some(
      (p) => !!p && typeof p === "object" && !("hasPassword" in (p as Record<string, unknown>))
    );
    if (necesitaSello) await saveProfiles(parsed as ConnectionProfile[]);
    return 0;
  }

  for (const perfil of conClave) {
    const id = String(perfil.id);
    await setSecret(dbSecretName(id), String(perfil.password)); // lanza si el SO no puede cifrar
    perfil.hasPassword = true;
    perfil.password = "";
  }
  await saveProfiles(parsed as ConnectionProfile[]);
  return conClave.length;
}

/**
 * Secretos del salto SSH de un perfil, descifrados justo antes de conectar (fase 80). Devuelve
 * cadenas vacías si no hay nada guardado: un salto con clave sin frase de paso es válido, y uno con
 * autenticación por `agent` no necesita contraseña.
 */
export async function getProfileSshSecrets(
  profileId: string
): Promise<{ password: string; passphrase: string }> {
  const [password, passphrase] = await Promise.all([
    getSecret(sshPasswordSecretName(profileId)).catch(() => ""),
    getSecret(sshPassphraseSecretName(profileId)).catch(() => ""),
  ]);
  return { password: password ?? "", passphrase: passphrase ?? "" };
}
