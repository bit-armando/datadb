import type {
  ConnectionProfile,
  ConnectionProfileInput,
  QueryHistoryEntry,
  SchemaNode,
  Session,
} from "@/lib/types";
import { claveDeRed } from "@/shared/connection-net";
import type { DatabaseDriver } from "./db/types";
import { createDriver } from "./db/factory";
import {
  loadQueryHistory,
  appendQueryHistoryEntry,
  clearQueryHistoryLog,
  appendSqlLogLine,
} from "./query-log";

export interface StoredSession {
  driver: DatabaseDriver;
  config: ConnectionProfile;
  session: Session;
  lastUsedAt: number;
  queryHistory: QueryHistoryEntry[];
  /** Handle opaco de la transacción manual abierta, si hay una en curso. */
  activeTx?: unknown;
}

interface GlobalSessions {
  sessions: Map<string, StoredSession>;
  shutdownRegistered: boolean;
  cleanupStarted: boolean;
  schemaCache: Map<string, { schema: SchemaNode[]; fetchedAt: number }>;
}

interface CachedDriver {
  driver: DatabaseDriver;
  refCount: number;
}

const GLOBAL_KEY = "__gestordb_sessions__";
const DRIVER_CACHE_KEY = "__gestordb_driver_cache__";

function getGlobalSessions(): GlobalSessions {
  const existing = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as
    | GlobalSessions
    | undefined;
  if (existing) return existing;

  const created: GlobalSessions = {
    sessions: new Map<string, StoredSession>(),
    shutdownRegistered: false,
    cleanupStarted: false,
    schemaCache: new Map(),
  };
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = created;
  return created;
}

function getSessionMap(): Map<string, StoredSession> {
  return getGlobalSessions().sessions;
}

function getDriverCache(): Map<string, CachedDriver> {
  const existing = (globalThis as Record<string, unknown>)[DRIVER_CACHE_KEY] as
    | Map<string, CachedDriver>
    | undefined;
  if (existing) return existing;

  const created = new Map<string, CachedDriver>();
  (globalThis as Record<string, unknown>)[DRIVER_CACHE_KEY] = created;
  return created;
}

/**
 * Clave de la caché de drivers (un pool por destino distinto). Incluye `readOnly` (R53): sin él, un perfil de solo
 * lectura y otro de escritura contra el mismo host/usuario/base compartirían pool, y el de solo lectura heredaría
 * conexiones SIN la protección de la base (o el de escritura, conexiones que no pueden escribir).
 */
export function driverCacheKey(config: ConnectionProfile): string {
  return JSON.stringify({
    readOnly: !!config.readOnly,
    type: config.type,
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    // Fase 80: un perfil cifrado y otro sin cifrar (o con túnel y sin él) NO pueden compartir pool.
    red: claveDeRed(config.tls, config.ssh, config.auth),
  });
}

async function acquireDriver(config: ConnectionProfile): Promise<DatabaseDriver> {
  const key = driverCacheKey(config);
  const cache = getDriverCache();
  const cached = cache.get(key);
  if (cached) {
    cached.refCount++;
    return cached.driver;
  }

  const driver = createDriver(config);
  await driver.testConnection();
  cache.set(key, { driver, refCount: 1 });
  return driver;
}

async function releaseDriver(config: ConnectionProfile): Promise<void> {
  const key = driverCacheKey(config);
  const cache = getDriverCache();
  const cached = cache.get(key);
  if (!cached) return;

  cached.refCount--;
  if (cached.refCount <= 0) {
    cache.delete(key);
    await cached.driver.close().catch(() => undefined);
  }
}

function registerShutdownHandlers(): void {
  const globalSessions = getGlobalSessions();
  if (globalSessions.shutdownRegistered) return;
  globalSessions.shutdownRegistered = true;

  const closeAll = async () => {
    await closeAllSessions();
    process.exit(0);
  };

  process.on("SIGINT", closeAll);
  process.on("SIGTERM", closeAll);
}

const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos
const CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minuto
const QUERY_HISTORY_LIMIT = 50; // máximo de entradas en memoria por sesión
const SCHEMA_CACHE_TTL_MS = 60 * 1000; // 60 segundos

export async function getSessionSchema(sessionId: string): Promise<SchemaNode[]> {
  const global = getGlobalSessions();
  const cached = global.schemaCache.get(sessionId);
  if (cached && Date.now() - cached.fetchedAt < SCHEMA_CACHE_TTL_MS) {
    return cached.schema;
  }
  const stored = getSessionMap().get(sessionId);
  if (!stored) {
    throw new Error("Session not found");
  }
  const schema = await stored.driver.getSchema();
  global.schemaCache.set(sessionId, { schema, fetchedAt: Date.now() });
  return schema;
}

export function invalidateSessionSchema(sessionId: string): void {
  getGlobalSessions().schemaCache.delete(sessionId);
}

function startInactivityCleanup(): void {
  const globalSessions = getGlobalSessions();
  if (globalSessions.cleanupStarted) return;
  globalSessions.cleanupStarted = true;

  setInterval(() => {
    const now = Date.now();
    const map = getSessionMap();
    for (const [id, stored] of map) {
      if (now - stored.lastUsedAt > INACTIVITY_TIMEOUT_MS) {
        closeSession(id).catch(() => undefined);
      }
    }
  }, CLEANUP_INTERVAL_MS);
}

export async function createSession(
  input: ConnectionProfileInput | ConnectionProfile
): Promise<Session> {
  registerShutdownHandlers();
  startInactivityCleanup();

  const config: ConnectionProfile =
    "id" in input ? input : { ...input, id: crypto.randomUUID() };

  const driver = await acquireDriver(config);

  const session: Session = {
    sessionId: crypto.randomUUID(),
    name: config.name,
    type: config.type,
    database: config.database,
    color: config.color,
    profileId: config.id,
    readOnly: config.readOnly,
  };

  getSessionMap().set(session.sessionId, {
    driver,
    config,
    session,
    lastUsedAt: Date.now(),
    queryHistory: [],
  });
  return session;
}

export function getSession(sessionId: string): StoredSession | undefined {
  const stored = getSessionMap().get(sessionId);
  if (stored) {
    stored.lastUsedAt = Date.now();
  }
  return stored;
}

export async function getQueryHistory(sessionId: string): Promise<QueryHistoryEntry[]> {
  const stored = getSession(sessionId);
  if (!stored) return [];
  // El historial persiste en disco por conexión (config.name), no por
  // sessionId efímero, para sobrevivir reinicios del servidor y expiración
  // de sesión por inactividad.
  const persisted = await loadQueryHistory(stored.config.name);
  stored.queryHistory = persisted;
  return persisted;
}

export async function addQueryHistory(
  sessionId: string,
  entry: QueryHistoryEntry
): Promise<void> {
  const stored = getSession(sessionId);
  if (!stored) return;

  stored.queryHistory.unshift(entry);
  if (stored.queryHistory.length > QUERY_HISTORY_LIMIT) {
    stored.queryHistory.length = QUERY_HISTORY_LIMIT;
  }
  await appendQueryHistoryEntry(stored.config.name, entry);
  await appendSqlLogLine({
    timestamp: entry.executedAt,
    connectionId: stored.config.name,
    sql: entry.sql,
    durationMs: entry.durationMs,
    rowCount: entry.rowCount,
    affectedRows: entry.affectedRows,
    error: entry.error,
  });
}

export async function clearQueryHistory(sessionId: string): Promise<void> {
  const stored = getSession(sessionId);
  if (!stored) return;
  stored.queryHistory = [];
  await clearQueryHistoryLog(stored.config.name);
}

export async function closeSession(sessionId: string): Promise<void> {
  const stored = getSessionMap().get(sessionId);
  if (!stored) return;
  getSessionMap().delete(sessionId);
  invalidateSessionSchema(sessionId);
  if (stored.activeTx) {
    await stored.driver.rollbackTransaction(stored.activeTx).catch(() => undefined);
  }
  await releaseDriver(stored.config);
}

/** Abre una transacción manual para la sesión; falla si ya hay una en curso. */
export async function beginSessionTransaction(sessionId: string): Promise<void> {
  const stored = getSession(sessionId);
  if (!stored) throw new Error("Session not found");
  if (stored.activeTx) throw new Error("Ya hay una transacción abierta en esta sesión");
  stored.activeTx = await stored.driver.beginTransaction();
}

export async function commitSessionTransaction(sessionId: string): Promise<void> {
  const stored = getSession(sessionId);
  if (!stored) throw new Error("Session not found");
  if (!stored.activeTx) throw new Error("No hay una transacción abierta");
  const tx = stored.activeTx;
  stored.activeTx = undefined;
  await stored.driver.commitTransaction(tx);
}

export async function rollbackSessionTransaction(sessionId: string): Promise<void> {
  const stored = getSession(sessionId);
  if (!stored) throw new Error("Session not found");
  if (!stored.activeTx) throw new Error("No hay una transacción abierta");
  const tx = stored.activeTx;
  stored.activeTx = undefined;
  await stored.driver.rollbackTransaction(tx);
}

export function hasActiveTransaction(sessionId: string): boolean {
  const stored = getSessionMap().get(sessionId);
  return !!stored?.activeTx;
}

export async function switchDatabase(
  sessionId: string,
  database: string
): Promise<Session> {
  const stored = getSessionMap().get(sessionId);
  if (!stored) {
    throw new Error("Session not found");
  }

  if (stored.activeTx) {
    await stored.driver.rollbackTransaction(stored.activeTx).catch(() => undefined);
  }

  await releaseDriver(stored.config);

  const newConfig: ConnectionProfile = { ...stored.config, database };
  const newDriver = await acquireDriver(newConfig);

  const session: Session = {
    sessionId,
    name: newConfig.name,
    type: newConfig.type,
    database: newConfig.database,
    color: newConfig.color,
    profileId: newConfig.id,
    readOnly: newConfig.readOnly,
  };

  getSessionMap().set(sessionId, {
    driver: newDriver,
    config: newConfig,
    session,
    lastUsedAt: Date.now(),
    queryHistory: stored.queryHistory,
  });

  invalidateSessionSchema(sessionId);

  return session;
}

export async function closeAllSessions(): Promise<void> {
  const map = getSessionMap();
  const ids = Array.from(map.keys());
  await Promise.all(ids.map((id) => closeSession(id)));
}
