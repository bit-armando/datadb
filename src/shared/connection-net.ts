/**
 * TLS y túnel SSH de una conexión — modelo compartido por el renderer y el worker.
 *
 * POR QUÉ EXISTE: el usuario conecta su MongoDB con **TLS con archivos** (CA, y certificado/clave de
 * cliente si hay autenticación mutua) y **a través de un proxy SSH**, además de usuario/contraseña
 * normales. Hasta ahora el perfil solo tenía host, puerto, usuario y base: no había dónde declarar
 * ni un certificado ni un salto SSH, y los drivers no sabían usarlos.
 *
 * DECISIONES:
 * - Las rutas a los archivos viven en `connections.json`; el CONTENIDO no. Son rutas, no secretos,
 *   y el usuario quiere poder verlas/editarlas en el formulario. Los archivos se leen en el worker
 *   justo antes de conectar.
 * - Las contraseñas (la de Mongo y la del SSH, más la frase de paso de la clave) NO van al JSON:
 *   viven cifradas en el almacén de secretos, igual que `db.<id>` (fase 17). Aquí solo hay un
 *   booleano por cada una para que el formulario sepa si hay algo guardado.
 * - Todo se normaliza: un perfil viejo (sin `tls` ni `ssh`) sigue siendo válido, y un JSON editado a
 *   mano con basura no rompe la conexión — se cae a los valores por defecto.
 */

/** Motor de la conexión. `mongodb` entra con esta fase; el resto ya existía. */
export type MotorDeConexion = "postgres" | "mysql" | "sqlserver" | "mongodb";

/**
 * Modo de TLS, con los mismos nombres que usan los formularios de Mongo:
 *  - `deshabilitado`: sin TLS.
 *  - `requerido`: cifra, pero NO valida el certificado del servidor (equivalente a `tls=true` sin
 *    `tlsCAFile`). Sirve para servidores con certificado autofirmado.
 *  - `verificar-ca`: cifra y valida contra la CA indicada (`tlsCAFile`). Es el modo recomendado.
 *  - `mutuo`: además presenta certificado y clave de cliente (mTLS, como hace Atlas).
 */
export type ModoTls = "deshabilitado" | "requerido" | "verificar-ca" | "mutuo";

export interface TlsConfig {
  mode: ModoTls;
  /** Ruta al certificado de la CA (PEM). Obligatorio en `verificar-ca` y `mutuo`. */
  caFile?: string;
  /** Ruta al certificado de cliente (PEM). Obligatorio en `mutuo`. */
  certFile?: string;
  /** Ruta a la clave privada del cliente (PEM). Obligatorio en `mutuo`. */
  keyFile?: string;
  /** Nombre contra el que se valida el certificado, si difiere del host (SNI). */
  serverName?: string;
}

export interface SshConfig {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  /** Cómo se autentica el salto: contraseña o clave privada. */
  auth: "password" | "key";
  /** Ruta a la clave privada cuando `auth === "key"`. */
  keyFile?: string;
  /** Sello: hay contraseña de SSH guardada (cifrada) para este perfil. */
  hasPassword?: boolean;
  /** Sello: hay frase de paso de la clave guardada (cifrada) para este perfil. */
  hasPassphrase?: boolean;
}

/** `iam`: el token de RDS reemplaza la contraseña; las credenciales salen de la cadena estándar de AWS. */
export interface AuthConfig {
  mode: "iam";
  region: string;
  awsProfile?: string;
}

export const TLS_POR_DEFECTO: TlsConfig = { mode: "deshabilitado" };

export const SSH_POR_DEFECTO: SshConfig = {
  enabled: false,
  host: "",
  port: 22,
  user: "",
  auth: "password",
};

/** Puerto por defecto de cada motor, para el formulario. */
export const PUERTO_POR_MOTOR: Record<MotorDeConexion, number> = {
  postgres: 5432,
  mysql: 3306,
  sqlserver: 1433,
  mongodb: 27017,
};

export const ETIQUETA_DE_MOTOR: Record<MotorDeConexion, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  sqlserver: "SQL Server",
  mongodb: "MongoDB",
};

const MODOS_TLS: readonly ModoTls[] = ["deshabilitado", "requerido", "verificar-ca", "mutuo"];

const texto = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * Normaliza TLS. Un perfil sin `tls` (todos los de antes de esta fase) queda en «deshabilitado», y
 * un modo desconocido también: es preferible no cifrar a fingir que se cifra con una opción que el
 * driver no entiende.
 */
export function normalizarTls(entrada: unknown): TlsConfig {
  if (!entrada || typeof entrada !== "object") return { ...TLS_POR_DEFECTO };
  const t = entrada as Record<string, unknown>;
  const modo = MODOS_TLS.includes(t.mode as ModoTls) ? (t.mode as ModoTls) : "deshabilitado";
  if (modo === "deshabilitado") return { ...TLS_POR_DEFECTO };
  const cfg: TlsConfig = { mode: modo };
  const ca = texto(t.caFile);
  const cert = texto(t.certFile);
  const key = texto(t.keyFile);
  const serverName = texto(t.serverName);
  if (ca) cfg.caFile = ca;
  if (cert) cfg.certFile = cert;
  if (key) cfg.keyFile = key;
  if (serverName) cfg.serverName = serverName;
  return cfg;
}

/** `undefined` = usuario y contraseña de siempre. */
export function normalizarAuth(entrada: unknown): AuthConfig | undefined {
  if (!entrada || typeof entrada !== "object") return undefined;
  const a = entrada as Record<string, unknown>;
  if (a.mode !== "iam") return undefined;
  const awsProfile = texto(a.awsProfile);
  return { mode: "iam", region: texto(a.region), ...(awsProfile ? { awsProfile } : {}) };
}

/** Región de un endpoint de RDS/Aurora/Proxy; "" si el host no es de AWS (dominio propio). */
export function regionDeHost(host: string): string {
  return /\.([a-z]{2}(?:-[a-z]+)+-\d)\.rds\.amazonaws\.com(?:\.cn)?$/.exec(host.trim().toLowerCase())?.[1] ?? "";
}

/**
 * Normaliza SSH. Si `enabled` es falso se devuelve el objeto por defecto (sin host ni usuario), para
 * que apagar el túnel no deje datos a medio llenar en el JSON.
 */
export function normalizarSsh(entrada: unknown): SshConfig {
  if (!entrada || typeof entrada !== "object") return { ...SSH_POR_DEFECTO };
  const s = entrada as Record<string, unknown>;
  if (s.enabled !== true) return { ...SSH_POR_DEFECTO };
  const puerto = Number(s.port);
  return {
    enabled: true,
    host: texto(s.host),
    port: Number.isFinite(puerto) && puerto > 0 && puerto < 65536 ? Math.floor(puerto) : 22,
    user: texto(s.user),
    auth: s.auth === "key" ? "key" : "password",
    ...(texto(s.keyFile) ? { keyFile: texto(s.keyFile) } : {}),
    hasPassword: s.hasPassword === true,
    hasPassphrase: s.hasPassphrase === true,
  };
}

/**
 * Errores de configuración que impiden conectar, en el idioma del formulario. Se comprueba ANTES de
 * abrir nada: un modo «verificar-ca» sin archivo de CA falla al conectar con un mensaje del driver
 * que no dice qué campo falta.
 */
export function problemasDeRed(tls: TlsConfig | undefined, ssh: SshConfig | undefined, auth?: AuthConfig): string[] {
  const problemas: string[] = [];
  if (auth) {
    if (!auth.region) problemas.push("IAM: falta la región");
    if (!tls || tls.mode === "deshabilitado") problemas.push("IAM: requiere TLS");
  }
  if (tls && (tls.mode === "verificar-ca" || tls.mode === "mutuo") && !tls.caFile) {
    problemas.push("TLS: falta el archivo de CA");
  }
  if (tls?.mode === "mutuo") {
    if (!tls.certFile) problemas.push("TLS: falta el certificado de cliente");
    if (!tls.keyFile) problemas.push("TLS: falta la clave privada del cliente");
  }
  if (ssh?.enabled) {
    if (!ssh.host) problemas.push("SSH: falta el host del salto");
    if (!ssh.user) problemas.push("SSH: falta el usuario del salto");
    if (ssh.auth === "key" && !ssh.keyFile) problemas.push("SSH: falta la clave privada");
  }
  return problemas;
}

/**
 * Clave de caché de drivers. Dos perfiles que conectan al mismo host:puerto/usuario/base son el
 * MISMO pool, pero solo si además comparten TLS y túnel: uno cifrado y otro sin cifrar no pueden
 * compartir conexión. Sin esto, el perfil con túnel heredaría el pool del directo.
 */
export function claveDeRed(tls?: TlsConfig, ssh?: SshConfig, auth?: AuthConfig): string {
  return JSON.stringify({
    tls: tls ?? null,
    auth: auth ?? null,
    ssh: ssh?.enabled
      ? { host: ssh.host, port: ssh.port, user: ssh.user, auth: ssh.auth, keyFile: ssh.keyFile ?? "" }
      : null,
  });
}

/** Los motores que hablan SQL. Mongo queda fuera: no hay dialecto que traducir ni prompt de SQL. */
export type MotorSql = "postgres" | "mysql" | "sqlserver";

export function esMotorSql(motor: MotorDeConexion | undefined): motor is MotorSql {
  return motor === "postgres" || motor === "mysql" || motor === "sqlserver";
}

/**
 * Dialecto SQL para las piezas que SOLO entienden SQL (prompts de IA, traducción entre motores,
 * guard de solo lectura, `applyLimit`). Mongo cae a «postgres»: esas piezas no se usan con Mongo,
 * pero el tipo deja de mentir en cada llamador.
 */
export function dialectoSql(motor: MotorDeConexion | undefined): MotorSql {
  return esMotorSql(motor) ? motor : "postgres";
}
