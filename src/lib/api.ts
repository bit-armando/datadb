/**
 * Cliente de datos del renderer. Fase 3 (decision D1): SOLO IPC. Cada funcion llama a un canal del contrato
 * (`src/shared/contract.ts`) que atiende el utilityProcess (`electron/db-worker.ts`); la via HTTP a `/api/*` se borro
 * junto con las rutas de Next y `dev:web` dejo de funcionar.
 *
 * Los errores llegan como `ApiError` con el MISMO mensaje y status que daban las rutas (ver ipc-client.ts), asi que
 * `String(err)` sigue matcheando /session not found/i para la auto-reconexion de sql-editor.tsx.
 */
import {
  type BatchOperation,
  type ConnectionProfile,
  type ConnectionProfileInput,
  type ExplainNode,
  type QueryHistoryEntry,
  type QueryResult,
  type SavedQuery,
  type SavedQueryInput,
  type SchemaNode,
  type Session,
} from "./types";
import { ApiError } from "./api-error";
import { invoke } from "./ipc-client";
import { getDataSettings } from "./data-settings";

export { ApiError };

// --- perfiles ------------------------------------------------------------------------------------------------

export async function testConnection(
  input: ConnectionProfileInput & { id?: string }
): Promise<{ ok: boolean; error?: string }> {
  return invoke("profiles:test", input);
}

export async function listProfiles(): Promise<ConnectionProfile[]> {
  return invoke("profiles:list");
}

export async function listAwsProfiles(): Promise<string[]> {
  return invoke("aws:profiles");
}

export async function saveProfile(input: ConnectionProfileInput): Promise<ConnectionProfile> {
  return invoke("profiles:save", input);
}

export async function updateProfile(id: string, input: ConnectionProfileInput): Promise<ConnectionProfile> {
  return invoke("profiles:update", { id, input });
}

export async function deleteProfile(id: string): Promise<void> {
  await invoke("profiles:delete", { id });
}

// --- sesion ----------------------------------------------------------------------------------------------------

export async function connect(profileId: string | ConnectionProfileInput): Promise<Session> {
  return invoke("session:connect", typeof profileId === "string" ? { profileId } : profileId);
}

export async function getSession(sessionId: string): Promise<Session> {
  return invoke("session:get", { sessionId });
}

export async function disconnect(sessionId: string): Promise<void> {
  // Fase 3 (T2). La ruta no miraba la respuesta (se llamaba sin `handle`); el canal SI propaga el error, y los
  // llamadores ya lo atrapan (`.catch(() => undefined)` en app-shell y la barra de conexión).
  await invoke("session:disconnect", { sessionId });
}

export async function listDatabases(sessionId: string): Promise<string[]> {
  return invoke("databases:list", { sessionId });
}

export async function switchDatabase(sessionId: string, database: string): Promise<Session> {
  return invoke("session:switchDatabase", { sessionId, database });
}

// --- esquema e inspeccion ------------------------------------------------------------------------------------

export async function getSchema(sessionId: string): Promise<SchemaNode[]> {
  return invoke("schema:get", { sessionId });
}

export async function getTableDdl(sessionId: string, schema: string, table: string): Promise<string> {
  return getObjectDdl(sessionId, schema, table, "table");
}

export async function getObjectDdl(
  sessionId: string,
  schema: string,
  name: string,
  kind: "table" | "view" | "function" | "procedure" | "trigger"
): Promise<string> {
  // Las vistas se piden como "table" (los drivers generan su DDL con getTableDdl).
  const data = await invoke("schema:ddl", { sessionId, schema, name, kind: kind === "view" ? "table" : kind });
  return data.ddl;
}

export async function explainQuery(sessionId: string, sql: string): Promise<ExplainNode> {
  const { tree } = await invoke("query:explain", { sessionId, sql });
  return tree;
}

// --- queries -------------------------------------------------------------------------------------------------

export async function runQuery(
  sessionId: string,
  sql: string,
  /**
   * Fase 11 (T2): si no se pasa, se usa el tope que el usuario tenga configurado
   * (`data-settings.ts`), no el valor por defecto del servidor. Antes ningún llamador mandaba
   * límite, así que el tope real de la app eran las 500 filas escritas en `limit.ts`.
   */
  limit?: number,
  offset?: number,
  // Fase 3 (T4): el llamador que quiera cancelar ESTA operacion genera el opId y lo guarda (sql-editor.tsx).
  // Correlaciona los eventos query:started / query:finished que pinta la barra de estado.
  opId: string = crypto.randomUUID()
): Promise<QueryResult> {
  return invoke("query:execute", {
    sessionId,
    sql,
    limit: limit ?? getDataSettings().maxRows,
    offset,
    opId,
  });
}

/** Fase 3 (T4): cancela UNA operacion concreta (R4). Si ya termino, no hace nada. */
export async function cancelOperation(opId: string): Promise<void> {
  await invoke("query:cancel", { opId });
}

/** Cancelacion por sesion (la de siempre); el editor usa `cancelOperation`. */
export async function cancelQuery(sessionId: string): Promise<void> {
  await invoke("query:cancel", { sessionId });
}

// --- transacciones manuales ------------------------------------------------------------------------------------

export async function beginTransaction(sessionId: string): Promise<void> {
  await invoke("tx:begin", { sessionId });
}

export async function commitTransaction(sessionId: string): Promise<void> {
  await invoke("tx:commit", { sessionId });
}

export async function rollbackTransaction(sessionId: string): Promise<void> {
  await invoke("tx:rollback", { sessionId });
}

export async function getTransactionStatus(sessionId: string): Promise<{ active: boolean }> {
  return invoke("tx:status", { sessionId });
}

// --- edicion del grid ----------------------------------------------------------------------------------------

export async function batchEdit(
  sessionId: string,
  opts: { schema?: string; table: string; pkColumn: string; operations: BatchOperation[] }
): Promise<{ affectedRows: number }> {
  return invoke("grid:batchEdit", { sessionId, ...opts });
}

// --- consultas guardadas e historial ---------------------------------------------------------------------------

export async function listSavedQueries(connectionId?: string): Promise<SavedQuery[]> {
  return invoke("savedQueries:list", { connectionId });
}

export async function saveSavedQuery(input: SavedQueryInput): Promise<SavedQuery> {
  return invoke("savedQueries:save", input);
}

export async function updateSavedQuery(id: string, input: Partial<SavedQueryInput>): Promise<SavedQuery> {
  return invoke("savedQueries:update", { id, input });
}

export async function deleteSavedQuery(id: string): Promise<void> {
  await invoke("savedQueries:delete", { id });
}

export async function listQueryHistory(sessionId: string): Promise<QueryHistoryEntry[]> {
  return invoke("history:list", { sessionId });
}

export async function clearQueryHistory(sessionId: string): Promise<void> {
  await invoke("history:clear", { sessionId });
}

// --- archivos ------------------------------------------------------------------------------------------------

/**
 * Abre el panel nativo de archivos (fase 80) y devuelve la ruta elegida, o `null` si se cancela.
 * Lo atiende `main`, no el worker: `dialog` solo existe en el proceso principal de Electron.
 */
export async function pickFile(
  titulo?: string,
  extensiones?: string[]
): Promise<{ path: string | null }> {
  return invoke("files:pick", { titulo, extensiones });
}

// --- documentos de MongoDB (fase 81) -------------------------------------------------------------------------

export async function mongoFind(input: {
  sessionId: string;
  coleccion: string;
  filtro?: string;
  proyeccion?: string;
  orden?: string;
  skip?: number;
  limit?: number;
}): Promise<import("@/shared/mongo-view").MongoFindResult> {
  return invoke("mongo:find", input);
}

export async function mongoCount(input: {
  sessionId: string;
  coleccion: string;
  filtro?: string;
}): Promise<{ total: number }> {
  return invoke("mongo:count", input);
}

/** Rutas de campo muestreadas de una colección, para el autocompletado (fase 83). */
export async function mongoFields(input: {
  sessionId: string;
  coleccion: string;
}): Promise<{ campos: string[] }> {
  return invoke("mongo:fields", input);
}

// --- favoritos (fase 84) --------------------------------------------------------------------------------------

export async function getFavorites(profileId: string): Promise<{ favoritos: { schema: string; table: string }[] }> {
  return invoke("favorites:get", { profileId });
}

export async function setFavorites(
  profileId: string,
  favoritos: { schema: string; table: string }[]
): Promise<{ favoritos: { schema: string; table: string }[] }> {
  return invoke("favorites:set", { profileId, favoritos });
}

/** Guarda los cambios de un documento de Mongo (fase 85). Solo se manda lo cambiado. */
export async function mongoUpdate(input: {
  sessionId: string;
  coleccion: string;
  id: unknown;
  cambios: Record<string, unknown>;
  antes: Record<string, unknown>;
}): Promise<{ documento: Record<string, unknown> }> {
  return invoke("mongo:update", input);
}

/** Inserta un documento de Mongo (fase 86). */
export async function mongoInsert(input: {
  sessionId: string;
  coleccion: string;
  documento: Record<string, unknown>;
}): Promise<{ documento: Record<string, unknown> }> {
  return invoke("mongo:insert", input);
}

/** Borra un documento de Mongo por `_id` (fase 86). `eliminados: 0` = ya no estaba. */
export async function mongoDelete(input: {
  sessionId: string;
  coleccion: string;
  id: unknown;
}): Promise<{ eliminados: number }> {
  return invoke("mongo:delete", input);
}
