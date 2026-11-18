import * as React from "react";
import { toast } from "sonner";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  LockIcon,
  RotateCcwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { IjIcon } from "@/components/ij-icon";
import { EditableCell } from "@/components/editable-cell";
import { useAppState } from "@/hooks/use-app-state";
import { batchEdit, runQuery as apiRunQuery } from "@/lib/api";
import { quoteIdentifier, quoteValue } from "@/lib/quote";
import { dialectoSql } from "@/shared/connection-net";
import {
  booleanoParaGuardar,
  esColumnaBooleana,
  pintarCelda,
  tokenDeColorPorTipo,
  valorBooleano,
  type TokenDeTipo,
} from "@/components/grid/cell-model";
import type { QueryResult, Session } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface FkQuickTarget {
  schema: string;
  table: string;
  column: string;
  value: unknown;
  sourceTable?: string;
  sourceColumn?: string;
}

interface FkQuickViewDialogProps {
  target: FkQuickTarget | null;
  session: Session | null;
  onClose: () => void;
  onOpenInTab: (target: FkQuickTarget) => void;
}

const CLASE_POR_TOKEN: Record<TokenDeTipo, string> = {
  "--gdb-num": "text-gdb-num",
  "--gdb-fn": "text-gdb-fn",
  "--gdb-str": "text-gdb-str",
};

const INSPECTOR_GRID_COLS =
  "grid grid-cols-[175px_105px_minmax(0,1fr)] sm:grid-cols-[220px_130px_minmax(0,1fr)] gap-4";

function formatCellPreview(value: unknown, columnType = "") {
  const pintada = pintarCelda(value, columnType);
  if (pintada.esNulo) {
    return (
      <span className="inline-block rounded border border-gdb-sep bg-gdb-contrast px-2 py-[1px] font-jetbrains text-[12px] italic text-gdb-muted">
        NULL
      </span>
    );
  }

  const boolVal =
    typeof value === "boolean"
      ? value
      : esColumnaBooleana(columnType)
        ? valorBooleano(value)
        : null;
  if (boolVal !== null) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded border px-2.5 py-[2px] font-jetbrains text-[12px] font-medium",
          boolVal
            ? "border-gdb-okfg/40 bg-gdb-okbg text-gdb-okfg"
            : "border-gdb-dangerborder bg-gdb-dangerbg text-gdb-dangerfg"
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 rounded-full",
            boolVal ? "bg-gdb-okfg" : "bg-gdb-dangerfg"
          )}
        />
        {boolVal ? "true" : "false"}
      </span>
    );
  }

  const token =
    tokenDeColorPorTipo(columnType) ??
    (typeof value === "number" ? "--gdb-num" : typeof value === "object" ? "--gdb-str" : null);
  const colorClass = token ? CLASE_POR_TOKEN[token] : "text-gdb-fgstrong";

  return (
    <span className={cn("break-words font-jetbrains text-[13px] leading-relaxed", colorClass)}>
      {pintada.texto}
    </span>
  );
}

function formatCompactOldValue(value: unknown, columnType = ""): string {
  const pintada = pintarCelda(value, columnType);
  if (pintada.esNulo) return "NULL";
  return pintada.texto.length > 48 ? `${pintada.texto.slice(0, 48)}…` : pintada.texto;
}

function FkQuickViewBody({
  target,
  session,
  onClose,
  onOpenInTab,
}: {
  target: FkQuickTarget;
  session: Session;
  onClose: () => void;
  onOpenInTab: (target: FkQuickTarget) => void;
}) {
  const { schema } = useAppState();
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<QueryResult | null>(null);
  const [rowIndex, setRowIndex] = React.useState(0);
  const [editingCol, setEditingCol] = React.useState<string | null>(null);
  const [edits, setEdits] = React.useState<Record<string, unknown>>({});
  const [filterText, setFilterText] = React.useState("");
  const [copiedJson, setCopiedJson] = React.useState(false);

  const pkColumn = React.useMemo(() => {
    const node = schema?.find((s) => s.name === target.schema);
    const table = node?.tables.find((t) => t.name === target.table);
    const pks = table?.columns.filter((c) => c.isPrimaryKey) ?? [];
    return pks.length === 1 ? pks[0].name : null;
  }, [schema, target.schema, target.table]);

  const buildQuerySql = React.useCallback(() => {
    const dialect = dialectoSql(session.type);
    const qualifiedTable = target.schema
      ? `${quoteIdentifier(target.schema, dialect)}.${quoteIdentifier(target.table, dialect)}`
      : quoteIdentifier(target.table, dialect);
    return `SELECT * FROM ${qualifiedTable} WHERE ${quoteIdentifier(target.column, dialect)} = ${quoteValue(target.value)}`;
  }, [session.type, target.schema, target.table, target.column, target.value]);

  const cargar = React.useCallback(async () => {
    try {
      const res = await apiRunQuery(session.sessionId, buildQuerySql());
      setResult(res);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [session.sessionId, buildQuerySql]);

  React.useEffect(() => {
    let cancelled = false;
    apiRunQuery(session.sessionId, buildQuerySql())
      .then((res) => {
        if (!cancelled) {
          setResult(res);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session.sessionId, buildQuerySql]);

  React.useEffect(() => {
    if (!copiedJson) return;
    const timer = window.setTimeout(() => setCopiedJson(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copiedJson]);

  const rows = result?.rows ?? [];
  const currentRow = rows[rowIndex];
  const columns = React.useMemo(() => result?.columns ?? [], [result?.columns]);
  const pkValue = pkColumn && currentRow ? currentRow[pkColumn] : undefined;
  const canEdit = Boolean(pkColumn && currentRow && pkValue !== undefined && pkValue !== null);
  const editCount = Object.keys(edits).length;

  const filteredColumns = React.useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return columns;
    return columns.filter(
      (col) =>
        col.name.toLowerCase().includes(q) ||
        (col.type ?? "").toLowerCase().includes(q)
    );
  }, [columns, filterText]);

  function setColEdit(colName: string, nextVal: unknown) {
    if (!currentRow) return;
    const orig = currentRow[colName];
    setEdits((prev) => {
      if (Object.is(orig, nextVal)) {
        const copy = { ...prev };
        delete copy[colName];
        return copy;
      }
      return { ...prev, [colName]: nextVal };
    });
  }

  function restoreCol(colName: string) {
    setEdits((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, colName)) return prev;
      const copy = { ...prev };
      delete copy[colName];
      return copy;
    });
    if (editingCol === colName) setEditingCol(null);
  }

  async function handleCopyJson() {
    if (!currentRow) return;
    const merged: Record<string, unknown> = { ...currentRow, ...edits };
    try {
      await navigator.clipboard.writeText(JSON.stringify(merged, null, 2));
      setCopiedJson(true);
      toast.success("Fila copiada como JSON");
    } catch {
      toast.error("No se pudo copiar al portapapeles");
    }
  }

  async function handleSaveEdits() {
    if (!canEdit || !pkColumn || editCount === 0) return;
    setSaving(true);
    try {
      await batchEdit(session.sessionId, {
        schema: target.schema || undefined,
        table: target.table,
        pkColumn,
        operations: [{ type: "update", pkValue, changes: edits }],
      });
      setEdits({});
      setEditingCol(null);
      await cargar();
      toast.success("Cambios guardados");
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSaving(false);
    }
  }

  const tableLabel = target.schema ? `${target.schema}.${target.table}` : target.table;
  const relationPrefix =
    target.sourceTable && target.sourceColumn
      ? `${target.sourceTable}.${target.sourceColumn} → `
      : "";

  return (
    <DialogContent
      showCloseButton={false}
      className="flex max-h-[84vh] w-[min(820px,94vw)] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-lg border border-gdb-borderstrong bg-gdb-editor p-0 text-gdb-fg shadow-2xl ring-0 sm:max-w-[820px]"
    >
      {/* Wrapper para interceptar Esc cuando se edita una celda sin cerrar el modal completo */}
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        onKeyDown={(e) => {
          if (e.key === "Escape" && editingCol !== null) {
            e.stopPropagation();
            setEditingCol(null);
          }
        }}
      >
        {/* Cabecera nivel 1 */}
        <DialogHeader className="flex flex-row items-center justify-between gap-3 border-b border-gdb-sep bg-gdb-chrome px-5 py-3">
          <DialogTitle className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5 font-jetbrains text-[14px] font-semibold text-gdb-fgstrong">
            <IjIcon name="table" className="text-gdb-icotbl" />
            <span className="truncate">{tableLabel}</span>
            <span className="inline-flex max-w-full items-center gap-1 rounded border border-gdb-border bg-gdb-contrast px-2.5 py-0.5 font-jetbrains text-[12px] font-normal text-gdb-fgdim">
              <span className="truncate">
                {relationPrefix}
                {target.column} ={" "}
              </span>
              <strong className="font-medium text-gdb-num">
                {String(target.value ?? "NULL")}
              </strong>
            </span>
          </DialogTitle>
          <div className="flex shrink-0 items-center gap-3">
            {result && (
              <span className="whitespace-nowrap font-jetbrains text-[12px] text-gdb-fgdim">
                {rows.length} {rows.length === 1 ? "fila" : "filas"} · {result.durationMs} ms
              </span>
            )}
            <DialogClose
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Cerrar diálogo"
                  className="size-7 text-gdb-fgdim hover:bg-gdb-rowhover hover:text-gdb-fgstrong"
                />
              }
            >
              <XIcon className="size-4" />
            </DialogClose>
          </div>
        </DialogHeader>

        {/* Cabecera nivel 2: filtro de columnas y acciones de fila */}
        {!loading && !error && currentRow && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gdb-sep bg-gdb-contrast/75 px-5 py-2">
            <div className="relative min-w-[200px] flex-1 sm:max-w-[340px]">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-gdb-muted" />
              <input
                type="text"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                placeholder="Filtrar columnas…"
                aria-label="Filtrar columnas del inspector"
                className="h-7 w-full rounded border border-gdb-border bg-gdb-field pr-7 pl-8 text-[12.5px] text-gdb-fgstrong placeholder:text-gdb-muted focus:border-gdb-focus focus:outline-none"
              />
              {filterText && (
                <button
                  type="button"
                  onClick={() => setFilterText("")}
                  aria-label="Limpiar filtro"
                  className="absolute top-1/2 right-1.5 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-gdb-fgdim hover:bg-gdb-rowhover hover:text-gdb-fgstrong"
                >
                  <XIcon className="size-3" />
                </button>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span className="whitespace-nowrap text-[12px] text-gdb-fgdim">
                {filterText.trim()
                  ? `${filteredColumns.length} de ${columns.length} columnas`
                  : `${columns.length} ${columns.length === 1 ? "columna" : "columnas"}`}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void handleCopyJson()}
                className={cn(
                  "h-7 gap-1.5 border-gdb-border bg-gdb-field px-2.5 text-xs font-medium text-gdb-fg hover:bg-gdb-rowhover hover:text-gdb-fgstrong",
                  copiedJson && "border-gdb-okfg bg-gdb-okbg text-gdb-okfg hover:bg-gdb-okbg hover:text-gdb-okfg"
                )}
              >
                {copiedJson ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
                {copiedJson ? "Copiado" : "Copiar fila JSON"}
              </Button>
            </div>
          </div>
        )}

        {/* Encabezado de columnas del inspector */}
        {!loading && !error && currentRow && (
          <div
            aria-hidden="true"
            className={cn(
              INSPECTOR_GRID_COLS,
              "shrink-0 border-b border-gdb-sep bg-gdb-contrast px-5 py-2 text-[11px] font-semibold tracking-wider uppercase text-gdb-fgdim"
            )}
          >
            <span>Columna</span>
            <span>Tipo SQL</span>
            <span>Valor actual</span>
          </div>
        )}

        {/* Cuerpo del inspector */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-gdb-editor">
          {loading && (
            <div className="px-5 py-10 text-center text-xs text-gdb-muted">
              Consultando registro referenciado…
            </div>
          )}

          {!loading && error && (
            <div className="m-4 rounded border border-gdb-dangerborder bg-gdb-dangerbg px-3.5 py-2.5 text-xs text-gdb-dangerfg">
              {error}
            </div>
          )}

          {!loading && !error && result && rows.length === 0 && (
            <div className="px-5 py-10 text-center text-xs text-gdb-muted">
              No se encontró ningún registro coincidente.
            </div>
          )}

          {!loading && !error && currentRow && filteredColumns.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2.5 px-5 py-10 text-center text-xs text-gdb-fgdim">
              <span>Ninguna columna coincide con «{filterText}».</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setFilterText("")}
                className="h-7 border-gdb-border bg-gdb-field text-xs"
              >
                Limpiar filtro
              </Button>
            </div>
          )}

          {!loading && !error && currentRow && filteredColumns.length > 0 && (
            <div>
              {filteredColumns.map((col) => {
                const isMatchedKey = col.name === target.column;
                const isPk = col.name === pkColumn;
                const showKeyBadge = isPk || isMatchedKey;
                const colEditable = canEdit && !isPk;
                const hasEdit = Object.prototype.hasOwnProperty.call(edits, col.name);
                const val = hasEdit ? edits[col.name] : currentRow[col.name];
                const colType = col.type ?? "";
                const boolVal =
                  typeof val === "boolean"
                    ? val
                    : esColumnaBooleana(colType)
                      ? valorBooleano(val)
                      : null;
                const isEditingThis = editingCol === col.name;

                return (
                  <div
                    key={col.name}
                    className={cn(
                      INSPECTOR_GRID_COLS,
                      "group min-h-[40px] items-start border-b border-gdb-sep/60 border-l-2 px-5 py-2.5 transition-colors",
                      !hasEdit && !isMatchedKey && "border-l-transparent hover:bg-gdb-rowhover/60",
                      isMatchedKey && !hasEdit && "border-l-transparent bg-gdb-accent/8 hover:bg-gdb-rowhover/65",
                      hasEdit && "border-l-gdb-accent bg-gdb-diffmod/65 hover:bg-gdb-diffmod/80"
                    )}
                  >
                    {/* Columna 1: Nombre + insignia PK */}
                    <div className="flex min-w-0 items-center gap-2 pt-0.5 font-jetbrains text-[12.5px] text-gdb-fgstrong">
                      {showKeyBadge && (
                        <IjIcon name="primaryKey" className="shrink-0 text-gdb-icokey" />
                      )}
                      <span className="break-words leading-snug">{col.name}</span>
                      {isPk && (
                        <span className="shrink-0 rounded border border-gdb-icokey/45 bg-gdb-icokey/15 px-1 py-[1px] font-sans text-[10px] font-semibold tracking-wide text-gdb-icokey">
                          PK
                        </span>
                      )}
                    </div>

                    {/* Columna 2: Tipo SQL dedicado */}
                    <div
                      className="truncate pt-0.5 font-jetbrains text-[12.5px] text-gdb-muted"
                      title={colType || undefined}
                    >
                      {colType || "—"}
                    </div>

                    {/* Columna 3: Valor actual + metadatos de edición */}
                    <div className="flex min-w-0 flex-col gap-1.5">
                      {isEditingThis ? (
                        <div className="flex flex-col gap-1">
                          <div className="min-h-7 rounded border border-gdb-focus bg-gdb-field px-2 py-0.5 ring-1 ring-gdb-focus">
                            <EditableCell
                              enLinea
                              value={val}
                              columnType={colType}
                              onCommit={(nuevo) => {
                                setColEdit(col.name, nuevo);
                                setEditingCol(null);
                              }}
                              onCancel={() => setEditingCol(null)}
                            />
                          </div>
                          <span className="text-[11px] text-gdb-fgdim">
                            Enter guarda el cambio · Esc cancela edición
                          </span>
                        </div>
                      ) : colEditable && boolVal !== null ? (
                        <div className="flex items-center justify-between gap-3">
                          <button
                            type="button"
                            onClick={() =>
                              setColEdit(
                                col.name,
                                booleanoParaGuardar(currentRow[col.name], !boolVal)
                              )
                            }
                            title="Clic para alternar true/false"
                            className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gdb-focus"
                          >
                            {formatCellPreview(val, colType)}
                          </button>
                          <span className="hidden shrink-0 text-[11px] text-gdb-muted group-hover:inline">
                            Clic para alternar
                          </span>
                        </div>
                      ) : colEditable ? (
                        <div className="flex items-start justify-between gap-3">
                          <div
                            role="button"
                            tabIndex={0}
                            onClick={() => setEditingCol(col.name)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === "F2") {
                                e.preventDefault();
                                setEditingCol(col.name);
                              }
                            }}
                            title="Clic para editar valor"
                            className="-mx-1.5 -my-0.5 min-w-0 max-w-full cursor-text rounded border border-transparent px-1.5 py-0.5 transition-colors hover:border-gdb-border hover:bg-gdb-rowhover/50 focus-visible:border-gdb-focus focus-visible:outline-none"
                          >
                            {formatCellPreview(val, colType)}
                          </div>
                          <span className="hidden shrink-0 pt-0.5 text-[11px] text-gdb-muted group-hover:inline">
                            Clic para editar
                          </span>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">{formatCellPreview(val, colType)}</div>
                          {isPk && (
                            <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-gdb-muted">
                              <LockIcon className="size-3" />
                              Solo lectura
                            </span>
                          )}
                        </div>
                      )}

                      {hasEdit && !isEditingThis && (
                        <div className="flex flex-wrap items-center gap-2.5 text-[12px]">
                          <span className="rounded border border-gdb-accent bg-gdb-accent/20 px-1.5 py-[1px] text-[11px] font-medium text-gdb-fgstrong">
                            modificado
                          </span>
                          <span className="truncate font-jetbrains text-gdb-fgdim line-through">
                            {formatCompactOldValue(currentRow[col.name], colType)}
                          </span>
                          <button
                            type="button"
                            onClick={() => restoreCol(col.name)}
                            className="inline-flex items-center gap-1 rounded border border-gdb-border bg-gdb-field px-2 py-[1px] text-[11.5px] font-medium text-gdb-fg transition-colors hover:bg-gdb-rowhover hover:text-gdb-fgstrong"
                          >
                            <RotateCcwIcon className="size-3" />
                            Restaurar
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Pie del modal */}
        <DialogFooter className="mx-0 mb-0 flex flex-wrap items-center justify-between gap-3 rounded-b-none border-t border-gdb-sep bg-gdb-chrome px-5 py-3 sm:flex-row sm:justify-between">
          <div className="flex flex-wrap items-center gap-3.5">
            {rows.length > 0 && (
              <div className="inline-flex items-center gap-1.5" aria-label="Paginación de filas relacionadas">
                <Button
                  type="button"
                  size="icon-sm"
                  variant="outline"
                  disabled={rowIndex <= 0 || rows.length <= 1}
                  aria-label="Fila anterior"
                  onClick={() => {
                    setEdits({});
                    setEditingCol(null);
                    setRowIndex((i) => Math.max(0, i - 1));
                  }}
                  className="size-7 border-gdb-border bg-gdb-field text-gdb-fg hover:bg-gdb-rowhover hover:text-gdb-fgstrong"
                >
                  <ChevronLeftIcon className="size-3.5" />
                </Button>
                <span className="min-w-[44px] text-center font-jetbrains text-[12px] text-gdb-fgdim">
                  {rowIndex + 1} / {rows.length}
                </span>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="outline"
                  disabled={rowIndex >= rows.length - 1 || rows.length <= 1}
                  aria-label="Fila siguiente"
                  onClick={() => {
                    setEdits({});
                    setEditingCol(null);
                    setRowIndex((i) => Math.min(rows.length - 1, i + 1));
                  }}
                  className="size-7 border-gdb-border bg-gdb-field text-gdb-fg hover:bg-gdb-rowhover hover:text-gdb-fgstrong"
                >
                  <ChevronRightIcon className="size-3.5" />
                </Button>
              </div>
            )}

            {editCount > 0 && (
              <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-gdb-warnfg">
                <span aria-hidden="true" className="size-2 rounded-full bg-gdb-warnfg" />
                {editCount} {editCount === 1 ? "cambio pendiente" : "cambios pendientes"}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                onOpenInTab(target);
                onClose();
              }}
              className="h-7 gap-1.5 border-gdb-border bg-gdb-field text-xs text-gdb-fg hover:bg-gdb-rowhover hover:text-gdb-fgstrong"
            >
              <IjIcon name="table" />
              Abrir en pestaña
            </Button>

            {editCount > 0 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={saving}
                onClick={() => {
                  setEdits({});
                  setEditingCol(null);
                }}
                className="h-7 border-gdb-dangerborder bg-gdb-dangerbg text-xs text-gdb-dangerfg hover:bg-gdb-dangerbg/80 hover:text-gdb-fgstrong"
              >
                Descartar
              </Button>
            )}

            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onClose}
              className="h-7 border-gdb-border bg-gdb-field text-xs text-gdb-fg hover:bg-gdb-rowhover hover:text-gdb-fgstrong"
            >
              Cerrar
            </Button>

            {editCount > 0 && (
              <Button
                type="button"
                size="sm"
                disabled={saving}
                onClick={() => void handleSaveEdits()}
                className="h-7 gap-1 border border-gdb-focus bg-gdb-btnprimary text-xs text-gdb-onaccent hover:bg-gdb-btnprimary/90"
              >
                {saving ? "Guardando…" : `Guardar (${editCount})`}
              </Button>
            )}
          </div>
        </DialogFooter>
      </div>
    </DialogContent>
  );
}

/**
 * Vista rápida de un registro referenciado por llave foránea. Permite inspeccionar, filtrar y
 * editar sus campos sin abandonar la consulta actual, además de abrir la tabla filtrada en pestaña.
 */
export function FkQuickViewDialog({
  target,
  session,
  onClose,
  onOpenInTab,
}: FkQuickViewDialogProps) {
  return (
    <Dialog open={target !== null && session !== null} onOpenChange={(open) => !open && onClose()}>
      {target && session && (
        <FkQuickViewBody
          key={`${session.sessionId}:${target.schema}.${target.table}.${target.column}=${String(target.value)}`}
          target={target}
          session={session}
          onClose={onClose}
          onOpenInTab={onOpenInTab}
        />
      )}
    </Dialog>
  );
}
