import {
  type ChatMessage,
  type AiSettingsWithKeyStatus,
} from "./ai-types";

import type { AuthConfig, MotorDeConexion, SshConfig, TlsConfig } from "@/shared/connection-net";

export interface ConnectionProfile {
  id: string;
  name: string;
  type: MotorDeConexion;
  host: string;
  port: number;
  user: string;
  /**
   * Fase 17 (R6): NUNCA se guarda en `connections.json`. Un perfil que viene del disco siempre trae
   * `""`; el valor vive cifrado en el almacén de secretos (`db.<id>`). El campo sigue existiendo en
   * el tipo porque el formulario y `testConnection` lo usan EN MEMORIA, y porque un perfil recién
   * creado lo lleva para que el worker lo cifre.
   */
  password: string;
  /** El perfil que viene del disco: si hay contraseña guardada (cifrada), para el hint del campo. */
  hasPassword?: boolean;
  database: string;
  color?: string;
  /** Si es true, el servidor rechaza cualquier sentencia que no sea de solo lectura. */
  readOnly?: boolean;
  /**
   * TLS de la conexión (fase 80). Opcional: un perfil viejo no lo tiene y se trata como
   * «deshabilitado». Solo rutas a los PEM; el contenido se lee en el worker al conectar.
   */
  tls?: TlsConfig;
  /** Túnel SSH (fase 80). Opcional por la misma razón. */
  ssh?: SshConfig;
  /** Autenticación IAM de RDS/Aurora (PostgreSQL y MySQL). Sin él, se usa `password`. */
  auth?: AuthConfig;
  /**
   * SOLO EN MEMORIA. Contraseña del salto SSH y frase de paso de su clave: se descifran en el
   * worker justo antes de conectar (igual que `password`) y nunca se escriben en `connections.json`.
   */
  sshPassword?: string;
  sshPassphrase?: string;
}

export type ConnectionProfileInput = Omit<ConnectionProfile, "id">;

/**
 * Conexión «dormida» de una consola (R91): lo que hace falta para pintarla y para reconectar, sin
 * sesión ni secretos. La contraseña sigue en el almacén del worker; aquí solo va el id del perfil.
 */
export interface ConsoleBinding {
  profileId: string;
  name: string;
  type: MotorDeConexion;
  database?: string;
  color?: string;
  readOnly?: boolean;
}

export interface Session {
  sessionId: string;
  name: string;
  type: MotorDeConexion;
  database?: string;
  color?: string;
  profileId?: string;
  readOnly?: boolean;
}

export type SchemaObjectKind =
  | "table"
  | "view"
  | "function"
  | "procedure"
  | "trigger";

export interface SchemaNode {
  name: string;
  tables: TableMeta[];
  /** Funciones y procedimientos almacenados en este schema. */
  routines: RoutineMeta[];
  /** Triggers definidos en este schema. */
  triggers: TriggerMeta[];
}

export interface TableMeta {
  name: string;
  type: "table" | "view";
  columns: ColumnMeta[];
}

export interface RoutineMeta {
  name: string;
  type: "function" | "procedure";
  /** Lenguaje del cuerpo (p. ej. plpgsql, sql, SQL). */
  language?: string;
}

export interface TriggerMeta {
  name: string;
  /** Tabla o vista a la que está asociado el trigger. */
  targetTable?: string;
  /** Momento de disparo, p. ej. BEFORE, AFTER, INSTEAD OF. */
  timing?: string;
  /** Evento que lo dispara, p. ej. INSERT, UPDATE, DELETE. */
  event?: string;
}

export interface ColumnMeta {
  name: string;
  type: string;
  isPrimaryKey: boolean;
  nullable: boolean;
  fk?: ForeignKeyRef;
}

export interface ForeignKeyRef {
  schema: string;
  table: string;
  column: string;
}

export interface QueryColumn {
  name: string;
  type: string;
  /**
   * De qué columna de qué tabla sale esta columna del resultado, cuando el motor lo dice.
   *
   * Es lo que hace editable una consulta con JOIN o con alias, como en DataGrip: el
   * `SELECT ficha.id, ficha.datetime_deposit FROM clientdeposit ficha JOIN …` no tiene «una tabla»
   * para el parseo del SQL, pero el servidor sí sabe que las dos columnas salen de
   * `clientdeposit` (MySQL: `orgTable`/`orgName`/`db` del paquete de campo; Postgres: `tableID` +
   * `columnID`, resueltos contra `pg_attribute`). Ausente en expresiones (`count(*)`, `a || b`),
   * en SQL Server (el driver no lo expone sin `FOR BROWSE`) y en Mongo.
   */
  origen?: OrigenDeColumna;
}

/** Columna real de la que sale una columna del resultado (ver `QueryColumn.origen`). */
export interface OrigenDeColumna {
  /** Base (MySQL) o esquema (Postgres) de la tabla. */
  schema?: string;
  table: string;
  column: string;
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: Record<string, unknown>[];
  rowCount: number;
  affectedRows?: number;
  durationMs: number;
  limitApplied: boolean;
  effectiveLimit: number;
  effectiveOffset?: number;
}

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  /** Nombre de la conexión al guardar. Desde R96 es solo el respaldo de `profileId` (y el rótulo). */
  connectionId?: string;
  /**
   * R96: perfil al que pertenece la consulta. Manda sobre `connectionId` (el nombre), que se rompía
   * al renombrar el perfil. Ausente en las consultas guardadas antes de R96.
   */
  profileId?: string;
  /** R96: base en la que estaba la consola al guardar; al abrirla en consola nueva se vuelve a ella. */
  database?: string;
  createdAt: string;
  updatedAt: string;
}

export type SavedQueryInput = Omit<SavedQuery, "id" | "createdAt" | "updatedAt">;

export interface QueryHistoryEntry {
  id: string;
  sql: string;
  executedAt: string;
  durationMs: number;
  rowCount?: number;
  affectedRows?: number;
  error?: string;
  database?: string;
  engine?: Session["type"];
}

export interface FavoriteTable {
  schema: string;
  table: string;
}

export type BatchOperation =
  | { type: "update"; pkValue: unknown; changes: Record<string, unknown> }
  | { type: "insert"; values: Record<string, unknown> }
  | { type: "delete"; pkValue: unknown };

export interface TableContext {
  schema: string;
  table: string;
  pkColumns: ColumnMeta[];
  columns: ColumnMeta[];
  /**
   * Columnas DEL RESULTADO que se pueden editar → su columna real en `table`.
   *
   * Ausente en el contexto de siempre (vista de tabla, o `SELECT … FROM una_tabla` resuelto por
   * el parseo del SQL): ahí el nombre del resultado ES el de la columna. Presente cuando el
   * contexto sale de `QueryColumn.origen` (`lib/result-origin.ts`): una columna que no está en el
   * mapa (de otra tabla del JOIN, una expresión, un nombre repetido) es de solo lectura.
   */
  columnasDelResultado?: Record<string, string>;
  /** Nombre de la clave primaria EN EL RESULTADO (con alias puede no ser el de la columna). */
  pkEnResultado?: string;
  /**
   * El resultado no es «la tabla tal cual» (trae columnas de otras tablas, expresiones o alias):
   * solo se permite cambiar valores (UPDATE por clave primaria). Agregar, duplicar y borrar filas
   * quedan fuera porque una fila del resultado no es una fila de la tabla.
   */
  soloActualizar?: boolean;
}

export interface TableTab {
  id: string;
  /** Consola desde la que se abrió la pestaña (evita mezclar colecciones Mongo con sesiones SQL). */
  consoleId?: string;
  /** Fase 3 (T7): "sqlLog" = el log SQL de solo lectura (una sola pestaña, id "sql-log"; `target` va vacío). */
  kind?: "table" | "diagram" | "sqlLog";
  target: {
    schema: string;
    table: string;
    whereColumn?: string;
    whereValue?: unknown;
  };
  /**
   * Cuando está presente, el diagrama ER se acota a exactamente estas tablas
   * (p. ej. las de la consulta con foco) en lugar de expandir el grafo de FKs
   * a partir de `target`.
   */
  scopeTables?: { schema: string; table: string }[];
}

export interface ResultTab {
  id: string;
  title: string;
  sql: string;
  result: QueryResult;
  tableContext: TableContext | null;
  /** Offset actual de paginación (en filas) para esta pestaña, si aplica LIMIT/OFFSET. */
  offset?: number;
  /** Cuando está presente, esta pestaña muestra un plan de ejecución (EXPLAIN) en vez de un result set. */
  explainTree?: ExplainNode;
}

/**
 * Nodo normalizado de un plan de ejecución, independiente del dialecto
 * (Postgres `EXPLAIN (FORMAT JSON)` / MySQL `EXPLAIN FORMAT=JSON`), para
 * poder renderizarlo con el mismo componente de árbol.
 */
export interface ExplainNode {
  /** Tipo de operación: "Seq Scan", "Index Scan", "Nested Loop", "table", etc. */
  type: string;
  /** Detalle legible: tabla, índice usado, condición, etc. */
  detail?: string;
  /** Costo estimado por el planner (unidad propia de cada motor, no comparable entre sí). */
  cost?: number;
  /** Filas estimadas que produce este nodo. */
  rows?: number;
  /** true si el planner marca este nodo como potencialmente costoso (full scan sin índice, etc). */
  expensive?: boolean;
  children: ExplainNode[];
}

/**
 * Una consola SQL independiente: su propio buffer de texto, sus propias
 * pestañas de resultado, y su propio estado de "consulta guardada activa".
 * DataGrip permite tener varias consolas abiertas a la vez por conexión;
 * esto es el equivalente en DataDB.
 */
export interface SqlConsole {
  id: string;
  name: string;
  sql: string;
  /**
   * Conexión activa de ESTA consola. Cada consola SQL tiene su propia sesión
   * independiente (multi-conexión simultánea, al estilo DataGrip): la consola
   * A puede estar contra Postgres-prod mientras la B está contra MySQL-staging,
   * e incluso puede haber dos consolas contra el mismo perfil con dos sesiones
   * distintas. Es `null` mientras la consola aún no se ha conectado.
   */
  session: Session | null;
  /**
   * A QUÉ está atada la consola, aunque no haya sesión viva (R91, conexión perezosa). Sobrevive al
   * cierre de la app: al reabrir, la consola enseña su motor, su conexión y su base sin conectar, y
   * se conecta sola al EJECUTAR (perfil + base). Sin secretos: solo el id del perfil y lo que se
   * pinta. `null` = consola sin conexión elegida (nueva, o desconectada a propósito).
   */
  binding: ConsoleBinding | null;
  resultTabs: ResultTab[];
  activeResultTabId: string | null;
  /** ID de la consulta guardada actualmente cargada en esta consola, si alguna. */
  activeSavedQueryId: string | null;
  /** SQL tal como estaba al cargar/guardar la consulta activa, para detectar cambios sin guardar. */
  savedQuerySnapshot: string;
}

export interface AppState {
  // NOTA: la sesión ya NO vive a nivel raíz. Cada consola (`SqlConsole.session`)
  // tiene su propia conexión independiente. Usa `useActiveSession()` /
  // `getActiveConsole(state).session` para leer la sesión de la consola con foco.
  schema: SchemaNode[] | null;
  databases: string[];
  consoles: SqlConsole[];
  activeConsoleId: string;
  queryError: string | null;
  running: boolean;
  tableContext: TableContext | null;
  tableTabs: TableTab[];
  activeTabId: string;
  commandOpen: boolean;
  savedQueries: SavedQuery[];
  queryHistory: QueryHistoryEntry[];
  favoriteTables: FavoriteTable[];
  statusMessage: string;
  /** Si hay una transacción manual abierta en la sesión activa (modo commit manual). */
  transactionActive: boolean;
  /** Estado de la interfaz de IA. */
  aiMessages: ChatMessage[];
  aiBusy: boolean;
  aiSettings: AiSettingsWithKeyStatus | null;
  /** Último uso de tokens reportado por OpenRouter. */
  aiLastUsage?: { promptTokens: number; completionTokens: number };
}

export type AppAction =
  // SET_SESSION ya no es global: opera sobre una consola concreta. Si se omite
  // `consoleId`, aplica a la consola activa (el caso más común en los
  // call-sites: conectar/desconectar/reconectar la consola con foco).
  | { type: "SET_SESSION"; payload: { consoleId?: string; session: Session | null } }
  | { type: "SET_SCHEMA"; payload: SchemaNode[] | null }
  | { type: "SET_DATABASES"; payload: string[] }
  | { type: "SET_SQL"; payload: string }
  | { type: "ADD_RESULT_TAB"; payload: ResultTab }
  | { type: "CLOSE_RESULT_TAB"; payload: string }
  | { type: "SET_ACTIVE_RESULT_TAB"; payload: string | null }
  | { type: "CLEAR_RESULT_TABS" }
  | { type: "SET_QUERY_ERROR"; payload: string | null }
  | { type: "SET_RUNNING"; payload: boolean }
  | { type: "SET_TABLE_CONTEXT"; payload: TableContext | null }
  | { type: "OPEN_TABLE_TAB"; payload: TableTab["target"] }
  | { type: "OPEN_SQL_LOG_TAB" }
  | { type: "CLOSE_TABLE_TAB"; payload: string }
  | { type: "SET_ACTIVE_TAB"; payload: string }
  | { type: "CLOSE_ALL_TABS" }
  | { type: "SET_COMMAND_OPEN"; payload: boolean }
  | { type: "SET_SAVED_QUERIES"; payload: SavedQuery[] }
  | { type: "UPSERT_SAVED_QUERY"; payload: SavedQuery }
  | { type: "SET_QUERY_HISTORY"; payload: QueryHistoryEntry[] }
  | { type: "ADD_QUERY_HISTORY_ENTRY"; payload: QueryHistoryEntry }
  | { type: "CLEAR_QUERY_HISTORY" }
  | { type: "TOGGLE_FAVORITE_TABLE"; payload: FavoriteTable }
  | { type: "SET_FAVORITE_TABLES"; payload: FavoriteTable[] }
  | { type: "SET_STATUS_MESSAGE"; payload: string }
  | { type: "RESET_WORKSPACE" }
  // Restaura el workspace persistido (todas las consolas con su sesión/buffer)
  // al hidratar en el cliente. Reemplaza el array de consolas de golpe.
  | {
      type: "RESTORE_WORKSPACE";
      payload: {
        consoles: {
          id: string;
          name: string;
          sql: string;
          /** Formato anterior a R91: la sesión entera (su id ya no vale tras reiniciar). */
          session?: Session | null;
          binding?: ConsoleBinding | null;
          activeSavedQueryId: string | null;
          savedQuerySnapshot: string;
        }[];
        activeConsoleId: string;
      };
    }
  // Restaura el snapshot completo de consolas (con sus sesiones) tras hidratar
  // desde localStorage. Reemplaza la lista de consolas y el foco de una sola vez.
  // El payload trae solo lo persistido por consola; los result tabs se re-crean
  // vacíos en el reducer.
  | {
      type: "RESTORE_WORKSPACE";
      payload: {
        consoles: {
          id: string;
          name: string;
          sql: string;
          /** Formato anterior a R91: la sesión entera (su id ya no vale tras reiniciar). */
          session?: Session | null;
          binding?: ConsoleBinding | null;
          activeSavedQueryId: string | null;
          savedQuerySnapshot: string;
        }[];
        activeConsoleId: string;
      };
    }
  // Desconecta SOLO una consola (o la activa si se omite `consoleId`): limpia su
  // sesión y sus result tabs, pero NO destruye las demás consolas ni sus
  // conexiones. Es la semántica del botón "Desconectar esta consola".
  | { type: "DISCONNECT_CONSOLE"; payload: { consoleId?: string } }
  /**
   * R91: fija (o quita) la conexión dormida de una consola SIN tocar su sesión. Lo usan el arranque
   * (atar la consola al perfil sin conectar) y el cambio de base con la consola dormida.
   */
  | { type: "SET_BINDING"; payload: { consoleId?: string; binding: ConsoleBinding | null } }
  // R18: nombre y color actuales de un perfil → todas sus consolas (ver `refrescarPerfilEnConsolas`).
  | { type: "REFRESCAR_PERFIL"; payload: Pick<ConnectionProfile, "id" | "name" | "color"> }
  | { type: "SET_ACTIVE_SAVED_QUERY"; payload: { id: string | null; sql: string; name?: string } }
  | { type: "SET_TRANSACTION_ACTIVE"; payload: boolean }
  | { type: "NEW_CONSOLE"; payload: { id: string; name?: string } }
  | { type: "CLOSE_CONSOLE"; payload: string }
  | { type: "SET_ACTIVE_CONSOLE"; payload: string }
  | { type: "RENAME_CONSOLE"; payload: { id: string; name: string } }
  | {
      type: "OPEN_DIAGRAM_TAB";
      payload: {
        schema: string;
        table: string;
        scopeTables?: { schema: string; table: string }[];
      };
    }
  | { type: "SET_AI_BUSY"; payload: boolean }
  | { type: "ADD_AI_MESSAGE"; payload: ChatMessage }
  | { type: "SET_AI_MESSAGES"; payload: ChatMessage[] }
  | { type: "APPEND_AI_STREAM_CHUNK"; payload: string }
  | { type: "CLEAR_AI_MESSAGES" }
  | { type: "SET_AI_SETTINGS"; payload: AiSettingsWithKeyStatus | null }
  | { type: "SET_AI_LAST_USAGE"; payload: { promptTokens: number; completionTokens: number } }
  | { type: "SET_LATEST_AI_MESSAGE_COST"; payload: { costUsd: number } };

export type { MongoFindResult } from "@/shared/mongo-view";
