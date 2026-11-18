import * as React from "react";
import { IjIcon } from "@/components/ij-icon";
import { useAppDispatch, useActiveConsole } from "@/hooks/use-app-state";
import { ResultsGrid } from "@/components/results-grid";
import { ExplainTab } from "@/components/explain-tab";
import { cn } from "@/lib/utils";
import { firmaDeColumnas, type TextosDeFiltro } from "@/components/grid/filtering";

/** Referencia estable para «sin filtros»: una `{}` nueva en cada render rompería el memo del grid. */
const SIN_FILTROS: TextosDeFiltro = {};

interface ResultTabsPanelProps {
  onNavigateFk?: (
    schema: string,
    table: string,
    column: string,
    value: unknown,
    sourceTable?: string,
    sourceColumn?: string
  ) => void;
  onRefresh?: () => Promise<void> | void;
  onPageChange?: (tabId: string, direction: "next" | "prev") => Promise<void> | void;
  minimized?: boolean;
  onToggleMinimize?: () => void;
}

export function ResultTabsPanel({
  onNavigateFk,
  onRefresh,
  onPageChange,
  minimized = false,
  onToggleMinimize,
}: ResultTabsPanelProps) {
  const console_ = useActiveConsole();
  const dispatch = useAppDispatch();

  const activeTab =
    console_.resultTabs.find((t) => t.id === console_.activeResultTabId) ??
    console_.resultTabs[console_.resultTabs.length - 1];

  /**
   * Fase 13 (T4, decisión de la fase): las condiciones de la fila de filtros se recuerdan **por
   * pestaña**. DataGrip también las recuerda al apagar y encender la fila.
   *
   * Viven aquí, y no dentro de `ResultsGrid`, porque ese componente es UNO para todas las pestañas:
   * al cambiar de pestaña sólo le cambia el `result`, y no tiene forma de saber de qué pestaña venía.
   *
   * Cuándo se limpian: sólo si la pestaña pasa a tener OTRAS columnas. Refrescar y paginar
   * reutilizan el id de la pestaña con un `result` nuevo (`app-shell.tsx`), y ahí el usuario espera
   * conservar el filtro; una consulta nueva crea pestaña nueva, con su propio id.
   *
   * No se persisten en disco: un result set no sobrevive al reinicio, y un filtro guardado acabaría
   * apuntando a columnas que ya no existen.
   */
  const [filtrosPorTab, setFiltrosPorTab] = React.useState<Record<string, TextosDeFiltro>>({});
  const columnasVistas = React.useRef(new Map<string, string>());

  React.useEffect(() => {
    if (!activeTab) return;
    const firma = firmaDeColumnas(activeTab.result.columns);
    const vista = columnasVistas.current.get(activeTab.id);
    columnasVistas.current.set(activeTab.id, firma);
    if (vista === undefined || vista === firma) return;
    setFiltrosPorTab((previos) => {
      if (previos[activeTab.id] === undefined) return previos;
      const siguientes = { ...previos };
      delete siguientes[activeTab.id];
      return siguientes;
    });
  }, [activeTab]);

  const cambiarFiltros = React.useCallback(
    (tabId: string, nuevos: TextosDeFiltro) => {
      setFiltrosPorTab((previos) => ({ ...previos, [tabId]: nuevos }));
    },
    []
  );

  /** Al cerrar una pestaña, sus filtros se van con ella. */
  const cerrarTab = React.useCallback((tabId: string) => {
    setFiltrosPorTab((previos) => {
      if (previos[tabId] === undefined) return previos;
      const siguientes = { ...previos };
      delete siguientes[tabId];
      return siguientes;
    });
    columnasVistas.current.delete(tabId);
  }, []);


  /*
    Fase 70 (T4, R70): la rejilla vive DEBAJO del editor en el mismo panel y su cabecera es una
    BARRA FINA con el resumen de la consulta (`100 filas · 12 ms`, a la izquierda) — no un strip de
    pestañas de tool window. Las pestañas de RESULTADO solo aparecen cuando hay más de una (varias
    sentencias en la misma ejecución): con un solo resultado, el panel es rejilla y nada más, que
    es lo que se ve en la maqueta aprobada.
  */
  const unico = console_.resultTabs.length <= 1;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-gdb-border bg-gdb-chrome px-2 text-[11px] text-gdb-fgdim">
        <span className="shrink-0 tabular-nums" data-testid="resultado-resumen">
          {activeTab && !activeTab.explainTree
            ? `${activeTab.result.rowCount} ${activeTab.result.rowCount === 1 ? "fila" : "filas"} · ${activeTab.result.durationMs} ms`
            : activeTab?.explainTree
              ? "Plan de ejecución"
              : "Sin resultados"}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {onToggleMinimize && (
            <button
              type="button"
              onClick={onToggleMinimize}
              title={minimized ? "Expandir resultados" : "Minimizar resultados"}
              className="flex h-5 w-5 items-center justify-center rounded text-gdb-fgdim transition-colors hover:bg-gdb-hover hover:text-gdb-fg"
            >
              <IjIcon name={minimized ? "openInToolWindow" : "hide"} />
            </button>
          )}
        </div>
      </div>
      {!unico && (
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-gdb-sep bg-gdb-chrome px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {console_.resultTabs.map((tab) => (
            <button
              key={tab.id}
              className={cn(
                "group flex h-6 max-w-[160px] items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors",
                activeTab?.id === tab.id
                  ? "bg-gdb-contrast font-medium text-gdb-fgstrong"
                  : "text-gdb-fgdim hover:bg-gdb-rowhover hover:text-gdb-fg"
              )}
              onClick={() =>
                dispatch({ type: "SET_ACTIVE_RESULT_TAB", payload: tab.id })
              }
            >
              <span className="truncate">{tab.title}</span>
              <span
                className="opacity-0 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  cerrarTab(tab.id);
                  dispatch({ type: "CLOSE_RESULT_TAB", payload: tab.id });
                }}
              >
                <IjIcon name="close" />
              </span>
            </button>
          ))}
        </div>
      </div>
      )}
      {!minimized && (
        <div className="min-h-0 flex-1">
          {activeTab ? (
            <div className="h-full">
              {activeTab.explainTree ? (
                <ExplainTab tree={activeTab.explainTree} sql={activeTab.sql} />
              ) : (
                <ResultsGrid
                  result={activeTab.result}
                  tableContext={activeTab.tableContext}
                  onNavigateFk={onNavigateFk}
                  onRefresh={onRefresh}
                  offset={activeTab.offset ?? 0}
                  filtros={filtrosPorTab[activeTab.id] ?? SIN_FILTROS}
                  onCambiarFiltros={(nuevos) => cambiarFiltros(activeTab.id, nuevos)}
                  onPrevPage={
                    onPageChange ? () => onPageChange(activeTab.id, "prev") : undefined
                  }
                  onNextPage={
                    onPageChange ? () => onPageChange(activeTab.id, "next") : undefined
                  }
                />
              )}
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
              <span className="text-4xl opacity-20">⌘</span>
              <span>Escribe una query y presiona ⌘Enter</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
