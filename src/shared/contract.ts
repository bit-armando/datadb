/**
 * Contrato IPC: fuente unica de verdad para renderer, preload, main y utilityProcess.
 *
 * Reglas:
 * - Nombres `dominio:accion`.
 * - Toda respuesta viaja envuelta en IpcResult: NUNCA se lanza una excepcion a traves del
 *   puente. Electron reescribe el mensaje de las excepciones de ipcMain.handle, y la
 *   auto-reconexion de sql-editor.tsx (~233) matchea /session not found/i sobre String(err).
 * - Solo tipos y constantes: este archivo se empaqueta en los cuatro procesos.
 *
 * Fase 2: 9 canales (8 planeados + session:get, descubierto en la verificacion e2e). La fase 3 migra las 18 rutas
 * restantes y, por la decision D1 de su PLAN, borra la via HTTP: este contrato pasa a ser la UNICA via del renderer.
 */
import type { MongoFindResult } from "./mongo-view";
import type {
  AiModelsResult,
  AiRequest,
  AiResponse,
  AiSettings,
  AiSettingsWithKeyStatus,
  ChatMessage,
} from "@/lib/ai-types";
import type { SqlLogTail } from "@/server/query-log";
import type { SecretName } from "./secrets";
import type { MenuAction, MenuState } from "./menu-actions";
import type {
  BatchOperation,
  ConnectionProfile,
  ConnectionProfileInput,
  ExplainNode,
  QueryHistoryEntry,
  QueryResult,
  SavedQuery,
  SavedQueryInput,
  SchemaNode,
  Session,
} from "@/lib/types";

/**
 * Mismos codigos que devolvian las rutas HTTP (route-helpers.ts), mas 499 (fase 3, T6): operacion cancelada por el
 * usuario (la convencion de nginx «client closed request»). Solo la usa ai:chat; el renderer la traduce a AbortError.
 */
export type ErrorStatus = 400 | 401 | 404 | 499 | 500;

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string; status: ErrorStatus } };

export interface InvokeMap {
  "profiles:list": { req: void; res: ConnectionProfile[] };
  /** Nombres de perfiles de ~/.aws (para elegir con cuál firmar el token IAM). */
  "aws:profiles": { req: void; res: string[] };
  "session:connect": {
    req: { profileId: string } | ConnectionProfileInput;
    res: Session;
  };
  /** Revalidacion de la sesion tras conectar (app-shell.tsx ~136). Agregado al ejecutar la
   *  verificacion de punta a punta: sin este canal la app creia que la sesion habia expirado. */
  "session:get": { req: { sessionId: string }; res: Session };
  "databases:list": { req: { sessionId: string }; res: string[] };
  "savedQueries:list": { req: { connectionId?: string }; res: SavedQuery[] };
  "history:list": { req: { sessionId: string }; res: QueryHistoryEntry[] };
  "schema:get": { req: { sessionId: string }; res: SchemaNode[] };
  "query:execute": {
    req: { sessionId: string; sql: string; limit?: number; offset?: number; opId: string };
    // Mismo cuerpo que devuelve POST /api/query: el resultado + metadatos de paginacion.
    res: QueryResult & {
      limitApplied?: boolean;
      effectiveLimit?: number;
      effectiveOffset?: number;
    };
  };
  /**
   * Fase 3 (T4): por opId (la operacion que lanzo el editor) o, como antes, por sessionId. Un opId que ya termino es
   * un no-op con ok. Sigue cancelando a nivel de driver (R16, fase 19).
   */
  "query:cancel": { req: { sessionId?: string; opId?: string }; res: { ok: true } };

  // --- Fase 3, T1: transacciones manuales, Explain y DDL ---------------------------------------------
  "tx:begin": { req: { sessionId: string }; res: { ok: true; active: boolean } };
  "tx:commit": { req: { sessionId: string }; res: { ok: true } };
  "tx:rollback": { req: { sessionId: string }; res: { ok: true } };
  "tx:status": { req: { sessionId: string }; res: { active: boolean } };
  /** Las vistas viajan como "table": los drivers generan su DDL con getTableDdl. */
  "schema:ddl": {
    req: { sessionId: string; schema: string; name: string; kind?: "table" | "function" | "procedure" | "trigger" };
    res: { ddl: string };
  };
  "query:explain": { req: { sessionId: string; sql: string }; res: { tree: ExplainNode } };

  // --- Fase 3, T2: perfiles y sesion --------------------------------------------------------------------
  /** Las respuestas van SIN contrasena (sanitizeProfile dentro del handler). */
  "profiles:save": { req: ConnectionProfileInput; res: ConnectionProfile };
  "profiles:update": { req: { id: string; input: ConnectionProfileInput }; res: ConnectionProfile };
  "profiles:delete": { req: { id: string }; res: { ok: true } };
  /** Nunca falla por la conexion: `{ ok: false, error }` es un resultado que la pantalla pinta. */
  /**
   * `id` opcional (fase 17, R6): al probar un perfil YA GUARDADO el formulario no trae la contraseña
   * (vive cifrada); con el id, el worker usa la del almacén.
   */
  "profiles:test": {
    req: ConnectionProfileInput & { id?: string };
    res: { ok: boolean; error?: string };
  };
  "session:disconnect": { req: { sessionId: string }; res: { ok: true } };
  "session:switchDatabase": { req: { sessionId: string; database: string }; res: Session };

  // --- Fase 3, T3: edicion del grid, consultas guardadas e historial -----------------------------------
  "grid:batchEdit": {
    req: { sessionId: string; schema?: string; table: string; pkColumn: string; operations: BatchOperation[] };
    res: { affectedRows: number };
  };
  "savedQueries:save": { req: SavedQueryInput; res: SavedQuery };
  "savedQueries:update": { req: { id: string; input: Partial<SavedQueryInput> }; res: SavedQuery };
  "savedQueries:delete": { req: { id: string }; res: { ok: true } };
  "history:clear": { req: { sessionId: string }; res: { ok: true } };

  // --- Fase 3, T5+T6: IA --------------------------------------------------------------------------------
  /** Cualquier tarea salvo "chat". Solo genera texto/SQL: nunca ejecuta nada (R28). */
  "ai:ask": { req: AiRequest; res: AiResponse };
  /**
   * Chat en streaming: los trozos llegan como eventos `ai:chunk` con este opId. La respuesta repite lo que NO se puede
   * perder (texto completo, uso y avisos) porque Electron no garantiza que un `webContents.send` llegue antes que la
   * respuesta de `ipcMain.handle` (medido: a veces el ultimo evento llega despues). `usage` va como el JSON crudo del
   * proveedor, igual que en el evento.
   */
  "ai:chat": { req: AiRequest & { opId: string }; res: { text: string; usage?: string; warnings: string[] } };
  /** Aborta el fetch a OpenRouter de ese chat (corta la generacion en el proveedor). opId terminado: no-op. */
  "ai:cancel": { req: { opId: string }; res: { ok: true } };
  /** Solo `hasApiKey`: la key nunca cruza al renderer. */
  "ai:getSettings": { req: void; res: AiSettingsWithKeyStatus };
  "ai:saveSettings": { req: Partial<AiSettings>; res: AiSettingsWithKeyStatus };
  "ai:models": { req: void; res: AiModelsResult };
  "aiChats:list": { req: { connectionId: string }; res: ChatMessage[] };
  "aiChats:save": { req: { connectionId: string; messages: ChatMessage[] }; res: ChatMessage[] };
  "aiChats:clear": { req: { connectionId: string }; res: { ok: true } };
  /** Fase 25: prueba la key guardada contra el proveedor (sin gastar tokens). Nunca falla: `{ ok, message }`. */
  "ai:testKey": { req: void; res: { ok: boolean; message: string } };

  // --- Fase 3, T7: log SQL ------------------------------------------------------------------------------
  /** Final de data/sql-log.jsonl (hasta 1 MB). Ruta fija: el renderer no elige el archivo. */
  "log:read": { req: void; res: SqlLogTail };

  // --- Fase 25: secretos. Los atiende MAIN (safeStorage), no el worker. El renderer NO puede leer un secreto: ---
  // --- solo guardarlo, borrarlo y saber si existe. -------------------------------------------------------------
  /**
   * Fase 6 (R5): el renderer publica el estado que decide qué entradas del menú están activas.
   * Lo atiende MAIN (es quien tiene el menú), y reconstruye la barra cuando algo cambia. Sin esto,
   * un menú «completo» tendría la mitad de sus entradas mudas en vez de en gris.
   */
  "menu:state": { req: MenuState; res: { ok: true } };

  /**
   * Fase 80: abre el panel nativo de archivos y devuelve la ruta elegida (`null` si se cancela).
   * Lo atiende `main` porque `dialog` no existe en el worker. El renderer nunca ve el contenido del
   * archivo: solo la ruta, que es lo que el perfil guarda.
   */
  "files:pick": { req: { titulo?: string; extensiones?: string[] }; res: { path: string | null } };

  /**
   * Fase 81 — vista de documentos de MongoDB. El filtro, la proyección y el orden llegan como TEXTO
   * escrito por el usuario y se interpretan como EJSON en el worker: ahí está el parser, y un texto
   * inválido vuelve como error legible en vez de tumbar la petición.
   */
  "mongo:find": {
    req: {
      sessionId: string;
      coleccion: string;
      filtro?: string;
      proyeccion?: string;
      orden?: string;
      skip?: number;
      limit?: number;
    };
    res: MongoFindResult;
  };
  "mongo:count": { req: { sessionId: string; coleccion: string; filtro?: string }; res: { total: number } };
  /**
   * Fase 85 — guardar los cambios de UN documento. Se mandan solo los campos cambiados y el valor que
   * tenían (`antes`): el driver solo escribe si siguen igual en el servidor.
   */
  "mongo:update": {
    req: {
      sessionId: string;
      coleccion: string;
      id: unknown;
      cambios: Record<string, unknown>;
      antes: Record<string, unknown>;
    };
    res: { documento: Record<string, unknown> };
  };
  /** Fase 86 — insertar un documento nuevo (o una copia sin `_id`). */
  "mongo:insert": {
    req: { sessionId: string; coleccion: string; documento: Record<string, unknown> };
    res: { documento: Record<string, unknown> };
  };
  /** Fase 86 — borrar UN documento por `_id`. `eliminados: 0` = ya no estaba. */
  "mongo:delete": {
    req: { sessionId: string; coleccion: string; id: unknown };
    res: { eliminados: number };
  };
  /** Fase 83: rutas de campo muestreadas, para el autocompletado de la barra de consulta. */
  "mongo:fields": { req: { sessionId: string; coleccion: string }; res: { campos: string[] } };

  /**
   * Fase 84 — favoritos del explorador, POR PERFIL y en disco (`data/favorites.json`). Antes vivían
   * en `localStorage` con una clave derivada de la sesión (nombre/base), así que se perdían al
   * cambiar de base, al renombrar la conexión o al compartir el array entre dos consolas.
   */
  "favorites:get": { req: { profileId: string }; res: { favoritos: { schema: string; table: string }[] } };
  "favorites:set": {
    req: { profileId: string; favoritos: { schema: string; table: string }[] };
    res: { favoritos: { schema: string; table: string }[] };
  };

  "secrets:set": { req: { name: SecretName; value: string }; res: { ok: true } };
  "secrets:delete": { req: { name: SecretName }; res: { ok: true } };
  /** `available`: si el cifrado del sistema funciona (si no, no se puede guardar nada). */
  "secrets:status": {
    req: void;
    res: {
      available: boolean;
      stored: Record<SecretName, boolean>;
      /**
       * Fase 5 (T4): si el renombre del producto dejó secretos ilegibles, de qué nombre venían y cuáles se perdieron.
       * `null` en el caso normal. Solo nombres: ningún valor de secreto llega nunca al renderer.
       */
      migration: { from: string; secrets: SecretName[] } | null;
    };
  };
}

export interface EventMap {
  "query:started": { opId: string; sessionId: string; startedAt: number };
  "query:finished": { opId: string; sessionId: string; durationMs: number; ok: boolean };
  /** Fase 3 (T6): una linea del stream del chat. Mismos cuatro tipos que el NDJSON de la antigua ruta /api/ai. */
  "ai:chunk": { opId: string; type: "content" | "reasoning" | "warning" | "usage"; text: string };
  /**
   * Fase 6 (R5): el usuario eligió una entrada del menú nativo. `main` no sabe hacer ninguna de
   * esas acciones; solo dice cuál se pidió, y el renderer la ejecuta por el MISMO camino que ya
   * usan la paleta de comandos y los botones de la barra (`src/hooks/use-menu-actions.ts`).
   */
  "menu:action": { action: MenuAction };
}

export type InvokeChannel = keyof InvokeMap;
export type EventChannel = keyof EventMap;

export const INVOKE_CHANNELS = [
  "profiles:list",
  "aws:profiles",
  "session:connect",
  "session:get",
  "databases:list",
  "savedQueries:list",
  "history:list",
  "schema:get",
  "query:execute",
  "query:cancel",
  "tx:begin",
  "tx:commit",
  "tx:rollback",
  "tx:status",
  "schema:ddl",
  "query:explain",
  "profiles:save",
  "profiles:update",
  "profiles:delete",
  "profiles:test",
  "session:disconnect",
  "session:switchDatabase",
  "grid:batchEdit",
  "savedQueries:save",
  "savedQueries:update",
  "savedQueries:delete",
  "history:clear",
  "ai:ask",
  "ai:chat",
  "ai:cancel",
  "ai:getSettings",
  "ai:saveSettings",
  "ai:models",
  "aiChats:list",
  "aiChats:save",
  "aiChats:clear",
  "ai:testKey",
  "log:read",
  "mongo:find",
  "mongo:count",
  "mongo:fields",
  "mongo:update",
  "mongo:insert",
  "mongo:delete",
  "favorites:get",
  "favorites:set",
  "secrets:set",
  "secrets:delete",
  "secrets:status",
  "menu:state",
  // Fase 80: el panel de archivos lo abre `main` (el worker no tiene `dialog`).
  "files:pick",
] as const satisfies readonly InvokeChannel[];

/**
 * Fase 25: canales que atiende `main` directamente (no llegan al worker). Son los del almacén de secretos, porque
 * `safeStorage` solo existe en `main`.
 */
export const MAIN_CHANNELS = [
  "secrets:set",
  "secrets:delete",
  "secrets:status",
  // Fase 6: el menú vive en `main`, así que su estado lo atiende `main` y no el worker.
  "menu:state",
  // Fase 80: `dialog` (el panel de archivos) solo existe en `main`.
  "files:pick",
] as const satisfies readonly InvokeChannel[];
export type MainChannel = (typeof MAIN_CHANNELS)[number];
/** Canales que atiende el worker: todos menos los de `main`. */
export type WorkerChannel = Exclude<InvokeChannel, MainChannel>;

export const EVENT_CHANNELS = [
  "query:started",
  "query:finished",
  "ai:chunk",
  "menu:action",
] as const satisfies readonly EventChannel[];
