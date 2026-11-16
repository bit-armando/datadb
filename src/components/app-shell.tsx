import * as React from "react";
import { toast } from "sonner";
import { useAppState, useAppDispatch, useHydrated, getActiveConsole } from "@/hooks/use-app-state";

import {
  disconnect,
  getSession as apiGetSession,
  listProfiles,
  listDatabases,
  getSchema,
  runQuery as apiRunQuery,
  listSavedQueries,
  listQueryHistory,
  connect as apiConnect,
  beginTransaction as apiBeginTransaction,
  commitTransaction as apiCommitTransaction,
  rollbackTransaction as apiRollbackTransaction,
  getTransactionStatus,
} from "@/lib/api";
import {
  loadCachedSchema,
  saveCachedSchema,
  getSchemaCacheKey,
} from "@/lib/schema-cache";
import { SchemaTree } from "./schema-tree";
import { SqlEditor } from "./sql-editor";
import { MongoConsole } from "./mongo-console";
import { wakeBinding } from "@/lib/console-wake";
import { MongoDocuments } from "./mongo-documents";
import { AppTopBar } from "./app-top-bar";
import { ConnectionsModal } from "./connections-modal";
import { TableViewTab } from "./table-view-tab";
import { FkQuickViewDialog, type FkQuickTarget } from "./fk-quick-view-dialog";
import { ValueEditorPanel } from "./value-editor/value-editor-panel";
import { ErDiagramTab } from "./er-diagram-tab";
import { CommandPalette } from "./command-palette";
// Fase 9 (T2): las tool windows existentes se hospedan en los docks (antes: RightPanel con pestañas propias
// y el historial como overlay sobre el editor).
import { ToolWindowDock, ToolWindowOverlay } from "./tool-window";
import { SavedQueriesPanel } from "./saved-queries";
import { useMenuActions, useMenuState } from "@/hooks/use-menu-actions";
// Fase 15 (T5): el refresco del árbol (`⌘R`) se registra en el enrutador de teclado por foco.
import { registrarManejadoresDeArbol } from "@/shell/keyboard-router";
import { AiChatPanel } from "./ai-chat-panel";
import { QueryHistoryContent } from "./query-history";
import { ResultTabsPanel } from "./result-tabs-panel";
import { StatusBar } from "./status-bar";
import { SqlLogTab } from "./sql-log-tab";
import { TabBar } from "./tab-bar";
// Fase 15 (T7, D4): Help ▸ «Atajos de teclado» — la referencia generada del registro de atajos.
import { ShortcutsDialog } from "./shortcuts-dialog";
import { Panel, Group, Separator, useGroupRef, usePanelRef, type PanelImperativeHandle } from "react-resizable-panels";
import { cn } from "@/lib/utils";
// Fase 8 (R34): iconos de IntelliJ y propios (T5); ya no queda lucide en el chrome.
import { IjIcon } from "@/components/ij-icon";
import { AppearanceDialog } from "@/components/appearance-dialog";
import { OwnEditorDemo } from "@/components/own-editor/own-editor-demo";
// Fase 9 (R12): barra de tool windows y store del layout (persistente).
import { ToolWindowBar } from "@/components/tool-window-bar";
import {
  commitGroupLayout,
  getLayoutState,
  hideToolWindow,
  onLayoutReset,
  showToolWindow,
  useLayoutState,
} from "@/shell/layout-store";
import {
  DEFAULT_GROUP_SIZES,
  LAYOUT_GROUPS,
  floatingWindows,
  isDockOccupied,
  type ToolWindowId,
} from "@/shell/layout";
// Fase 15 (T6, #68): el ciclo de pestañas de ⌘⇧] / ⌘⇧[, puro y testeado (`src/shell/tabs.ts`).
import { pestanaDestino } from "@/shell/tabs";




/**
 * Fase 9 (T4): sincroniza el Panel de un dock con su visibilidad en el store. Al abrirlo, `expand()` y después
 * `resize()` al último tamaño guardado: `expand()` de react-resizable-panels solo recuerda el tamaño previo si el
 * colapso fue con `collapse()` en la MISMA sesión; tras reiniciar con el dock oculto, o tras colapsarlo
 * arrastrando, lo abre a su `minSize` (medido: el explorador volvía con 139 px en vez de sus 426). El `resize()` es
 * programático, así que `onLayoutChanged` no lo guarda (no pisa nada). `isCollapsed()` evita llamadas de más: un
 * `expand()` sobre un panel abierto re-recalcula el layout y pierde el arrastre en curso.
 */
function syncDockPanel(panel: PanelImperativeHandle | null, open: boolean, group: string, panelId: string) {
  if (!panel) return;
  if (!open) {
    if (!panel.isCollapsed()) panel.collapse();
    return;
  }
  if (!panel.isCollapsed()) return;
  panel.expand();
  const size = getLayoutState().sizes[group]?.[panelId] ?? DEFAULT_GROUP_SIZES[group]?.[panelId] ?? 0;
  // El dock derecho de fábrica guarda 0 (vacío y colapsado): ahí basta con el expand() a su mínimo.
  if (size >= 1) panel.resize(`${size}%`);
}

export function AppShell() {
  // Fase 7, T10: panel «Apariencia».
  const [appearanceOpen, setAppearanceOpen] = React.useState(false);
  /** Spike F2-B: el editor propio, a pantalla completa. Se abre desde la paleta (⌘K). */
  const [ownEditorOpen, setOwnEditorOpen] = React.useState(false);
  // Fase 15 (T7, D4): Help ▸ «Atajos de teclado». Lo abre la acción de menú `help.shortcuts`.
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  // Fase 70 (T1): el modal «Conexiones» (lista + formulario). `gestordb:new-connection`
  // (menú File ▸ New Connection…) lo abre igual que el botón «Conexiones…» del top bar.
  const [connectionsOpen, setConnectionsOpen] = React.useState(false);
  React.useEffect(() => {
    const abrir = () => setConnectionsOpen(true);
    window.addEventListener("gestordb:new-connection", abrir);
    return () => window.removeEventListener("gestordb:new-connection", abrir);
  }, []);
  React.useEffect(() => {
    const abrir = () => setOwnEditorOpen(true);
    window.addEventListener("gdb:spike-editor", abrir);
    return () => window.removeEventListener("gdb:spike-editor", abrir);
  }, []);
  const state = useAppState();
  const dispatch = useAppDispatch();
  const hydrated = useHydrated();
  const activeConsole = getActiveConsole(state);

  /*
    Fase 70 (T1, criterio 5) + decisión del usuario (2026-10-20): al arrancar, si ya hay perfiles
    guardados, la consola activa se conecta con el PRIMERO y el modal NO se impone — como
    DataGrip, que abre con la última conexión viva y no con un diálogo. Solo si no hay NINGÚN
    perfil (primera ejecución) se abre el modal para crear la primera conexión.

    Se intenta UNA vez: si el perfil guardado no conecta (contraseña migrada a otra Mac, servidor
    caído), no se reintenta en bucle — se abre el modal con el perfil seleccionado para que el
    usuario vea el error y lo arregle. La consola destino es la ACTIVA (al arrancar es la
    «Consola 1» recién creada), no una capturada.
  */
  const activeConsoleRef = React.useRef(activeConsole);
  const arranqueAtendido = React.useRef(false);
  /** El estado al hidratar: el efecto de arranque mira si hay consolas atadas (R91). */
  const estadoInicialRef = React.useRef(state);
  React.useEffect(() => {
    estadoInicialRef.current = state;
  }, [state]);
  React.useEffect(() => {
    if (arranqueAtendido.current || !hydrated) return;
    arranqueAtendido.current = true;
    let vigente = true;
    (async () => {
      try {
        // R91 (conexión perezosa): si alguna consola restaurada ya está atada a una conexión, NO se
        // conecta nada al arrancar — cada consola se conecta sola al ejecutar. El arranque con el
        // primer perfil queda solo para la primera vez (ninguna consola atada).
        if (estadoInicialRef.current.consoles.some((c) => c.binding || c.session)) {
          // R18: las consolas restauradas traen una COPIA del nombre y color del perfil de cuando se
          // guardaron; se refrescan con los actuales para que el explorador se tiña con el color
          // vigente. Solo LEE los perfiles (no conecta nada: R91 sigue siendo perezosa) y un fallo
          // aquí no abre el modal de conexiones —las consolas ya tienen conexión—, solo se registra.
          try {
            const perfiles = await listProfiles();
            if (!vigente) return;
            for (const p of perfiles) {
              dispatch({ type: "REFRESCAR_PERFIL", payload: { id: p.id, name: p.name, color: p.color } });
            }
          } catch (err) {
            console.warn("[R18] no se pudieron releer los perfiles para refrescar sus colores:", err);
          }
          return;
        }
        const perfiles = await listProfiles();
        if (!vigente) return;
        if (perfiles.length === 0) {
          setConnectionsOpen(true);
          return;
        }
        const session = await apiConnect(perfiles[0].id);
        if (!vigente) return;
        dispatch({
          type: "SET_SESSION",
          payload: { consoleId: activeConsoleRef.current.id, session },
        });
      } catch {
        if (vigente) setConnectionsOpen(true);
      }
    })();
    return () => {
      vigente = false;
    };
    // Corre UNA vez al hidratar: ni `state` ni nada más debería re-lanzarla.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);
  // La sesión "activa" ahora es la de la consola con foco. Ya no existe una
  // sesión global: cada consola tiene la suya (multi-conexión simultánea).
  const session = activeConsole.session;
  // Con multi-conexión, la UI principal se muestra si AL MENOS UNA consola
  // tiene sesión (ver el early return más abajo). Se calcula aquí arriba porque el efecto del
  // explorador (fase 9) necesita re-ejecutarse cuando la shell aparece: la primera vez que corre
  // todavía no hay panel montado y el ref está vacío.
  // R91: una consola DORMIDA (atada a un perfil, sin sesión viva) también cuenta: al reabrir la app
  // no hay ninguna sesión y la shell tiene que montarse igual, con cada consola en su conexión.
  const anyConnected = state.consoles.some((c) => c.session !== null || c.binding !== null);
  const binding = activeConsole.binding;
  const resultsPanelRef = usePanelRef();
  // Fase 9 (R12): el explorador y el dock inferior son tool windows; su visibilidad vive en el store.
  const schemaPanelRef = usePanelRef();
  const layout = useLayoutState();
  // Fase 9 (T2): la visibilidad de un dock es «alguna de SUS tool windows lo ocupa», no la de una en
  // concreto: con el explorador oculto pero Guardadas o IA visibles, el dock izquierdo sigue en pie
  // (medido: si no, el panel se colapsaba y las otras dos quedaban invisibles dentro de un ancho 0).
  // T3: «ocupar» es estar visible Y Fijada; una No fijada abierta flota encima y no le reserva sitio.
  const leftDockVisible = isDockOccupied(layout, "left");
  const bottomDockVisible = isDockOccupied(layout, "bottom");
  const rightDockVisible = isDockOccupied(layout, "right");
  const rightPanelRef = usePanelRef();
  // La No fijada abierta (como mucho una: abrir otra cierra la anterior).
  const floating = floatingWindows(layout)[0] ?? null;

  // Fase 9 (T4, R12): tamaños persistentes. react-resizable-panels v4 no trae `autoSaveId`: cada Group recibe un
  // id estable, su `defaultLayout` sale del store AL MONTAR y `onLayoutChanged` guarda lo que mueve el usuario.
  // `defaultLayout` se lee una vez por montaje (useMemo atado a que el grupo exista): pasarle un valor nuevo en
  // cada render no aporta nada y el layout vivo ya es el de la librería. El grupo principal aparece al haber una
  // sesión; el vertical se desmonta y se vuelve a montar al cambiar entre la pestaña SQL y una de tabla, así que
  // al volver recupera lo último guardado (antes volvía siempre al 45/55 de fábrica).
  const sqlTabActive = state.activeTabId === "sql";
  const isMongoConsole =
    activeConsole.session?.type === "mongodb" ||
    (!activeConsole.session && activeConsole.binding?.type === "mongodb");
  const mainGroupRef = useGroupRef();
  const editorGroupRef = useGroupRef();
  const mainDefaultLayout = React.useMemo(
    () => (anyConnected ? getLayoutState().sizes[LAYOUT_GROUPS.main] : undefined) ?? DEFAULT_GROUP_SIZES[LAYOUT_GROUPS.main],
    [anyConnected]
  );
  const editorDefaultLayout = React.useMemo(
    () => (sqlTabActive && !isMongoConsole ? getLayoutState().sizes[LAYOUT_GROUPS.editor] : undefined) ?? DEFAULT_GROUP_SIZES[LAYOUT_GROUPS.editor],
    [sqlTabActive, isMongoConsole]
  );

  React.useEffect(
    () =>
      // «Restablecer layout»: los grupos ya montados no releen `defaultLayout`, hay que fijarlo a mano. Los
      // tamaños de fábrica son coherentes con la visibilidad de fábrica (explorador abierto, derecha vacía).
      onLayoutReset(() => {
        mainGroupRef.current?.setLayout(DEFAULT_GROUP_SIZES[LAYOUT_GROUPS.main]);
        editorGroupRef.current?.setLayout(DEFAULT_GROUP_SIZES[LAYOUT_GROUPS.editor]);
      }),
    [mainGroupRef, editorGroupRef]
  );
  // La pestaña de resultado más reciente: cuando aparece una nueva, el dock inferior se trae al frente.
  const lastResultTabId = activeConsole.resultTabs[activeConsole.resultTabs.length - 1]?.id ?? null;
  const [txMode, setTxMode] = React.useState<"auto" | "manual">("auto");
  const [fkQuickTarget, setFkQuickTarget] = React.useState<FkQuickTarget | null>(null);

  // Fase 6 (R5): el menú nativo. `useMenuActions` escucha lo que elige el usuario en la barra de
  // macOS; `useMenuState` le dice a `main` qué entradas tienen sentido ahora mismo para que el
  // resto salgan en gris en vez de quedarse mudas.
  useMenuActions();
  useMenuState(
    React.useMemo(
      () => ({
        // R91: la consola DORMIDA también puede ejecutar (se conecta sola): sin esto el menú
        // nativo dejaba ⌘⏎ en gris con la consola atada pero sin sesión.
        connected: session !== null || binding !== null,
        queryRunning: state.running,
        txManual: txMode === "manual",
        txActive: state.transactionActive,
        hasSql: activeConsole.sql.trim().length > 0,
      }),
      [session, binding, state.running, txMode, state.transactionActive, activeConsole.sql]
    )
  );

  React.useEffect(() => {
    activeConsoleRef.current = activeConsole;
  }, [activeConsole]);

  React.useEffect(() => {
    // Fase 9 (T2): el dock inferior (resultados/historial) se colapsa cuando ninguna de sus tool windows
    // está visible. T4: `sqlTabActive` e `isMongoConsole` en las deps porque su Group se desmonta con una
    // pestaña de tabla o consola Mongo y se vuelve a montar al regresar a SQL: sin re-sincronizar, un dock
    // inferior oculto reaparecía abierto.
    syncDockPanel(resultsPanelRef.current, bottomDockVisible, LAYOUT_GROUPS.editor, "sql-results-panel");
  }, [bottomDockVisible, resultsPanelRef, anyConnected, sqlTabActive, isMongoConsole]);

  React.useEffect(() => {
    // Fase 9 (R12): el explorador (tool window) sigue al store del layout. `isCollapsed()` evita
    // llamadas redundantes: collapse() sobre un panel ya colapsado no hace nada, pero expand() sobre uno
    // abierto re-recalcula el layout y pierde el arrastre en curso.
    // `anyConnected` en las deps: la shell (y con ella el Panel) no existe hasta que hay una sesión, así
    // que el efecto tiene que volver a correr cuando aparece — si no, un explorador oculto guardado se
    // pinta expandido tras arrancar (medido). T4: al abrirlo, con su tamaño guardado (ver syncDockPanel).
    syncDockPanel(schemaPanelRef.current, leftDockVisible, LAYOUT_GROUPS.main, "schema-panel");
  }, [leftDockVisible, schemaPanelRef, anyConnected]);

  React.useEffect(() => {
    // Fase 9 (T3): el dock derecho sigue reservado al value editor (fase 12), pero «Mover a ▸ Derecha» ya
    // puede llevar ahí cualquier tool window. Mismo patrón que el izquierdo (deps con `anyConnected`).
    syncDockPanel(rightPanelRef.current, rightDockVisible, LAYOUT_GROUPS.main, "right-panel");
  }, [rightDockVisible, rightPanelRef, anyConnected]);

  React.useEffect(() => {
    // Fase 9 (T2): como DataGrip, ejecutar una query trae al frente «Resultados» en el dock inferior
    // (si estaba oculta se reabre: es el comportamiento por defecto del IDE al lanzar algo).
    if (lastResultTabId) showToolWindow("results");
  }, [lastResultTabId]);

  const validatedSessionRef = React.useRef<string | null>(null);

  /**
   * Fase 9 (T3): contenido de cada tool window, por id. Con «Mover a ▸ …» cualquiera puede vivir en cualquier
   * dock o flotar (No fijada), así que los docks y el overlay comparten este único selector.
   */
  const renderToolWindow = (id: ToolWindowId): React.ReactNode => {
    switch (id) {
      case "explorer":
        return <SchemaTree />;
      case "saved":
        return <SavedQueriesPanel />;
      case "ai":
        return <AiChatPanel />;
      case "history":
        return <QueryHistoryContent />;
      // Fase 12 (T3): el value editor del dock derecho. No recibe props — lee la celda enfocada del
      // store `lib/focused-cell`, porque quien la publica es `results-grid` y hay DOS instancias
      // suyas (el panel de resultados y la pestaña de ver tabla).
      case "value":
        return <ValueEditorPanel />;
      case "results":
        return (
          <ResultTabsPanel
            onNavigateFk={handleNavigateFk}
            onRefresh={refreshSqlResults}
            onPageChange={handlePageChange}
            minimized={false}
            onToggleMinimize={() => hideToolWindow("results")}
          />
        );
    }
  };

  React.useEffect(() => {
    // Re-validación de la sesión de la consola con foco: si expiró en el
    // server, se desconecta SOLO esa consola (las demás siguen intactas).
    if (!session) {
      validatedSessionRef.current = null;
      return;
    }
    const sessionId = session.sessionId;
    const consoleId = activeConsole.id;
    if (validatedSessionRef.current === sessionId) return;
    validatedSessionRef.current = sessionId;

    async function validate() {
      try {
        await apiGetSession(sessionId);
      } catch {
        // R91: la sesión se pierde pero la consola sigue ATADA a su perfil y base (el reducer
        // conserva la conexión dormida): se reconecta sola al ejecutar. Antes se perdía todo.
        dispatch({ type: "SET_SESSION", payload: { consoleId, session: null } });
        toast.info("La sesión se cerró; la consola se reconecta al ejecutar");
      }
    }
    validate();
  }, [session, activeConsole.id, dispatch]);

  const loadedForSessionRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    // Carga schema/databases/guardadas/historial de la sesión de la consola con
    // foco. Se re-ejecuta al cambiar de consola (dependencia en la sesión
    // activa), de modo que el árbol y el panel derecho siguen el foco.
    if (!session) {
      /*
        R91 — consola DORMIDA: no se conecta para pintar el explorador. Se enseña el esquema de la
        caché (el mismo que guardó la última sesión de ese perfil y base) y las consultas guardadas,
        que no necesitan sesión. Las bases y el historial llegan al conectar.
      */
      if (!binding) return;
      const dormida = { name: binding.name, type: binding.type, database: binding.database };
      const key = `dormida:${getSchemaCacheKey(dormida)}`;
      if (loadedForSessionRef.current === key) return;
      loadedForSessionRef.current = key;
      dispatch({ type: "SET_SCHEMA", payload: loadCachedSchema(dormida) });
      dispatch({ type: "SET_DATABASES", payload: binding.database ? [binding.database] : [] });
      // R96: todas (el panel filtra por perfil); antes, filtradas por el nombre de la conexión.
      void listSavedQueries()
        .then((q) => dispatch({ type: "SET_SAVED_QUERIES", payload: q }))
        .catch((err) => console.error("[consola dormida] consultas guardadas", err));
      return;
    }
    const cacheKey = `viva:${getSchemaCacheKey(session)}`;
    if (loadedForSessionRef.current === cacheKey) return;
    loadedForSessionRef.current = cacheKey;

    const cached = loadCachedSchema(session);
    if (cached) {
      dispatch({ type: "SET_SCHEMA", payload: cached });
    }

    const s = session;
    async function load() {
      try {
        const [databases, savedQueries, queryHistory] = await Promise.all([
          listDatabases(s.sessionId),
          // R96: TODAS las consultas guardadas (el panel filtra por perfil en la vista). Antes se
          // pedían filtradas por el NOMBRE de la conexión, lo que perdía las de un perfil renombrado
          // y vaciaba «Todas» en cuanto se conectaba algo.
          listSavedQueries(),
          listQueryHistory(s.sessionId),
        ]);
        dispatch({ type: "SET_DATABASES", payload: databases });
        dispatch({ type: "SET_SAVED_QUERIES", payload: savedQueries });
        dispatch({ type: "SET_QUERY_HISTORY", payload: queryHistory });
        if (!cached) {
          const schema = await getSchema(s.sessionId);
          dispatch({ type: "SET_SCHEMA", payload: schema });
          saveCachedSchema(s, schema);
        }
      } catch (err) {
        toast.error(String(err));
      }
    }
    load();
  }, [session, binding, dispatch]);

  // El cambio de database y el switch de perfil se manejan ahora en
  // ConsoleConnectionBar (a la altura de la consola con foco), no aquí.

  // Desconectar es POR-CONSOLA: cierra la sesión de la consola con foco en el
  // server y le quita la sesión (sus result tabs se limpian en el reducer).
  // Las demás consolas y sus conexiones quedan intactas.
  async function handleDisconnect() {
    const consoleId = activeConsole.id;
    if (session) {
      await disconnect(session.sessionId).catch(() => undefined);
    }
    dispatch({ type: "DISCONNECT_CONSOLE", payload: { consoleId } });
    setTxMode("auto");
    toast.info("Consola desconectada");
  }

  async function handleTxModeChange(mode: "auto" | "manual") {
    if (!session) return;
    if (mode === txMode) return;

    if (mode === "auto" && state.transactionActive) {
      toast.error("Hay una transacción abierta: haz Commit o Rollback antes de volver a Auto");
      return;
    }

    setTxMode(mode);
    if (mode === "manual") {
      try {
        await apiBeginTransaction(session.sessionId);
        dispatch({ type: "SET_TRANSACTION_ACTIVE", payload: true });
        toast.info("Modo Manual: transacción abierta (BEGIN)");
      } catch (err) {
        setTxMode("auto");
        toast.error(String(err));
      }
    }
  }

  async function handleCommit() {
    if (!session) return;
    try {
      await apiCommitTransaction(session.sessionId);
      dispatch({ type: "SET_TRANSACTION_ACTIVE", payload: false });
      setTxMode("auto");
      toast.success("Transacción confirmada (COMMIT)");
    } catch (err) {
      toast.error(String(err));
    }
  }

  async function handleRollback() {
    if (!session) return;
    try {
      await apiRollbackTransaction(session.sessionId);
      dispatch({ type: "SET_TRANSACTION_ACTIVE", payload: false });
      setTxMode("auto");
      toast.success("Transacción revertida (ROLLBACK)");
    } catch (err) {
      toast.error(String(err));
    }
  }

  function handleNewQuery() {
    dispatch({ type: "NEW_CONSOLE", payload: { id: crypto.randomUUID() } });
  }
  /**
   * Fase 15 (T6, #68): ⌘⇧] / ⌘⇧[ — pestaña SIGUIENTE / ANTERIOR con vuelta al principio/final.
   *
   * «Pestañas» son lo que pinta `TabBar`, en su orden: primero las consolas (la consola activa se ve
   * como su pestaña «sql») y después las pestañas de tabla (consultas, ver tabla, diagramas, log).
   * Se activa la de destino con las MISMAS acciones que usa un clic en la tira: `SET_ACTIVE_CONSOLE`
   * para una consola (que además vuelve a la vista SQL) y `SET_ACTIVE_TAB` para una pestaña de tabla.
   * Si la pestaña actual no está en la tira (estado imposible en la práctica), se va a la primera.
   *
   * La CUENTA vive en `src/shell/tabs.ts` (pura y testeada: `tabs.test.ts` fija el ciclo, los
   * extremos y los casos de 0 y 1 pestañas); aquí solo se traduce su destino a la acción del
   * reducer. Antes la cuenta estaba en línea en este componente y no se podía probar sin montar
   * la app.
   */
  function activarPestanaDeLaTira(delta: 1 | -1) {
    const destino = pestanaDestino(
      {
        consolas: state.consoles.map((c) => c.id),
        pestanas: state.tableTabs.map((t) => t.id),
        consolaActiva: state.activeConsoleId,
        pestanaActiva: state.activeTabId,
      },
      delta
    );
    if (!destino) return;
    if (destino.kind === "console") dispatch({ type: "SET_ACTIVE_CONSOLE", payload: destino.id });
    else dispatch({ type: "SET_ACTIVE_TAB", payload: destino.id });
  }
  /*
    Fase 6 (R5, T3): el menú nativo vive en el proceso `main` y no puede llamar a estos closures,
    que son locales de AppShell (el modo de transacción, de hecho, es un `useState` de aquí y no
    del estado global). Se publican como eventos de `window`, que es el mismo mecanismo que ya usa
    la paleta de comandos para hablar con el editor. No hay lógica nueva: cada listener llama al
    manejador que ya existía.

    `use-menu-actions.ts` es quien traduce la acción del menú a estos eventos; aquí solo se
    escuchan.
  */
  React.useEffect(() => {
    const onNewConsole = () => handleNewQuery();
    const onCommandPalette = () => dispatch({ type: "SET_COMMAND_OPEN", payload: true });
    const onAppearance = () => setAppearanceOpen(true);
    const onTxAuto = () => void handleTxModeChange("auto");
    const onTxManual = () => void handleTxModeChange("manual");
    const onCommit = () => void handleCommit();
    const onRollback = () => void handleRollback();
    const onDisconnect = () => void handleDisconnect();
    // Fase 15 (T6/T7): pestañas de la tira y la referencia de atajos. Los dos primeros necesitan el
    // ESTADO de la app (consolas + pestañas de tabla), que sólo vive aquí; el tercero abre el
    // diálogo, que también se monta aquí. `use-menu-actions` sólo emite el evento.
    const onNextTab = () => activarPestanaDeLaTira(1);
    const onPrevTab = () => activarPestanaDeLaTira(-1);
    const onShortcuts = () => setShortcutsOpen(true);

    window.addEventListener("gestordb:new-console", onNewConsole);
    window.addEventListener("gestordb:command-palette", onCommandPalette);
    window.addEventListener("gestordb:appearance", onAppearance);
    window.addEventListener("gestordb:tx-auto", onTxAuto);
    window.addEventListener("gestordb:tx-manual", onTxManual);
    window.addEventListener("gestordb:commit", onCommit);
    window.addEventListener("gestordb:rollback", onRollback);
    window.addEventListener("gestordb:disconnect", onDisconnect);
    window.addEventListener("gestordb:next-tab", onNextTab);
    window.addEventListener("gestordb:prev-tab", onPrevTab);
    window.addEventListener("gestordb:shortcuts", onShortcuts);
    return () => {
      window.removeEventListener("gestordb:new-console", onNewConsole);
      window.removeEventListener("gestordb:command-palette", onCommandPalette);
      window.removeEventListener("gestordb:appearance", onAppearance);
      window.removeEventListener("gestordb:tx-auto", onTxAuto);
      window.removeEventListener("gestordb:tx-manual", onTxManual);
      window.removeEventListener("gestordb:commit", onCommit);
      window.removeEventListener("gestordb:rollback", onRollback);
      window.removeEventListener("gestordb:disconnect", onDisconnect);
      window.removeEventListener("gestordb:next-tab", onNextTab);
      window.removeEventListener("gestordb:prev-tab", onPrevTab);
      window.removeEventListener("gestordb:shortcuts", onShortcuts);
    };
    // Los manejadores son funciones del cuerpo del componente (no useCallback): se vuelven a
    // registrar en cada render, que es barato y evita cerrar sobre estado viejo.
  });

  // Al cambiar de consola con foco (o conectar/reconectar la activa), sincroniza
  // si el server ya tenía una transacción abierta para esa sesión.
  React.useEffect(() => {
    if (!session) return;
    getTransactionStatus(session.sessionId)
      .then(({ active }) => {
        dispatch({ type: "SET_TRANSACTION_ACTIVE", payload: active });
        setTxMode(active ? "manual" : "auto");
      })
      .catch((err) => {
        // Fase 3 (T1): antes `.catch(() => undefined)` — en Electron esta llamada fallaba siempre (no había canal)
        // y nadie se enteraba. Sigue sin bloquear la UI (el indicador se queda como estaba), pero queda registrado.
        console.error("[tx] No se pudo leer el estado de la transacción", err);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.sessionId]);

  async function handleRefreshSchema() {
    if (!session) return;
    const s = session;
    try {
      const [databases, schema] = await Promise.all([
        listDatabases(s.sessionId),
        getSchema(s.sessionId),
      ]);
      dispatch({ type: "SET_DATABASES", payload: databases });
      dispatch({ type: "SET_SCHEMA", payload: schema });
      saveCachedSchema(s, schema);
      toast.success("Schema actualizado");
    } catch (err) {
      toast.error(String(err));
    }
  }

  /*
    Fase 15 (T5, #18): el `⌘R` del ÁRBOL entra por el enrutador de teclado (contexto `arbol` del
    registro) y ejecuta el MISMO refresco que el botón del header: `handleRefreshSchema`, que vive
    aquí porque necesita la sesión de la consola con foco y el `dispatch`. El enrutador no conoce a
    este componente; se registra el manejador y él lo llama cuando el foco está dentro del árbol
    (`data-testid="schema-tree"`).

    El efecto va SIN array de dependencias a propósito —igual que el de los listeners de
    `gestordb:*` de arriba—: el manejador es una clausura sobre el render, y registrarlo de nuevo
    (una asignación de módulo) es más barato que enumerar dependencias y arriesgar un cierre con la
    `session` vieja. Devuelve la baja, así que al desmontar no queda un manejador colgado.
  */
  React.useEffect(() => {
    return registrarManejadoresDeArbol({
      refrescar: () => {
        // Sin sesión no hay nada que refrescar y la tecla NO se consume (el árbol ni siquiera
        // tiene filas). Con sesión, el camino es el del botón: `handleRefreshSchema`.
        if (!session) return false;
        void handleRefreshSchema();
        return true;
      },
    });
  });

  const refreshSqlResults = React.useCallback(async () => {
    // Opera sobre la consola con foco y su propia sesión (multi-conexión).
    const console_ = activeConsoleRef.current;
    let session = console_.session;
    const consoleId = console_.id;
    const activeTab = console_.resultTabs.find(
      (t) => t.id === console_.activeResultTabId
    );
    if (!session || !activeTab) return;

    // TS no rastrea el narrowing dentro de closures: aseguramos el tipo.
    const runWithReconnect = async (sql: string, s: NonNullable<typeof session>) => {
      let current = s;
      const MAX_RECONNECT = 1;
      for (let attempt = 0; attempt <= MAX_RECONNECT; attempt++) {
        try {
          return await apiRunQuery(current.sessionId, sql);
        } catch (err) {
          const msg = String(err);
          const isExpired =
            /session not found/i.test(msg) || /expir/i.test(msg);
          if (!isExpired || attempt >= MAX_RECONNECT || !current.profileId) {
            throw err;
          }
          toast.info("Sesión expirada — reconectando...");
          // R91: reabre el perfil Y la base en la que estaba (antes volvía a la base del perfil).
          const { session: newSession } = await wakeBinding({ profileId: current.profileId, database: current.database });
          current = newSession;
          session = newSession;
          dispatch({ type: "SET_SESSION", payload: { consoleId, session: newSession } });
        }
      }
      throw new Error("unreachable");
    };

    dispatch({ type: "SET_RUNNING", payload: true });
    dispatch({ type: "SET_QUERY_ERROR", payload: null });
    dispatch({ type: "SET_STATUS_MESSAGE", payload: "Ejecutando..." });
    try {
      const res = await runWithReconnect(activeTab.sql, session);
      dispatch({ type: "ADD_RESULT_TAB", payload: { ...activeTab, result: res } });
      dispatch({
        type: "SET_STATUS_MESSAGE",
        payload: `${res.rowCount ?? 0} fila(s) en ${res.durationMs}ms`,
      });
      toast.success(`Refrescado: ${res.rowCount} fila(s)`);
    } catch (err) {
      dispatch({ type: "SET_QUERY_ERROR", payload: String(err) });
      dispatch({ type: "SET_STATUS_MESSAGE", payload: String(err) });
      toast.error(String(err));
    } finally {
      dispatch({ type: "SET_RUNNING", payload: false });
    }
  }, [dispatch]);

  const handlePageChange = React.useCallback(
    async (tabId: string, direction: "next" | "prev") => {
      const console_ = activeConsoleRef.current;
      let session = console_.session;
      const consoleId = console_.id;
      const tab = console_.resultTabs.find((t) => t.id === tabId);
      if (!session || !tab) return;

      const pageSize = tab.result.effectiveLimit || 500;
      const currentOffset = tab.offset ?? 0;
      const nextOffset =
        direction === "next"
          ? currentOffset + pageSize
          : Math.max(0, currentOffset - pageSize);

      if (direction === "prev" && nextOffset === currentOffset) return;

      const runWithReconnect = async (
        sql: string,
        offset: number,
        s: NonNullable<typeof session>
      ) => {
        let current = s;
        const MAX_RECONNECT = 1;
        for (let attempt = 0; attempt <= MAX_RECONNECT; attempt++) {
          try {
            return await apiRunQuery(current.sessionId, sql, undefined, offset);
          } catch (err) {
            const msg = String(err);
            const isExpired = /session not found/i.test(msg) || /expir/i.test(msg);
            if (!isExpired || attempt >= MAX_RECONNECT || !current.profileId) {
              throw err;
            }
            toast.info("Sesión expirada — reconectando...");
            // R91: reabre el perfil Y su base (antes volvía a la base de fábrica del perfil).
            const { session: newSession } = await wakeBinding({ profileId: current.profileId, database: current.database });
            current = newSession;
            session = newSession;
            dispatch({ type: "SET_SESSION", payload: { consoleId, session: newSession } });
          }
        }
        throw new Error("unreachable");
      };

      try {
        const res = await runWithReconnect(tab.sql, nextOffset, session);
        dispatch({
          type: "ADD_RESULT_TAB",
          payload: { ...tab, result: res, offset: nextOffset },
        });
      } catch (err) {
        toast.error(String(err));
      }
    },
    [dispatch]
  );



  function handleNavigateFk(schema: string, table: string, column: string, value: unknown) {
    setFkQuickTarget({ schema, table, column, value });
  }

  function handleOpenFkInTab(target: FkQuickTarget) {
    dispatch({
      type: "OPEN_TABLE_TAB",
      payload: {
        schema: target.schema,
        table: target.table,
        whereColumn: target.column,
        whereValue: target.value,
      },
    });
  }

  if (!hydrated) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        Cargando...
      </div>
    );
  }

  // Con multi-conexión, la UI principal se muestra si AL MENOS UNA consola
  // tiene sesión. Si NINGUNA consola está conectada, la app arranca con la BARRA y el MODAL de
  // conexiones abierto (fase 70, criterio 5): la pantalla de conexión a página completa deja de
  // existir en el flujo de arranque. Es el mismo patrón que DataGrip: ventana vacía + diálogo de
  // fuentes de datos. Al conectar, el estado cambia y la shell normal se monta.
  if (!anyConnected) {
    return (
      <div className="flex h-screen flex-col overflow-hidden bg-background">
        <AppTopBar
          onOpenConnections={() => setConnectionsOpen(true)}
          onOpenAppearance={() => setAppearanceOpen(true)}
        />
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
          <IjIcon name="database" size={32} className="opacity-40" />
          <p>Sin conexiones abiertas</p>
          <p className="text-xs">Abre una conexión con «Conexiones…» en la barra superior.</p>
        </div>
        <AppearanceDialog open={appearanceOpen} onOpenChange={setAppearanceOpen} />
        <ConnectionsModal open={connectionsOpen} onOpenChange={setConnectionsOpen} />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/*
        Fase 70 (T2, R70): la BARRA SUPERIOR ÚNICA sustituye al header viejo (dos alturas,
        botones grandes de texto). `AppTopBar` trae el desplegable de conexión activa + el
        selector de base/esquema + las acciones de consola (Ejecutar/Cancelar/Todo/EXPLAIN/
        Formatear/Tx) + Conexiones…/+ /ajustes/IA. La toolbar de la CONSOLA se queda como
        fila fina (la segunda barra que se ve en la maqueta aprobada): sin sus botones de
        acción (ya viven arriba), con el nombre de la consulta guardada y el estado de guardado.
        Los stripes de tool windows pasan a los `children` del top bar.
      */}
      <AppTopBar
        onOpenConnections={() => setConnectionsOpen(true)}
        onOpenAppearance={() => setAppearanceOpen(true)}
      >
        {layout.bar === "header" && <ToolWindowBar variant="header" />}
      </AppTopBar>
      <AppearanceDialog open={appearanceOpen} onOpenChange={setAppearanceOpen} />
      {/* Fase 70 (T1): el modal «Conexiones» — lista + formulario, sustituye a la pantalla completa. */}
      <ConnectionsModal open={connectionsOpen} onOpenChange={setConnectionsOpen} />
      {ownEditorOpen && <OwnEditorDemo onClose={() => setOwnEditorOpen(false)} />}
      {/* Fase 15 (T7, D4): Help ▸ «Atajos de teclado». Se monta aquí y lo abre `help.shortcuts`. */}
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />

      {/* Fase 9 (D1): con la barra lateral, el contenido va al lado de la barra; el Group se estira. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {layout.bar === "side" && <ToolWindowBar variant="side" />}
        <div className="relative flex min-w-0 flex-1 overflow-hidden">
        <Group
          id={LAYOUT_GROUPS.main}
          orientation="horizontal"
          groupRef={mainGroupRef}
          defaultLayout={mainDefaultLayout}
          onLayoutChanged={(sizes, meta) => commitGroupLayout(LAYOUT_GROUPS.main, sizes, meta.isUserInteraction)}
          className="relative flex flex-1 overflow-hidden"
        >
        <Panel
          id="schema-panel"
          defaultSize="22"
          minSize="10"
          maxSize="70"
          collapsible
          collapsedSize="0"
          panelRef={schemaPanelRef}
          className="min-w-0 border-r border-border bg-sidebar"
        >
          {/* Fase 9 (T2): el dock izquierdo hospeda Explorador, Guardadas e IA (D4/D5). */}
          <ToolWindowDock dock="left">{renderToolWindow}</ToolWindowDock>
        </Panel>
        <Separator className={cn("relative w-px cursor-col-resize bg-gdb-sep transition-colors hover:bg-gdb-accent data-[resize-handle-active]:bg-gdb-accent after:absolute after:inset-y-0 after:-inset-x-1 after:content-['']", !leftDockVisible && "w-0")} />

        <Panel id="main-panel" defaultSize="78" minSize="20" className="relative flex min-w-0 flex-col bg-background">
          <TabBar />

          <div className="min-h-0 flex-1">
            {state.activeTabId === "sql" ? (
              isMongoConsole ? (
                /* Fase 80: Mongo no escribe SQL ni usa el dock inferior de resultados SQL; ocupa toda el área. */
                activeConsole.session?.type === "mongodb" ? (
                  <MongoConsole session={activeConsole.session} />
                ) : (
                  // R91: consola de Mongo DORMIDA. Su vista vive de la sesión (colecciones,
                  // documentos), así que se ofrece abrirla en vez de montarla vacía.
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
                    <IjIcon name="database" size={32} className="opacity-40" />
                    <p>
                      {activeConsole.binding?.name}
                      {activeConsole.binding?.database ? ` · ${activeConsole.binding.database}` : ""} — sin conectar
                    </p>
                    <button
                      type="button"
                      className="rounded border border-gdb-border px-2.5 py-1 text-gdb-fg hover:bg-gdb-hover"
                      onClick={() => {
                        const b = activeConsole.binding;
                        const consoleId = activeConsole.id;
                        if (!b) return;
                        void wakeBinding(b)
                          .then(({ session: s, databaseError }) => {
                            if (databaseError) toast.warning(`No se pudo abrir la base ${b.database}: ${databaseError}`);
                            dispatch({ type: "SET_SESSION", payload: { consoleId, session: s } });
                          })
                          .catch((err) => toast.error(String(err)));
                      }}
                    >
                      Conectar
                    </button>
                  </div>
                )
              ) : (
                /*
                  La consola SQL se muestra SIEMPRE que haya al menos una consola
                  conectada. Si la consola con foco no tiene sesión, su propia
                  barra de conexión (ConsoleConnectionBar dentro de SqlEditor)
                  muestra el estado "sin conectar" y el flujo para conectarla, sin
                  bloquear el editor ni las demás consolas.
                */
                <Group
                  id={LAYOUT_GROUPS.editor}
                  orientation="vertical"
                  groupRef={editorGroupRef}
                  defaultLayout={editorDefaultLayout}
                  onLayoutChanged={(sizes, meta) => commitGroupLayout(LAYOUT_GROUPS.editor, sizes, meta.isUserInteraction)}
                >
                  <Panel id="sql-editor-panel" defaultSize="45" minSize="15">
                    <SqlEditor txMode={txMode} />
                  </Panel>
                  <Separator className="relative h-px cursor-row-resize bg-gdb-sep transition-colors hover:bg-gdb-accent data-[resize-handle-active]:bg-gdb-accent after:absolute after:inset-x-0 after:-inset-y-1 after:content-['']" />
                  <Panel
                    id="sql-results-panel"
                    defaultSize="55"
                    minSize="15"
                    collapsible
                    collapsedSize="0"
                    panelRef={resultsPanelRef}
                  >
                    {/* Fase 9 (T2): dock inferior — Resultados e Historial, como pestañas (antes el historial
                        era un overlay sobre el editor y los resultados vivían solos). El «minimizar» de la tira
                        de resultados ahora oculta la tool window entera (modo Ocultar, D2); se restaura desde la
                        barra o desde el botón del header. */}
                    <ToolWindowDock dock="bottom">{renderToolWindow}</ToolWindowDock>
                  </Panel>
                </Group>
              )
            ) : (
              (() => {
                const tab = state.tableTabs.find((t) => t.id === state.activeTabId);
                if (!tab) return null;
                if (tab.kind === "diagram") return <ErDiagramTab tab={tab} />;
                if (tab.kind === "sqlLog") return <SqlLogTab />;

                const tabConsole =
                  (tab.consoleId ? state.consoles.find((c) => c.id === tab.consoleId) : undefined) ??
                  activeConsole;
                const tabEngine = (tabConsole.session ?? tabConsole.binding)?.type;

                if (tabEngine === "mongodb") {
                  return tabConsole.session ? (
                    /* Fase 81: en Mongo la «tabla» es una colección: la pestaña monta la vista de
                       documentos (barra de consulta + tarjetas), no la rejilla SQL. */
                    <MongoDocuments
                      key={tab.id}
                      pestanaId={tab.id}
                      session={tabConsole.session}
                      coleccion={tab.target.table}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center bg-editor text-xs text-gdb-fgmuted">
                      Esta colección pertenece a una consola de MongoDB desconectada. Reconéctala desde su consola para ver los documentos.
                    </div>
                  );
                }

                return <TableViewTab tab={tab} />;
              })()
            )}
          </div>
        </Panel>

        {/*
          Fase 9 (D4): dock derecho RESERVADO para el value editor (fase 12, R37): de fábrica no tiene ninguna
          tool window y queda colapsado. Desde T3 «Mover a ▸ Derecha» puede llevar ahí cualquiera.
        */}
        <Separator className={cn("relative w-px cursor-col-resize bg-gdb-sep transition-colors hover:bg-gdb-accent data-[resize-handle-active]:bg-gdb-accent after:absolute after:inset-y-0 after:-inset-x-1 after:content-['']", !rightDockVisible && "w-0")} />
        <Panel
          id="right-panel"
          defaultSize="0"
          minSize="15"
          maxSize="70"
          collapsible
          collapsedSize="0"
          panelRef={rightPanelRef}
          className="min-w-0 border-l border-border bg-sidebar"
        >
          <ToolWindowDock dock="right">{renderToolWindow}</ToolWindowDock>
        </Panel>
        </Group>
        {/* Fase 9 (T3): la tool window No fijada abierta flota encima del área de docks sin mover el layout. */}
        {floating && <ToolWindowOverlay key={floating} id={floating}>{renderToolWindow}</ToolWindowOverlay>}
        </div>
      </div>

      <StatusBar />
      <CommandPalette onDisconnect={handleDisconnect} />
      <FkQuickViewDialog
        target={fkQuickTarget}
        session={session}
        onClose={() => setFkQuickTarget(null)}
        onOpenInTab={handleOpenFkInTab}
      />
    </div>
  );
}
