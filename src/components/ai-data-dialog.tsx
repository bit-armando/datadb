import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CodePreview } from "@/components/code-preview";
import { MarkdownContent } from "@/components/markdown-content";
import { useAppDispatch, useActiveSession } from "@/hooks/use-app-state";
import { askAi, makeUserChatMessage, makeAssistantChatMessage } from "@/lib/ai";
import { columnKey } from "@/lib/query-columns";
import type { QueryResult, TableContext } from "@/lib/types";
import { AlertTriangleIcon, CopyIcon, FileInputIcon, SparklesIcon } from "lucide-react";

const ROW_LIMIT = 20;

export interface AiDataDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  result: QueryResult;
  tableContext: TableContext | null;
}

/**
 * Fase 6 del plan de IA: "Explicar/resumir este result set" y "Generar
 * agregado". Única excepción a la regla dura de no enviar filas de datos:
 * requiere confirmación explícita ANTES de mandar nada al proveedor.
 */
export function AiDataDialog({ open, onOpenChange, result, tableContext }: AiDataDialogProps) {
  const dispatch = useAppDispatch();
  // Conexión de la consola con foco: sobre ella corren las peticiones de IA.
  const session = useActiveSession();
  const [tab, setTab] = React.useState<"summarize" | "aggregate">("summarize");
  const [confirmed, setConfirmed] = React.useState(false);
  const [prompt, setPrompt] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [response, setResponse] = React.useState<{ text: string; sql?: string } | null>(null);

  const columns = result.columns.map((c) => columnKey(c));
  const rowCount = Math.min(ROW_LIMIT, result.rows.length);
  const tableName = tableContext
    ? tableContext.schema
      ? `${tableContext.schema}.${tableContext.table}`
      : tableContext.table
    : undefined;

  /* eslint-disable react-hooks/set-state-in-effect */
  React.useEffect(() => {
    if (!open) {
      setConfirmed(false);
      setPrompt("");
      setResponse(null);
    }
  }, [open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  async function handleSummarize() {
    if (!session) return;
    setBusy(true);
    try {
      const rows = result.rows.slice(0, ROW_LIMIT);
      const res = await askAi({
        sessionId: session.sessionId,
        task: "summarize-rows",
        columns,
        rows,
        prompt: prompt.trim() || undefined,
      });
      setResponse({ text: res.text, sql: res.sql });
      dispatch({
        type: "ADD_AI_MESSAGE",
        payload: makeUserChatMessage(
          `Resume estas ${rows.length} filas de ${tableName ?? "el resultado"}${prompt.trim() ? `: ${prompt.trim()}` : ""}`
        ),
      });
      dispatch({ type: "ADD_AI_MESSAGE", payload: makeAssistantChatMessage(res.text) });
      if (res.usage) dispatch({ type: "SET_AI_LAST_USAGE", payload: res.usage });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleAggregate() {
    if (!session) return;
    if (!prompt.trim()) {
      toast.info("Describe qué agregado o exportador quieres generar");
      return;
    }
    setBusy(true);
    try {
      const res = await askAi({
        sessionId: session.sessionId,
        task: "generate-aggregate",
        prompt: prompt.trim(),
        columns,
        tableName,
      });
      setResponse({ text: res.text, sql: res.sql });
      dispatch({
        type: "ADD_AI_MESSAGE",
        payload: makeUserChatMessage(`Genera un agregado: ${prompt.trim()}`),
      });
      dispatch({ type: "ADD_AI_MESSAGE", payload: makeAssistantChatMessage(res.text) });
      if (res.usage) dispatch({ type: "SET_AI_LAST_USAGE", payload: res.usage });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SparklesIcon className="size-4 text-primary" />
            Datos con IA
          </DialogTitle>
          <DialogDescription>
            Resume este result set o genera un agregado/exportador a partir de él.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 border-b pb-2">
          <Button
            size="xs"
            variant={tab === "summarize" ? "secondary" : "ghost"}
            onClick={() => setTab("summarize")}
          >
            Resumir filas
          </Button>
          <Button
            size="xs"
            variant={tab === "aggregate" ? "secondary" : "ghost"}
            onClick={() => setTab("aggregate")}
          >
            Generar agregado
          </Button>
        </div>

        {tab === "summarize" ? (
          <div className="grid gap-3">
            {!confirmed ? (
              <div className="flex items-start gap-2.5 rounded-lg border border-gdb-warn/30 bg-gdb-warn/10 p-3 text-xs text-gdb-warnfg">
                <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
                <div className="grid gap-2">
                  <p>
                    Vas a enviar <strong>{rowCount} fila(s) de datos reales</strong> ({columns.length} columnas) al
                    proveedor de IA (OpenRouter). Esto es distinto al resto de acciones de IA de DataDB, que solo
                    envían el esquema.
                  </p>
                  <Button size="xs" variant="outline" className="w-fit" onClick={() => setConfirmed(true)}>
                    Entiendo, enviar {rowCount} fila(s)
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  Enviando {rowCount} fila(s) de {tableName ?? "el resultado"} · {columns.length} columnas.
                </p>
                <Textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Opcional: qué quieres saber de estos datos (patrones, outliers, totales…)"
                  className="min-h-16 text-xs"
                />
                <Button size="sm" onClick={() => void handleSummarize()} disabled={busy}>
                  <SparklesIcon className="size-3.5" />
                  {busy ? "Resumiendo…" : "Resumir con IA"}
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className="grid gap-3">
            <p className="text-xs text-muted-foreground">
              Genera SQL de agregación o un snippet de transformación (no envía filas, solo columnas y nombre de
              tabla).
            </p>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ej: total de ventas por región y mes"
              className="min-h-16 text-xs"
            />
            <Button size="sm" onClick={() => void handleAggregate()} disabled={busy}>
              <SparklesIcon className="size-3.5" />
              {busy ? "Generando…" : "Generar agregado"}
            </Button>
          </div>
        )}

        {response && (
          <div className="grid gap-2 border-t pt-3">
            {response.sql && (
              <div className="h-40 overflow-hidden rounded-lg border">
                <CodePreview value={response.sql} language="sql" className="h-full" fontSize="13px" />
              </div>
            )}
            {(!response.sql || response.text.replace(/```[\s\S]*?```/g, "").trim()) && (
              <div className="max-h-40 overflow-auto text-muted-foreground">
                <MarkdownContent
                  content={response.sql ? response.text.replace(/```sql[\s\S]*?```/i, "").trim() : response.text}
                />
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {response?.sql && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  if (!response.sql) return;
                  await navigator.clipboard.writeText(response.sql);
                  toast.success("SQL copiado");
                }}
              >
                <CopyIcon className="size-3.5" />
                Copiar SQL
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  const sql = response.sql;
                  if (!sql) return;
                  dispatch({ type: "SET_ACTIVE_TAB", payload: "sql" });
                  setTimeout(
                    () => window.dispatchEvent(new CustomEvent("gestordb:ai-insert-sql", { detail: sql })),
                    80
                  );
                  onOpenChange(false);
                }}
              >
                <FileInputIcon className="size-3.5" />
                Insertar en consola
              </Button>
            </>
          )}
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cerrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
