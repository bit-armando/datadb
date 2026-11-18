/**
 * utilityProcess que aloja sesiones, pools y drivers (decision 1 de la fase 2, R50).
 *
 * Si este proceso muere, la ventana sigue viva y `main` lo relanza. Las sesiones viven en la
 * memoria de este proceso, asi que se pierden; la siguiente query recibe "Session not found"
 * y la auto-reconexion de sql-editor.tsx las recrea sola.
 *
 * Los console.* de aqui llegan a la consola de `main` con prefijo [db-worker] (stdio: pipe).
 */
import { createRouter, type Handlers } from "@/server/ipc/router";
import {
  connectHandler,
  getSchemaHandler,
  getSessionHandler,
  listDatabasesHandler,
  disconnectHandler,
  switchDatabaseHandler,
} from "@/server/handlers/session";
import {
  cancelQueryHandler,
  executeQueryHandler,
  listHistoryHandler,
  clearHistoryHandler,
} from "@/server/handlers/query";
import {
  mongoCountHandler,
  mongoDeleteHandler,
  mongoFieldsHandler,
  mongoFindHandler,
  mongoInsertHandler,
  mongoUpdateHandler,
} from "@/server/handlers/mongo";
import { listAwsProfilesHandler } from "@/server/handlers/aws";
import { favoritesGetHandler, favoritesSetHandler } from "@/server/handlers/favorites";
import {
  deleteProfileHandler,
  listProfilesHandler,
  saveProfileHandler,
  testProfileHandler,
  updateProfileHandler,
} from "@/server/handlers/profiles";
import {
  deleteSavedQueryHandler,
  listSavedQueriesHandler,
  saveSavedQueryHandler,
  updateSavedQueryHandler,
} from "@/server/handlers/saved-queries";
import { beginTxHandler, commitTxHandler, rollbackTxHandler, txStatusHandler } from "@/server/handlers/tx";
import { ddlHandler, explainHandler } from "@/server/handlers/inspect";
import { batchEditHandler } from "@/server/handlers/grid";
import { readLogHandler } from "@/server/handlers/log";
import {
  askAiHandler,
  cancelAiHandler,
  chatAiHandler,
  clearAiChatsHandler,
  getAiSettingsHandler,
  listAiChatsHandler,
  listAiModelsHandler,
  saveAiChatsHandler,
  saveAiSettingsHandler,
  testAiKeyHandler,
} from "@/server/handlers/ai";
import { closeAllSessions } from "@/server/sessions";
import { setSecretTransport } from "@/server/secrets-client";
import { migratePlaintextPasswords } from "@/server/profiles";
import type { FromWorker, ToWorker } from "@/shared/worker-protocol";

const port = process.parentPort;
const send = (msg: FromWorker) => port.postMessage(msg);

/**
 * Fase 3 (T8): el mapa se tipa como `Handlers` COMPLETO (no Partial): un canal del contrato sin handler aqui es un
 * error de compilacion, no un «Canal desconocido» en tiempo de ejecucion.
 */
const handlers: Handlers = {
    "profiles:list": listProfilesHandler,
    "aws:profiles": listAwsProfilesHandler,
    "session:connect": connectHandler,
    "session:get": getSessionHandler,
    "databases:list": listDatabasesHandler,
    "savedQueries:list": listSavedQueriesHandler,
    "history:list": listHistoryHandler,
    "schema:get": getSchemaHandler,
    "mongo:find": mongoFindHandler,
    "mongo:count": mongoCountHandler,
    "mongo:fields": mongoFieldsHandler,
    "mongo:update": mongoUpdateHandler,
    "mongo:insert": mongoInsertHandler,
    "mongo:delete": mongoDeleteHandler,
    "favorites:get": favoritesGetHandler,
    "favorites:set": favoritesSetHandler,
    "query:execute": executeQueryHandler,
    "query:cancel": cancelQueryHandler,
    // Fase 3, T1
    "tx:begin": beginTxHandler,
    "tx:commit": commitTxHandler,
    "tx:rollback": rollbackTxHandler,
    "tx:status": txStatusHandler,
    "schema:ddl": ddlHandler,
    "query:explain": explainHandler,
    // Fase 3, T2
    "profiles:save": saveProfileHandler,
    "profiles:update": updateProfileHandler,
    "profiles:delete": deleteProfileHandler,
    "profiles:test": testProfileHandler,
    "session:disconnect": disconnectHandler,
    "session:switchDatabase": switchDatabaseHandler,
    // Fase 3, T3
    "grid:batchEdit": batchEditHandler,
    "savedQueries:save": saveSavedQueryHandler,
    "savedQueries:update": updateSavedQueryHandler,
    "savedQueries:delete": deleteSavedQueryHandler,
    "history:clear": clearHistoryHandler,
    // Fase 3, T5+T6
    "ai:ask": askAiHandler,
    "ai:chat": chatAiHandler,
    "ai:cancel": cancelAiHandler,
    "ai:getSettings": getAiSettingsHandler,
    "ai:saveSettings": saveAiSettingsHandler,
    "ai:models": listAiModelsHandler,
    "aiChats:list": listAiChatsHandler,
    "aiChats:save": saveAiChatsHandler,
    "aiChats:clear": clearAiChatsHandler,
    "ai:testKey": testAiKeyHandler,
    // Fase 3, T7
    "log:read": readLogHandler,
};

const route = createRouter(handlers, (name, payload) => send({ kind: "event", name, payload }));

// Fase 25: pedir secretos a `main`. Cada petición espera su respuesta por id; si `main` no contesta en 5 s, falla
// (visible para el usuario como error de la acción de IA), en vez de colgar la petición al proveedor.
let nextSecretId = 1;
const pendingSecrets = new Map<number, (r: { value?: string | null; has?: boolean; error?: string }) => void>();
setSecretTransport(
  (op, name, value) =>
    new Promise((resolve, reject) => {
      const id = nextSecretId++;
      const timer = setTimeout(() => {
        pendingSecrets.delete(id);
        reject(new Error("El almacén de secretos no respondió"));
      }, 5000);
      pendingSecrets.set(id, (r) => {
        clearTimeout(timer);
        if (r.error) reject(new Error(r.error));
        else resolve(r);
      });
      send({ kind: "secret-request", id, op, name, value });
    })
);

port.on("message", async ({ data }: { data: ToWorker }) => {
  if (data.kind === "secret-response") {
    pendingSecrets.get(data.id)?.(data);
    pendingSecrets.delete(data.id);
    return;
  }
  if (data.kind === "request") {
    send({ kind: "response", id: data.id, result: await route(data.channel, data.payload) });
  } else if (data.kind === "shutdown") {
    // sessions.ts ya cierra los pools en SIGTERM; esto es la via ordenada y rapida.
    await closeAllSessions().catch((err) => console.error("[db-worker] error al cerrar", err));
    send({ kind: "shutdown-done" });
  }
});

/**
 * Fase 17 (R7): migración ÚNICA de contraseñas en claro a `safeStorage`, ANTES de declararse listo
 * (nadie puede conectar ni listar perfiles mientras tanto). Se espera a propósito: si el cifrado
 * falla, el arranque lo dice en vez de dejar credenciales en claro y seguir como si nada.
 */
// El bundle del worker es CJS y no admite `await` de nivel superior: el arranque va en una IIFE
// async, y `ready` se manda AL FINAL — la migración termina antes de que main considere vivo al
// worker, así que nadie lista perfiles a medio migrar.
void (async () => {
  try {
    const migradas = await migratePlaintextPasswords();
    if (migradas > 0) {
      console.log(`[db-worker] ${migradas} contraseña(s) de conexión migradas al almacén cifrado`);
    }
  } catch (err) {
    console.error(
      "[db-worker] no se pudieron cifrar las contraseñas de conexión:",
      err instanceof Error ? err.message : String(err)
    );
  }
  send({ kind: "ready" });
})();
