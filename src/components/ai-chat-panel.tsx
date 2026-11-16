import * as React from "react";
import { dialectoSql, esMotorSql } from "@/shared/connection-net";
import { detectSqlRisk } from "@/lib/sql-safety";
import { isReadOnlyStatement } from "@/server/db/read-only-guard";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAppState, useAppDispatch, useActiveConsole } from "@/hooks/use-app-state";
import {
  askAi,
  askAiStream,
  MISSING_KEY_MESSAGE,
  makeUserChatMessage,
  makeAssistantChatMessage,
  loadAiChatHistory,
  saveAiChatHistory,
  clearAiChatHistory,
} from "@/lib/ai";
import { explainQuery } from "@/lib/api";
import { getActiveStatement } from "@/lib/sql-statements";
import { extractScopeTables } from "@/lib/sql-scope";
import { CodePreview } from "@/components/code-preview";
import { MarkdownContent } from "@/components/markdown-content";
import { AiSettingsDialog } from "@/components/ai-settings-dialog";
import { AI_PROVIDER_LABELS, activeModelOf } from "@/lib/ai-types";
import { cn } from "@/lib/utils";
import {
  SparklesIcon,
  SendIcon,
  SquareIcon,
  TrashIcon,
  MessageSquareIcon,
  FileInputIcon,
  CopyIcon,
  CheckIcon,
  XIcon,
  SettingsIcon,
  AlertTriangleIcon,
  FileDiffIcon,
  Wand2Icon,
  ChevronDownIcon,
  ChevronUpIcon,
} from "lucide-react";

type SqlDialectType = "postgres" | "mysql" | "sqlserver";

function dialectLabel(type: SqlDialectType | undefined): string {
  if (type === "postgres") return "PostgreSQL";
  if (type === "sqlserver") return "SQL Server";
  return "MySQL";
}

type DiffLine = { type: "same" | "remove" | "add"; text: string };

/** Calcula un diff línea a línea (LCS) entre el SQL actual del editor y la propuesta de la IA. */
function computeLineDiff(beforeText: string, afterText: string): DiffLine[] {
  const a = beforeText.split("\n");
  const b = afterText.split("\n");
  const m = a.length;
  const n = b.length;

  if (m * n > 40_000) {
    return [
      ...a.map((text): DiffLine => ({ type: "remove", text })),
      ...b.map((text): DiffLine => ({ type: "add", text })),
    ];
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "remove", text: a[i] });
      i++;
    } else {
      out.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < m) out.push({ type: "remove", text: a[i++] });
  while (j < n) out.push({ type: "add", text: b[j++] });
  return out;
}

/** Divide un mensaje en segmentos de texto/Markdown y bloques ```sql (estos se
 * extraen aparte porque llevan botón "Insertar en consola"; el resto del
 * markdown, incluidos otros bloques de código con lenguaje, se renderiza con
 * MarkdownContent). */
function splitContent(content: string): { kind: "text" | "sql"; value: string }[] {
  const segments: { kind: "text" | "sql"; value: string }[] = [];
  const re = /```sql\s*([\s\S]*?)```/gi;
  let last = 0;
  for (let m = re.exec(content); m; m = re.exec(content)) {
    if (m.index > last) {
      segments.push({ kind: "text", value: content.slice(last, m.index) });
    }
    segments.push({ kind: "sql", value: m[1].trim() });
    last = m.index + m[0].length;
  }
  if (last < content.length) {
    segments.push({ kind: "text", value: content.slice(last) });
  }
  return segments;
}

function insertSqlInConsole(sql: string) {
  window.dispatchEvent(new CustomEvent("gestordb:ai-insert-sql", { detail: sql }));
}

function replaceSqlInConsole(sql: string) {
  window.dispatchEvent(new CustomEvent("gestordb:ai-replace-sql", { detail: sql }));
}

interface SqlBlockProps {
  sql: string;
  activeSql?: string;
  readOnly?: boolean;
  canInsertInConsole?: boolean;
  sessionType?: string;
  onInsert: (sql: string) => void;
  onReplace?: (sql: string) => void;
}

function SqlBlock({
  sql,
  activeSql,
  readOnly,
  canInsertInConsole,
  sessionType,
  onInsert,
  onReplace,
}: SqlBlockProps) {
  const [copied, setCopied] = React.useState(false);
  const [showDiff, setShowDiff] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const risk = React.useMemo(() => detectSqlRisk(sql), [sql]);
  const readOnlyBlock = readOnly ? !isReadOnlyStatement(sql, sessionType) : false;
  const hasDiff = Boolean(activeSql?.trim() && activeSql.trim() !== sql.trim());
  const diffLines = React.useMemo(
    () => (showDiff && hasDiff && activeSql ? computeLineDiff(activeSql.trim(), sql.trim()) : null),
    [showDiff, hasDiff, activeSql, sql]
  );
  const lineCount = React.useMemo(() => sql.split("\n").length, [sql]);
  const displayedLineCount = showDiff && diffLines ? diffLines.length : lineCount;
  const isLong = displayedLineCount > 16;

  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-lg border border-border/60 bg-gdb-editor">
      <div className="flex flex-wrap items-center justify-between gap-1 border-b border-border/60 bg-muted/30 px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            SQL
          </span>
          {risk && (
            <span
              className="inline-flex items-center gap-1 rounded border border-gdb-warn/30 bg-gdb-warn/10 px-1.5 py-px text-[10px] font-medium text-gdb-warnfg"
              title={risk.message}
            >
              <AlertTriangleIcon className="size-2.5" />
              Riesgo
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {hasDiff && (
            <button
              type="button"
              onClick={() => setShowDiff((v) => !v)}
              className={cn(
                "flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors",
                showDiff
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              )}
              title="Comparar con el SQL activo del editor"
            >
              <FileDiffIcon className="size-3" />
              Diff
            </button>
          )}
          {canInsertInConsole && (
            <>
              <button
                type="button"
                onClick={() => onInsert(sql)}
                className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                title="Insertar este SQL en la consola, en la posición del cursor"
              >
                <FileInputIcon className="size-3" />
                Insertar
              </button>
              {onReplace && (
                <button
                  type="button"
                  onClick={() => onReplace(sql)}
                  disabled={readOnlyBlock}
                  className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-40"
                  title={
                    readOnlyBlock
                      ? "Conexión en modo solo lectura: no se puede reemplazar con una sentencia de escritura"
                      : "Reemplazar el statement activo en la consola"
                  }
                >
                  <Wand2Icon className="size-3" />
                  Reemplazar
                </button>
              )}
            </>
          )}
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(sql);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
            className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            title="Copiar SQL"
          >
            {copied ? <CheckIcon className="size-3 text-gdb-okfg" /> : <CopyIcon className="size-3" />}
            {copied ? "Copiado" : "Copiar"}
          </button>
        </div>
      </div>
      {showDiff && diffLines ? (
        <div
          className={cn(
            "py-1 font-jetbrains text-[12px] leading-5",
            isLong && !expanded ? "max-h-72 overflow-y-auto" : "max-h-none"
          )}
        >
          {diffLines.map((line, idx) => (
            <div
              key={idx}
              className={cn(
                "flex min-w-0 gap-2 whitespace-pre-wrap break-words px-3",
                line.type === "remove" && "bg-gdb-dangerbg text-gdb-dangerfg",
                line.type === "add" && "bg-gdb-okbg text-gdb-okfg",
                line.type === "same" && "text-muted-foreground"
              )}
            >
              <span className="w-3 shrink-0 select-none opacity-70">
                {line.type === "remove" ? "-" : line.type === "add" ? "+" : " "}
              </span>
              <span className="min-w-0 flex-1">{line.text || " "}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className={cn(isLong && !expanded ? "max-h-72 overflow-y-auto" : "max-h-none")}>
          <CodePreview value={sql} language="sql" wrapLines className="h-full" fontSize="13px" />
        </div>
      )}
      {isLong && (
        <div className="border-t border-border/60 bg-muted/20 px-3 py-1">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex w-full items-center justify-center gap-1 rounded py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {expanded ? (
              <>
                <ChevronUpIcon className="size-3" />
                Contraer
              </>
            ) : (
              <>
                <ChevronDownIcon className="size-3" />
                Mostrar todo ({displayedLineCount} líneas)
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

function Toggle({ checked, onChange, title }: { checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      title={title}
      className={cn(
        "relative h-4 w-7 shrink-0 rounded-full transition-colors",
        checked ? "bg-primary" : "bg-muted-foreground/30"
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-3 rounded-full bg-white transition-transform",
          checked ? "left-3.5" : "left-0.5"
        )}
      />
    </button>
  );
}

export function AiChatPanel() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const console_ = useActiveConsole();

  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  // Texto de razonamiento en vivo (modelos "thinking" como z-ai/glm-* o
  // deepseek-r1 mandan su cadena de pensamiento antes del contenido final).
  // Solo vive en memoria del componente: no se persiste ni se guarda en el
  // historial, es puramente un indicador visual de progreso.
  const [reasoning, setReasoning] = React.useState("");
  const [useFocusTables, setUseFocusTables] = React.useState(true);
  const [excludedTables, setExcludedTables] = React.useState<string[]>([]);
  const [excludedFor, setExcludedFor] = React.useState("");
  const [aiSettingsOpen, setAiSettingsOpen] = React.useState(false);
  const abortRef = React.useRef<AbortController | null>(null);
  const scrollRootRef = React.useRef<HTMLDivElement>(null);
  const stickToBottomRef = React.useRef(true);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // El chat IA opera sobre la conexión de la consola con foco (multi-conexión).
  const session = console_.session;
  const isSqlSession = esMotorSql(session?.type);
  const settings = state.aiSettings;

  const activeStatement = React.useMemo(() => {
    return getActiveStatement(console_.sql, console_.sql.length);
  }, [console_.sql]);

  const focusTables = React.useMemo(() => {
    if (!useFocusTables) return [];
    const excluded = excludedFor === activeStatement ? excludedTables : [];
    return extractScopeTables(activeStatement).filter(
      (t) => !excluded.includes(`${t.schema ?? ""}.${t.table}`)
    );
  }, [activeStatement, useFocusTables, excludedTables, excludedFor]);

  const schemaTableCount = React.useMemo(() => {
    if (!state.schema) return 0;
    return state.schema.reduce((acc, node) => acc + node.tables.length, 0);
  }, [state.schema]);

  // Gasto acumulado de ESTE chat: suma el costo real en USD (reportado por
  // OpenRouter) de cada respuesta del asistente, sin importar si el modelo
  // cambió entre turnos — cada mensaje ya lleva su propio costUsd. Se
  // persiste junto con el historial (aiMessages), así que sobrevive a
  // recargar la página mientras no se limpie la conversación.
  const totalCostUsd = React.useMemo(() => {
    return state.aiMessages.reduce((acc, msg) => acc + (msg.costUsd ?? 0), 0);
  }, [state.aiMessages]);

  // Auto-expandir el textarea según el contenido.
  React.useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  // El elemento que realmente hace scroll es el Viewport interno de
  // ScrollArea (Base UI), no el Root al que apunta la ref del componente.
  React.useEffect(() => {
    const viewport = scrollRootRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    );
    if (!viewport) return;
    const onScroll = () => {
      stickToBottomRef.current =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80;
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, []);

  React.useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    const viewport = scrollRootRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    );
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [state.aiMessages, busy, reasoning]);

  // Persistencia del historial por conexión: se carga al cambiar de sesión
  // y se guarda (con debounce) cada vez que cambian los mensajes.
  const loadedForRef = React.useRef<string | null>(null);
  const skipNextSaveRef = React.useRef(false);
  const connectionId = session?.name;

  // Abrir el diálogo de ajustes desde la paleta de comandos (gestordb:ai-settings
  // en sql-editor.tsx primero abre el chat y luego dispara este evento).
  React.useEffect(() => {
    const listener = () => setAiSettingsOpen(true);
    window.addEventListener("gestordb:ai-open-settings-dialog", listener);
    return () => window.removeEventListener("gestordb:ai-open-settings-dialog", listener);
  }, []);

  React.useEffect(() => {
    if (!connectionId || loadedForRef.current === connectionId) return;
    loadedForRef.current = connectionId;
    loadAiChatHistory(connectionId)
      .then((messages) => {
        if (messages.length > 0) {
          skipNextSaveRef.current = true;
          dispatch({ type: "SET_AI_MESSAGES", payload: [...messages].reverse() });
        }
      })
      // Fase 3: antes se tragaba en silencio; un historial que no carga queda registrado (el chat sigue usable).
      .catch((err) => console.error("[ai] No se pudo cargar el historial del chat", err));
  }, [connectionId, dispatch]);

  React.useEffect(() => {
    if (!connectionId) return;
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }
    const timer = setTimeout(() => {
      saveAiChatHistory(connectionId, [...state.aiMessages].reverse()).catch((err) =>
        console.error("[ai] No se pudo guardar el historial del chat", err)
      );
    }, 500);
    return () => clearTimeout(timer);
  }, [connectionId, state.aiMessages]);

  // Fase 9 (T2): la visibilidad la decide el dock izquierdo (layout-store); ya no hay guard de `aiChatOpen`.

  function excludeTable(key: string) {
    setExcludedFor(activeStatement);
    setExcludedTables((prev) => [...prev, key]);
  }

  async function handleSend() {
    // Fase 3 (D2): dos mensajes distintos en vez de «No hay sesión o API key configurada».
    if (!session) {
      toast.error("No hay una sesión activa");
      return;
    }
    if (!settings?.hasApiKey) {
      toast.error(MISSING_KEY_MESSAGE);
      return;
    }
    const prompt = input.trim();
    if (!prompt) return;

    stickToBottomRef.current = true;
    const userMsg = makeUserChatMessage(prompt);
    const assistantMsg = makeAssistantChatMessage("");
    dispatch({ type: "ADD_AI_MESSAGE", payload: userMsg });
    dispatch({ type: "ADD_AI_MESSAGE", payload: assistantMsg });
    setInput("");
    setBusy(true);
    setReasoning("");
    dispatch({ type: "SET_AI_BUSY", payload: true });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await askAiStream(
        {
          sessionId: session.sessionId,
          task: "chat",
          prompt,
          sql: isSqlSession && useFocusTables && activeStatement.trim() ? activeStatement : undefined,
          focusTables,
          history: [...state.aiMessages, userMsg].reverse(),
        },
        (chunk) => {
          // Al llegar el primer chunk de contenido real, el razonamiento ya
          // cumplió su propósito de indicador — lo limpiamos para no dejarlo
          // pegado arriba de la respuesta final.
          setReasoning("");
          dispatch({ type: "APPEND_AI_STREAM_CHUNK", payload: chunk });
        },
        controller.signal,
        (chunk) => setReasoning((prev) => prev + chunk),
        (message) => {
          // El server agotó maxTokens razonando sin llegar a responder:
          // se lo mostramos al usuario en el propio mensaje del asistente
          // (no solo un toast que puede perderse) y en un toast de error.
          setReasoning("");
          dispatch({ type: "APPEND_AI_STREAM_CHUNK", payload: `⚠️ ${message}` });
          toast.error(message);
        },
        (usage) => {
          dispatch({ type: "SET_AI_LAST_USAGE", payload: usage });
          if (usage.costUsd !== undefined) {
            dispatch({ type: "SET_LATEST_AI_MESSAGE_COST", payload: { costUsd: usage.costUsd } });
          }
        }
      );
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
      setReasoning("");
      dispatch({ type: "SET_AI_BUSY", payload: false });
      abortRef.current = null;
    }
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  function handleClear() {
    dispatch({ type: "CLEAR_AI_MESSAGES" });
    if (connectionId) {
      skipNextSaveRef.current = true;
      clearAiChatHistory(connectionId).catch(() => undefined);
    }
  }

  async function runTask(
    task: "explain-sql" | "convert-sql" | "optimize-sql",
    label: string,
    targetDialect?: SqlDialectType
  ) {
    if (!activeStatement || !session) {
      if (!activeStatement) toast.info(`No hay un statement activo para ${label.toLowerCase()}`);
      return;
    }
    stickToBottomRef.current = true;
    dispatch({ type: "ADD_AI_MESSAGE", payload: makeUserChatMessage(`${label}:\n\n${activeStatement}`) });
    setBusy(true);
    dispatch({ type: "SET_AI_BUSY", payload: true });
    try {
      const explainPlan =
        task === "optimize-sql"
          ? JSON.stringify(await explainQuery(session.sessionId, activeStatement), null, 2)
          : undefined;
      const res = await askAi({
        sessionId: session.sessionId,
        task,
        sql: activeStatement,
        explainPlan,
        targetDialect: task === "convert-sql" ? targetDialect : undefined,
        focusTables,
      });
      dispatch({
        type: "ADD_AI_MESSAGE",
        payload: { ...makeAssistantChatMessage(res.text), costUsd: res.usage?.costUsd },
      });
      if (res.usage) dispatch({ type: "SET_AI_LAST_USAGE", payload: res.usage });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      dispatch({ type: "SET_AI_BUSY", payload: false });
    }
  }

  return (
    <div data-testid="ai-chat-panel" className="flex h-full w-full flex-col bg-card">
      {/* Fase 9 (T2): la cabecera propia se retiró — la tool window vive en el dock izquierdo (pestaña con
          icono, título y ×). El chip del modelo sigue en la barra de contexto de abajo. */}

      {/* Contexto: esquema + tablas en foco + acciones (ajustes/limpiar) */}
      <div className="border-b bg-muted/20 px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground">
          <span title="Tablas del esquema incluidas como contexto">
            Esquema: {schemaTableCount} tablas
          </span>
          {isSqlSession && useFocusTables && activeStatement.trim() && (
            <>
              <span className="text-border">·</span>
              <span
                className="inline-flex items-center rounded border border-primary/30 bg-primary/10 px-1.5 py-px font-jetbrains text-[10px] text-primary"
                title={`SQL activo adjuntado:\n${activeStatement}`}
              >
                SQL activo
              </span>
            </>
          )}
          {focusTables.length > 0 && (
            <>
              <span className="text-border">·</span>
              <div className="flex flex-wrap items-center gap-1">
                {focusTables.map((t) => {
                  const key = `${t.schema ?? ""}.${t.table}`;
                  return (
                    <span
                      key={key}
                      className="inline-flex items-center gap-1 rounded border border-border/60 bg-muted/60 px-1.5 py-px font-jetbrains text-[10px]"
                    >
                      {t.schema ? `${t.schema}.` : ""}{t.table}
                      <button
                        type="button"
                        onClick={() => excludeTable(key)}
                        className="text-muted-foreground hover:text-foreground"
                        title="Quitar del foco"
                      >
                        <XIcon className="size-2.5" />
                      </button>
                    </span>
                  );
                })}
              </div>
            </>
          )}
          <div className="ml-auto flex items-center gap-2">
            <span className="flex items-center gap-1.5">
              <span className="hidden sm:inline">Contexto automático</span>
              <Toggle
                checked={useFocusTables}
                onChange={setUseFocusTables}
                title="Adjuntar/quitar las tablas del statement activo como foco del contexto"
              />
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setAiSettingsOpen(true)}
              disabled={settings?.enabled === false}
              title="Ajustes de IA"
            >
              <SettingsIcon className="size-3.5" />
            </Button>
          </div>
        </div>
      </div>

      <div ref={scrollRootRef} className="min-h-0 min-w-0 flex-1">
        <ScrollArea className="h-full">
          <div className="flex min-w-0 flex-col gap-5 p-3">
            {state.aiMessages.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
                <MessageSquareIcon className="size-8 opacity-20" />
                <p className="text-xs">Pregunta sobre tu esquema o pide ayuda con SQL.</p>
                <p className="text-[10px]">
                  El asistente conoce las tablas y columnas de la conexión activa.
                </p>
              </div>
            )}
            {[...state.aiMessages].reverse().map((msg, i) =>
              msg.role === "user" ? (
                <div key={i} className="flex min-w-0 flex-col items-end gap-1 pl-2">
                  <div className="min-w-0 max-w-[95%] rounded-2xl rounded-tr-sm border border-primary/25 bg-primary/15 px-3.5 py-2.5 text-[13px] leading-relaxed text-foreground shadow-sm">
                    <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{msg.content}</div>
                  </div>
                  <span className="mr-1 text-[10px] text-muted-foreground">Tú</span>
                </div>
              ) : (
                <div key={i} className="flex min-w-0 gap-3 pr-2">
                  <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted">
                    <SparklesIcon className="size-3.5 text-primary" />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                    <span className="text-xs font-medium text-muted-foreground">DataDB IA</span>
                    {splitContent(msg.content).map((seg, j) =>
                      seg.kind === "sql" ? (
                        <SqlBlock
                          key={j}
                          sql={seg.value}
                          activeSql={activeStatement}
                          readOnly={session?.readOnly}
                          canInsertInConsole={isSqlSession}
                          sessionType={session?.type}
                          onInsert={(sql) => {
                            dispatch({ type: "SET_ACTIVE_TAB", payload: "sql" });
                            // Esperar a que SqlEditor se monte si la pestaña activa no era SQL.
                            setTimeout(() => insertSqlInConsole(sql), 80);
                          }}
                          onReplace={(sql) => {
                            dispatch({ type: "SET_ACTIVE_TAB", payload: "sql" });
                            // Esperar a que SqlEditor se monte si la pestaña activa no era SQL.
                            setTimeout(() => replaceSqlInConsole(sql), 80);
                          }}
                        />
                      ) : seg.value.trim() ? (
                        <MarkdownContent key={j} content={seg.value} />
                      ) : null
                    )}
                  </div>
                </div>
              )
            )}
            {busy && (
              <div className="flex min-w-0 items-start gap-3 text-[11px] text-muted-foreground">
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted">
                  <SparklesIcon className="size-3.5 animate-pulse text-primary" />
                </span>
                {reasoning ? (
                  // Razonamiento en vivo del modelo (streaming de `delta.reasoning`):
                  // reemplaza el mensaje mudo "pensando…" con lo que el modelo va
                  // razonando de verdad, para que no parezca colgado en modelos
                  // "thinking" que tardan varios segundos antes del primer token
                  // de contenido real.
                  <div className="min-w-0 flex-1 rounded-md border border-border/40 bg-muted/20 px-2.5 py-1.5">
                    <div className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                      Razonando…
                    </div>
                    <div className="max-h-24 overflow-hidden whitespace-pre-wrap break-words text-muted-foreground/80 [mask-image:linear-gradient(to_bottom,black_60%,transparent)]">
                      {reasoning.slice(-600)}
                    </div>
                  </div>
                ) : (
                  <span className="animate-pulse">DataDB está pensando…</span>
                )}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {(state.aiLastUsage || totalCostUsd > 0) && (
        <div className="flex items-center gap-2 border-t px-3 py-1 font-jetbrains text-[10px] text-muted-foreground">
          {state.aiLastUsage && (
            <span title="Tokens de la última petición (prompt+completion)">
              tokens: {state.aiLastUsage.promptTokens}+{state.aiLastUsage.completionTokens}
            </span>
          )}
          {totalCostUsd > 0 && (
            <>
              {state.aiLastUsage && <span className="text-border">·</span>}
              <span
                className="font-semibold text-gdb-okfg"
                title="Gasto real acumulado en este chat (suma del costo de cada respuesta, aunque hayas cambiado de modelo)"
              >
                gastado: ${totalCostUsd < 0.01 ? totalCostUsd.toFixed(4) : totalCostUsd.toFixed(2)}
              </span>
            </>
          )}
        </div>
      )}

      {/* Acciones rápidas */}
      {isSqlSession && activeStatement.trim() && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border/40 px-3 pt-2 pb-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => void runTask("explain-sql", "Explica esta consulta")}
            className="flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <SparklesIcon className="size-3" />
            Explicar
          </button>
          {(["postgres", "mysql", "sqlserver"] as const)
            .filter((d) => d !== dialectoSql(session?.type))
            .map((targetDialect) => (
              <button
                key={targetDialect}
                type="button"
                disabled={busy}
                onClick={() =>
                  void runTask(
                    "convert-sql",
                    `Convierte esta consulta a ${dialectLabel(targetDialect)}`,
                    targetDialect
                  )
                }
                className="flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                <SparklesIcon className="size-3" />
                → {dialectLabel(targetDialect)}
              </button>
            ))}
          <button
            type="button"
            disabled={busy}
            onClick={() => void runTask("optimize-sql", "Optimiza esta consulta")}
            className="flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <SparklesIcon className="size-3" />
            Optimizar
          </button>
        </div>
      )}

      {/* Composer */}
      <div className="border-t p-3">
        <div className="flex min-h-[72px] flex-col rounded-xl border border-border/60 bg-muted/30 p-2.5 transition-colors focus-within:border-border focus-within:bg-muted/50">
          <textarea
            ref={textareaRef}
            data-ai-chat-composer
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Pregunta sobre tu esquema…"
            disabled={busy}
            rows={1}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                void handleSend();
              }
            }}
            className="w-full min-h-[20px] max-h-[200px] resize-none bg-transparent text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground"
          />
          {/* Pie del compositor. El grupo izquierdo puede encogerse (min-w-0) y los botones no: así nada empuja Enviar
              fuera del panel (pasó con el chip del modelo aquí: botón medido en x=394 con el panel acabando en 345). */}
          <div className="flex items-center justify-between gap-2 pt-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0 font-jetbrains text-[10px] text-muted-foreground">⌘↵ para enviar</span>
              <button
                type="button"
                onClick={handleClear}
                disabled={state.aiMessages.length === 0}
                title="Limpiar conversación"
                className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
              >
                <TrashIcon className="size-3" />
                Limpiar
              </button>
            </div>
            {busy ? (
              <button
                type="button"
                onClick={handleStop}
                className="flex size-7 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive transition-colors hover:bg-gdb-fail hover:text-gdb-onaccent"
                title="Detener"
              >
                <SquareIcon className="size-3" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={!input.trim()}
                className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
                title="Enviar"
              >
                <SendIcon className="size-3.5" />
              </button>
            )}
          </div>
        </div>
        {/* Fase 25 (D9, R24): proveedor y modelo activos, en su propia línea y a todo el ancho (en el pie del
            compositor quedaba truncado a «OpenRout…» en un panel de 305 px). Clic → Ajustes de IA. */}
        {settings && (
          <button
            type="button"
            data-testid="ai-chat-provider"
            onClick={() => setAiSettingsOpen(true)}
            title="Proveedor y modelo de IA (clic para cambiar)"
            className="mt-1.5 block w-full truncate rounded px-1 py-0.5 text-left font-jetbrains text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {AI_PROVIDER_LABELS[settings.provider] ?? "OpenRouter"} · {activeModelOf(settings).model || "sin modelo"}
          </button>
        )}
      </div>
      <AiSettingsDialog open={aiSettingsOpen} onOpenChange={setAiSettingsOpen} />
    </div>
  );
}

