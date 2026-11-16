import { dialectoSql } from "@/shared/connection-net";
import * as React from "react";
import { toast } from "sonner";
import { useAppState, useAppDispatch, useActiveSession, useActiveConsole } from "@/hooks/use-app-state";
import { wakeBinding } from "@/lib/console-wake";
import { getObjectDdl } from "@/lib/api";
import { buildDdlTemplate, type DdlDialect, type DdlTemplateKind } from "@/lib/ddl-templates";
import { downloadText } from "@/lib/export-formats";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { TableBuilderDialog } from "@/components/table-builder-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
// Fase 8, T3/T5 (R34): iconos de IntelliJ (`<IjIcon>`, 16 px, colores de la paleta). T5 dibujó los objetos que no
// existen en el set abierto de JetBrains (plugin cerrado de DataGrip): vista, procedimiento, trigger, PK y FK.
import { ColumnIcon } from "@/components/column-icon";
import { IjIcon, type IjIconName } from "@/components/ij-icon";
// Fase 15 (T5): el marcador de contexto del enrutador de teclado para el árbol (`⌘R`).
import { TESTID_ARBOL } from "@/shell/keyboard-router";
import { PESO_DE_TINTE, colorDeTinte, fondoTenido } from "@/lib/profile-colors";

export function SchemaTree() {
  // El árbol de esquema sigue SIEMPRE a la conexión de la consola con foco:
  // al cambiar de consola, cambia el schema y la sesión que se muestran aquí.
  const { schema, favoriteTables } = useAppState();
  const session = useActiveSession();
  // R91: con la consola dormida (atada sin sesión) los rótulos salen de su conexión guardada.
  const consolaActiva = useActiveConsole();
  const esMongo = (session ?? consolaActiva.binding)?.type === "mongodb";
  // R18: color de la conexión de la consola con foco, si tiñe.
  const tinteDelArbol = colorDeTinte((session ?? consolaActiva.binding)?.color);
  const dispatch = useAppDispatch();
  const dialect: DdlDialect = dialectoSql(session?.type);
  const [builderSchema, setBuilderSchema] = React.useState<string | null>(null);

  function insertDdlTemplate(kind: DdlTemplateKind, schemaName: string) {
    if (kind === "table") {
      setBuilderSchema(schemaName);
      return;
    }
    const template = buildDdlTemplate(kind, dialect, schemaName);
    dispatch({ type: "SET_SQL", payload: template });
    dispatch({ type: "SET_ACTIVE_TAB", payload: "sql" });
  }

  async function exportSchemaDdl(schemaName: string) {
    if (!session) {
      toast.error("No hay una conexión activa");
      return;
    }
    const node = (schema ?? []).find((n) => n.name === schemaName);
    if (!node || node.tables.length === 0) {
      toast.info(`El schema "${schemaName}" no tiene tablas`);
      return;
    }

    toast.info(`Generando DDL de ${node.tables.length} objeto(s)...`);
    const parts: string[] = [];
    for (const table of node.tables) {
      try {
        const ddl = await getObjectDdl(session.sessionId, schemaName, table.name, "table");
        parts.push(`-- ${schemaName}.${table.name}\n${ddl};`);
      } catch (err) {
        parts.push(`-- ${schemaName}.${table.name} (ERROR: ${String(err)})`);
      }
    }

    const content = parts.join("\n\n");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadText(`ddl-${schemaName}-${timestamp}.sql`, content);
    toast.success(`DDL de "${schemaName}" descargado`);
  }

  const [expandedSchemas, setExpandedSchemas] = React.useState<Set<string>>(
    () => new Set((schema ?? []).map((node) => node.name))
  );
  const [expandedTables, setExpandedTables] = React.useState<Set<string>>(new Set());
  /**
   * Fase 70 (T3): el schema llega DESPUÉS del primer render, así que el `useState` de arriba se
   * inicializó con la lista vacía y los nodos aparecían colapsados al recargar. Aquí se abren los
   * schemas que llegan nuevos (una sola vez cada uno: si el usuario los cierra, no se reabren).
   */
  const schemasVistos = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    if (!schema || schema.length === 0) return;
    const nuevos = schema.map((n) => n.name).filter((name) => !schemasVistos.current.has(name));
    if (nuevos.length === 0) return;
    for (const name of nuevos) schemasVistos.current.add(name);
    setExpandedSchemas((prev) => new Set([...prev, ...nuevos]));
  }, [schema]);

  const [search, setSearch] = React.useState("");
  const [favoritesOnly, setFavoritesOnly] = React.useState(false);
  /**
   * Fase 70 (T3): grupos COLAPSADOS por schema (`schema:tablas`, `schema:vistas`…). Vacío =
   * todos abiertos, que es como se ve en la maqueta aprobada (una sola columna con
   * `Tablas (n)` / `Vistas (n)` / `Funciones (n)`).
   */
  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(new Set());

  const favoriteKeySet = React.useMemo(
    () => new Set(favoriteTables.map((f) => `${f.schema}.${f.table}`)),
    [favoriteTables]
  );

  const term = search.trim().toLowerCase();

  const filteredSchemas = React.useMemo(() => {
    if (!schema) return [];
    return schema
      .map((node) => {
        // Fase 70 (T3): el filtro de favoritos se aplica SOLO a tablas (vistas y funciones no se
        // marcan como favoritas en el producto); el buscador aplica a todo.
        const tables = node.tables.filter((t) => {
          const key = `${node.name}.${t.name}`;
          const matchesSearch =
            !term ||
            t.name.toLowerCase().includes(term) ||
            t.columns.some((c) => c.name.toLowerCase().includes(term));
          const matchesFavorite = !favoritesOnly || favoriteKeySet.has(key);
          return matchesSearch && matchesFavorite;
        });
        const routines = node.routines.filter((r) => !term || r.name.toLowerCase().includes(term));
        const triggers = node.triggers.filter((t) => !term || t.name.toLowerCase().includes(term));
        return { ...node, tables, routines, triggers };
      })
      .filter(
        (node) =>
          node.tables.length > 0 ||
          node.routines.length > 0 ||
          node.triggers.length > 0
      );
  }, [schema, term, favoritesOnly, favoriteKeySet]);


  function toggle(set: React.Dispatch<React.SetStateAction<Set<string>>>, key: string) {
    set((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function expandAll() {
    const schemas = new Set(filteredSchemas.map((n) => n.name));
    const tables = new Set(
      filteredSchemas.flatMap((n) => n.tables.map((t) => `${n.name}.${t.name}`))
    );
    setExpandedSchemas(schemas);
    setExpandedTables(tables);
  }

  function collapseAll() {
    setExpandedSchemas(new Set());
    setExpandedTables(new Set());
  }

  if (!schema || schema.length === 0) {
    const dormida = !session ? consolaActiva.binding : null;
    return (
      <div
        data-testid={TESTID_ARBOL}
        className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-sidebar"
        data-tinte={tinteDelArbol ?? undefined}
        style={tinteDelArbol ? { backgroundColor: fondoTenido(tinteDelArbol, "var(--sidebar)", PESO_DE_TINTE.arbol) } : undefined}
      >
        <div className="min-h-0 flex-1 overflow-y-auto p-4 text-xs text-muted-foreground">
          {dormida ? (
            // R91: consola dormida sin esquema en caché. No se conecta sola al abrirla (conexión
            // perezosa): lo hace al ejecutar, o aquí si el usuario quiere ver el árbol antes.
            <div className="flex flex-col items-start gap-2" data-testid="arbol-dormido">
              <span>
                {dormida.name}
                {dormida.database ? ` · ${dormida.database}` : ""}: se conecta al ejecutar una consulta.
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-xs"
                onClick={() => {
                  const consoleId = consolaActiva.id;
                  void wakeBinding(dormida)
                    .then(({ session: s, databaseError }) => {
                      if (databaseError) toast.warning(`No se pudo abrir la base ${dormida.database}: ${databaseError}`);
                      dispatch({ type: "SET_SESSION", payload: { consoleId, session: s } });
                    })
                    .catch((err) => toast.error(String(err)));
                }}
              >
                Conectar ahora
              </Button>
            </div>
          ) : (
            "No hay schema cargado."
          )}
        </div>
      </div>
    );
  }

  return (
    // Fase 15 (T5): `data-testid` es el marcador del contexto `arbol` para el enrutador de teclado
    // (el `⌘R` de #18 refresca el esquema). Va en la RAÍZ del árbol, y el nombre sale de
    // `keyboard-router.ts` (`TESTID_ARBOL`) para que el marcador y el clasificador no puedan
    // separarse. Mismo atributo en las dos ramas (con y sin esquema) por simetría.
    <div
      data-testid={TESTID_ARBOL}
      className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-sidebar"
      /*
        R18: el árbol de una conexión con color se tiñe con él (DataGrip tiñe el nodo de la fuente de
        datos y lo que cuelga de él; aquí el árbol ES el de una sola conexión, así que va el fondo
        entero). Es la ÚNICA superficie teñida (decisión del usuario, ver `colorDeTinte`).
        Intensidad de Apariencia › Colores.
      */
      data-tinte={tinteDelArbol ?? undefined}
      style={tinteDelArbol ? { backgroundColor: fondoTenido(tinteDelArbol, "var(--sidebar)", PESO_DE_TINTE.arbol) } : undefined}
    >
      {/*
        Fase 70 (T3, R70): el explorador es UNA sola columna — sin cabecera «DataDB Explorer»
        (el nombre de la conexión y la base ya están en la barra superior), sin la nav
        Tablas/Especiales y sin tarjetas. Arriba solo el buscador de objetos; debajo el árbol con
        los grupos contados.
      */}
      <div className="shrink-0 border-b border-gdb-sep px-2 py-1.5">
        <div className="flex items-center gap-1">
          <div className="relative min-w-0 flex-1">
            <IjIcon name="search" className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2" />
            <Input
              placeholder={esMongo ? "Buscar colecciones…" : "Buscar tablas…"}
              className="h-7 border-border/60 bg-gdb-field pl-7 text-xs placeholder:text-muted-foreground focus-visible:border-ring"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Button
            size="icon-xs"
            variant="ghost"
            className="shrink-0 text-muted-foreground hover:bg-gdb-rowhover hover:text-foreground"
            title="Expandir todo"
            onClick={expandAll}
          >
            <IjIcon name="expandAll" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            className="shrink-0 text-muted-foreground hover:bg-gdb-rowhover hover:text-foreground"
            title="Colapsar todo"
            onClick={collapseAll}
          >
            <IjIcon name="collapseAll" />
          </Button>
          <Button
            size="icon-xs"
            variant={favoritesOnly ? "secondary" : "ghost"}
            className={cn("shrink-0 hover:bg-gdb-rowhover", favoritesOnly && "bg-secondary")}
            onClick={() => setFavoritesOnly((v) => !v)}
            title={favoritesOnly ? "Mostrar todo" : "Solo favoritos"}
            aria-pressed={favoritesOnly}
          >
            <IjIcon name={favoritesOnly ? "star" : "starEmpty"} />
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1 bg-transparent">
        <div className="min-w-0 p-1.5">
          {filteredSchemas.map((node) => {
            const isOpen = expandedSchemas.has(node.name);
            return (
              <div key={node.name} className="mb-0.5">
                <ContextMenu>
                  <ContextMenuTrigger className="contents">
                    <div className="group flex min-w-0 items-center gap-1 rounded-md h-[var(--gdb-row)] px-1.5 transition-colors hover:bg-gdb-rowhover">
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-semibold text-foreground"
                        onClick={() => toggle(setExpandedSchemas, node.name)}
                      >
                        {isOpen ? (
                          <IjIcon name="chevronDown" />
                        ) : (
                          <IjIcon name="chevronRight" />
                        )}
                        <IjIcon name="schema" />
                        <span className="truncate font-jetbrains">{node.name}</span>
                      </button>
                      <span className="ml-auto shrink-0 font-jetbrains text-[10px] tabular-nums text-gdb-fgdim/80 group-hover:hidden group-has-[[data-popup-open]]:hidden">
                        {node.tables.length}
                      </span>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          className="ml-auto hidden shrink-0 items-center rounded p-0.5 text-muted-foreground hover:bg-gdb-field hover:text-foreground group-hover:flex group-has-[[data-popup-open]]:flex data-[popup-open]:flex focus-visible:flex"
                          title="Generar DDL"
                        >
                          <IjIcon name="add" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="min-w-40">
                          <DropdownMenuItem onClick={() => insertDdlTemplate("table", node.name)}>
                            Nueva tabla
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => insertDdlTemplate("view", node.name)}>
                            Nueva vista
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => insertDdlTemplate("index", node.name)}>
                            Nuevo índice
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => insertDdlTemplate("trigger", node.name)}>
                            Nuevo trigger
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => insertDdlTemplate("function", node.name)}>
                            Nueva función
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent align="start" className="min-w-48">
                    <ContextMenuItem onClick={() => insertDdlTemplate("table", node.name)}>
                      Nueva tabla
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => insertDdlTemplate("view", node.name)}>
                      Nueva vista
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => insertDdlTemplate("index", node.name)}>
                      Nuevo índice
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => insertDdlTemplate("trigger", node.name)}>
                      Nuevo trigger
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => insertDdlTemplate("function", node.name)}>
                      Nueva función
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onClick={() => void exportSchemaDdl(node.name)}>
                      Exportar DDL de todo el schema
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
                {isOpen && (
                  <div className="ml-2.5 border-l border-gdb-sep/50 pl-1.5 pt-0.5">
                    {/*
                      Fase 70 (T3): grupos con CONTADOR, como la maqueta aprobada
                      (`Tablas 4`, `Vistas 1`, `Funciones 2`). Las tablas se parten por `type`
                      (`table` | `view`); las rutinas van juntas en «Funciones» y los triggers
                      solo aparecen si el schema tiene. Un grupo vacío no se pinta.
                    */}
                    <GrupoContado
                      schema={node.name}
                      grupo="tablas"
                      /* Mongo no tiene tablas: el grupo se llama por su nombre real. */
                      etiqueta={esMongo ? "Colecciones" : "Tablas"}
                      icono="table"
                      total={node.tables.filter((t) => t.type === "table").length}
                      colapsado={collapsedGroups.has(`${node.name}:tablas`)}
                      onToggle={() => toggle(setCollapsedGroups, `${node.name}:tablas`)}
                    >
                      {node.tables
                        .filter((t) => t.type === "table")
                        .map((table) => (
                          <TableNode
                            key={`${node.name}.${table.name}`}
                            schema={node.name}
                            table={table}
                            expanded={expandedTables.has(`${node.name}.${table.name}`)}
                            onToggle={() => toggle(setExpandedTables, `${node.name}.${table.name}`)}
                            isFavorite={favoriteKeySet.has(`${node.name}.${table.name}`)}
                            sessionId={session?.sessionId}
                          />
                        ))}
                    </GrupoContado>

                    <GrupoContado
                      schema={node.name}
                      grupo="vistas"
                      etiqueta="Vistas"
                      icono="view"
                      total={node.tables.filter((t) => t.type === "view").length}
                      colapsado={collapsedGroups.has(`${node.name}:vistas`)}
                      onToggle={() => toggle(setCollapsedGroups, `${node.name}:vistas`)}
                    >
                      {node.tables
                        .filter((t) => t.type === "view")
                        .map((table) => (
                          <TableNode
                            key={`${node.name}.${table.name}`}
                            schema={node.name}
                            table={table}
                            expanded={expandedTables.has(`${node.name}.${table.name}`)}
                            onToggle={() => toggle(setExpandedTables, `${node.name}.${table.name}`)}
                            isFavorite={favoriteKeySet.has(`${node.name}.${table.name}`)}
                            sessionId={session?.sessionId}
                          />
                        ))}
                    </GrupoContado>

                    <GrupoContado
                      schema={node.name}
                      grupo="funciones"
                      etiqueta="Funciones"
                      icono="function"
                      total={node.routines.length}
                      colapsado={collapsedGroups.has(`${node.name}:funciones`)}
                      onToggle={() => toggle(setCollapsedGroups, `${node.name}:funciones`)}
                    >
                      {node.routines.map((routine) => (
                        <RoutineNode
                          key={`${node.name}.routine.${routine.name}`}
                          schema={node.name}
                          routine={routine}
                          sessionId={session?.sessionId}
                        />
                      ))}
                    </GrupoContado>

                    <GrupoContado
                      schema={node.name}
                      grupo="triggers"
                      etiqueta="Triggers"
                      icono="trigger"
                      total={node.triggers.length}
                      colapsado={collapsedGroups.has(`${node.name}:triggers`)}
                      onToggle={() => toggle(setCollapsedGroups, `${node.name}:triggers`)}
                    >
                      {node.triggers.map((trigger) => (
                        <TriggerNode
                          key={`${node.name}.trigger.${trigger.name}`}
                          schema={node.name}
                          trigger={trigger}
                          sessionId={session?.sessionId}
                        />
                      ))}
                    </GrupoContado>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>
      {builderSchema && (
        <TableBuilderDialog
          key={builderSchema}
          open={builderSchema !== null}
          onOpenChange={(open) => {
            if (!open) setBuilderSchema(null);
          }}
          dialect={dialect}
          schema={builderSchema}
          onUseInEditor={(ddl) => {
            dispatch({ type: "SET_SQL", payload: ddl });
            dispatch({ type: "SET_ACTIVE_TAB", payload: "sql" });
          }}
        />
      )}
    </div>
  );
}

/**
 * Fase 70 (T3) — un grupo del árbol con su CONTADOR a la derecha (`Tablas 4`).
 *
 * El contador es el total FILTRADO (si el buscador deja 2 de 4, dice 2): es lo que el usuario
 * está viendo, no una cifra decorativa. Si el grupo queda en 0 tras filtrar, no se pinta.
 */
function GrupoContado({
  schema,
  grupo,
  etiqueta,
  icono,
  total,
  colapsado,
  onToggle,
  children,
}: {
  schema: string;
  grupo: string;
  etiqueta: string;
  icono: IjIconName;
  total: number;
  colapsado: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  if (total === 0) return null;
  return (
    <div data-grupo={`${schema}:${grupo}`}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-gdb-fgdim transition-colors hover:bg-gdb-rowhover hover:text-gdb-fg"
        style={{ height: "var(--gdb-row)" }}
        aria-expanded={!colapsado}
      >
        {colapsado ? <IjIcon name="chevronRight" /> : <IjIcon name="chevronDown" />}
        <IjIcon name={icono} className="opacity-70" />
        <span className="truncate">{etiqueta}</span>
        <span className="ml-auto shrink-0 rounded bg-gdb-field/80 px-1.5 py-0.5 font-jetbrains text-[10px] leading-none tabular-nums text-gdb-fgdim">
          {total}
        </span>
      </button>
      {!colapsado && <div className="ml-2.5 border-l border-gdb-sep/40 pl-1.5 py-0.5">{children}</div>}
    </div>
  );
}

function TableNode({
  schema,
  table,
  expanded,
  onToggle,
  isFavorite,
  sessionId,
}: {
  schema: string;
  table: { name: string; type: "table" | "view"; columns: { name: string; type: string; isPrimaryKey: boolean; nullable: boolean; fk?: { schema: string; table: string; column: string } }[] };
  expanded: boolean;
  onToggle: () => void;
  isFavorite: boolean;
  sessionId?: string;
}) {
  const dispatch = useAppDispatch();

  function openTab(whereColumn?: string, whereValue?: unknown) {
    dispatch({
      type: "OPEN_TABLE_TAB",
      payload: { schema, table: table.name, whereColumn, whereValue },
    });
  }

  function openDiagram() {
    dispatch({
      type: "OPEN_DIAGRAM_TAB",
      payload: { schema, table: table.name },
    });
  }

  function copyName() {
    navigator.clipboard.writeText(`${schema}.${table.name}`);
  }

  async function copyDdl() {
    if (!sessionId) {
      toast.error("No hay una conexión activa");
      return;
    }
    try {
      const ddl = await getObjectDdl(sessionId, schema, table.name, "table");
      await navigator.clipboard.writeText(ddl);
      toast.success(`DDL de "${table.name}" copiado al portapapeles`);
    } catch (err) {
      toast.error(`No se pudo obtener el DDL: ${String(err)}`);
    }
  }

  function toggleFavorite() {
    dispatch({
      type: "TOGGLE_FAVORITE_TABLE",
      payload: { schema, table: table.name },
    });
  }

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger className="contents">
          <div
            className={cn(
              "group flex min-w-0 items-center gap-1 rounded-md h-[var(--gdb-row)] px-1.5 transition-colors hover:bg-gdb-rowhover",
              expanded && "bg-gdb-rowhover/40"
            )}
          >
            <button
              type="button"
              onClick={onToggle}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-jetbrains text-foreground"
            >
              {expanded ? <IjIcon name="chevronDown" /> : <IjIcon name="chevronRight" />}
              {table.type === "view" ? (
                <IjIcon name="view" />
              ) : (
                <IjIcon name="table" />
              )}
              <span
                className="truncate cursor-pointer"
                title={table.name}
                onDoubleClick={() => openTab()}
              >
                {table.name}
              </span>
            </button>
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
              {!isFavorite && (
                <span className="shrink-0 font-jetbrains text-[10px] tabular-nums text-gdb-fgdim/70 group-hover:hidden group-has-[[data-popup-open]]:hidden">
                  {table.columns.length}
                </span>
              )}
              <button
                type="button"
                onClick={toggleFavorite}
                className={cn(
                  "items-center rounded p-0.5 transition-opacity hover:bg-gdb-field",
                  isFavorite
                    ? "flex"
                    : "hidden group-hover:flex group-has-[[data-popup-open]]:flex focus-visible:flex"
                )}
                title={isFavorite ? "Quitar de favoritos" : "Agregar a favoritos"}
              >
                <IjIcon name={isFavorite ? "star" : "starEmpty"} />
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger className="hidden items-center rounded px-1 text-[10px] text-muted-foreground hover:bg-gdb-field hover:text-foreground group-hover:flex group-has-[[data-popup-open]]:flex data-[popup-open]:flex focus-visible:flex">
                  ⋮
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-32">
                  <DropdownMenuItem onClick={() => openTab()}>Abrir</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => openTab()}>
                    SELECT 500
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={openDiagram}>
                    <IjIcon name="diagram" className="mr-2" />
                    Ver diagrama
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={copyName}>Copiar nombre</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void copyDdl()}>Copiar DDL</DropdownMenuItem>
                  <DropdownMenuItem onClick={toggleFavorite}>
                    {isFavorite ? "Quitar de favoritos" : "Agregar a favoritos"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent align="start" className="min-w-40">
          <ContextMenuItem onClick={() => openTab()}>Abrir</ContextMenuItem>
          <DropdownMenuItem onClick={() => openTab()}>
            SELECT 500
          </DropdownMenuItem>
          <ContextMenuItem onClick={openDiagram}>
            <IjIcon name="diagram" className="mr-2" />
            Ver diagrama
          </ContextMenuItem>
          <ContextMenuItem onClick={copyName}>Copiar nombre</ContextMenuItem>
          <ContextMenuItem onClick={() => void copyDdl()}>Copiar DDL</ContextMenuItem>
          <ContextMenuItem onClick={toggleFavorite}>
            {isFavorite ? "Quitar de favoritos" : "Agregar a favoritos"}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {expanded && (
        <div className="ml-2.5 border-l border-gdb-sep/40 pl-2 py-0.5">
          {table.columns.map((col) => (
            <div
              key={col.name}
              className="group/column flex min-w-0 items-center justify-between gap-2 rounded-md h-[var(--gdb-row)] px-1.5 text-xs font-jetbrains text-gdb-fgdim transition-colors hover:bg-gdb-rowhover hover:text-foreground"
            >
              <div className="flex min-w-0 items-center gap-1.5">
                {/* T5: como DataGrip, el icono de columna en TODAS las columnas; PK y FK van como insignias
                    superpuestas (src/components/column-icon.tsx) en vez de sustituir el icono. La FK conserva su
                    tooltip con el destino. */}
                {col.fk ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={<span className="inline-flex shrink-0 cursor-default" />}
                    >
                      <ColumnIcon primaryKey={col.isPrimaryKey} foreignKey />
                    </TooltipTrigger>
                    <TooltipContent>
                      FK → {col.fk.schema}.{col.fk.table}.{col.fk.column}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <ColumnIcon primaryKey={col.isPrimaryKey} />
                )}
                <span className="truncate">{col.name}</span>
                {col.isPrimaryKey && (
                  <span className="shrink-0 rounded bg-secondary px-1 py-px font-jetbrains text-[9px] font-bold leading-none text-foreground">
                    PK
                  </span>
                )}
                {col.fk && (
                  <span className="shrink-0 rounded bg-primary/15 px-1 py-px font-jetbrains text-[9px] font-bold leading-none text-primary">
                    FK
                  </span>
                )}
              </div>
              <span className="shrink-0 font-jetbrains text-[10px] tabular-nums text-gdb-fgdim/70">
                {col.type}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RoutineNode({
  schema,
  routine,
  sessionId,
}: {
  schema: string;
  routine: { name: string; type: "function" | "procedure"; language?: string };
  sessionId?: string;
}) {
  const dispatch = useAppDispatch();

  async function copyName() {
    await navigator.clipboard.writeText(`${schema}.${routine.name}`);
  }

  async function fetchDdl(): Promise<string> {
    if (!sessionId) throw new Error("No hay una conexión activa");
    return getObjectDdl(sessionId, schema, routine.name, routine.type);
  }

  async function copyDdl() {
    try {
      const ddl = await fetchDdl();
      await navigator.clipboard.writeText(ddl);
      toast.success(`DDL de "${routine.name}" copiado al portapapeles`);
    } catch (err) {
      toast.error(`No se pudo obtener el DDL: ${String(err)}`);
    }
  }

  async function openDdlInEditor() {
    try {
      const ddl = await fetchDdl();
      dispatch({ type: "SET_SQL", payload: ddl });
      dispatch({ type: "SET_ACTIVE_TAB", payload: "sql" });
    } catch (err) {
      toast.error(`No se pudo obtener el DDL: ${String(err)}`);
    }
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger className="contents">
        <div
          onClick={() => void openDdlInEditor()}
          className="group flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md h-[var(--gdb-row)] px-1.5 transition-colors hover:bg-gdb-rowhover"
        >
          {routine.type === "procedure" ? (
            <IjIcon name="procedure" />
          ) : (
            <IjIcon name="function" />
          )}
          <span className="min-w-0 flex-1 truncate text-xs font-jetbrains text-foreground">
            {routine.name}
          </span>
          <span className="ml-auto shrink-0 font-jetbrains text-[10px] tabular-nums text-gdb-fgdim/70">
            {routine.language ?? routine.type}
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent align="start" className="min-w-40">
        <ContextMenuItem onClick={() => void openDdlInEditor()}>
          Ver DDL en editor
        </ContextMenuItem>
        <ContextMenuItem onClick={copyName}>Copiar nombre</ContextMenuItem>
        <ContextMenuItem onClick={() => void copyDdl()}>Copiar DDL</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function TriggerNode({
  schema,
  trigger,
  sessionId,
}: {
  schema: string;
  trigger: {
    name: string;
    targetTable?: string;
    timing?: string;
    event?: string;
  };
  sessionId?: string;
}) {
  const dispatch = useAppDispatch();

  async function copyName() {
    await navigator.clipboard.writeText(`${schema}.${trigger.name}`);
  }

  async function fetchDdl(): Promise<string> {
    if (!sessionId) throw new Error("No hay una conexión activa");
    return getObjectDdl(sessionId, schema, trigger.name, "trigger");
  }

  async function copyDdl() {
    try {
      const ddl = await fetchDdl();
      await navigator.clipboard.writeText(ddl);
      toast.success(`DDL de "${trigger.name}" copiado al portapapeles`);
    } catch (err) {
      toast.error(`No se pudo obtener el DDL: ${String(err)}`);
    }
  }

  async function openDdlInEditor() {
    try {
      const ddl = await fetchDdl();
      dispatch({ type: "SET_SQL", payload: ddl });
      dispatch({ type: "SET_ACTIVE_TAB", payload: "sql" });
    } catch (err) {
      toast.error(`No se pudo obtener el DDL: ${String(err)}`);
    }
  }

  const detail = [trigger.timing, trigger.event, trigger.targetTable]
    .filter(Boolean)
    .join(" · ");
  const meta =
    trigger.targetTable ??
    ([trigger.timing, trigger.event].filter(Boolean).join(" ") || undefined);

  return (
    <ContextMenu>
      <ContextMenuTrigger className="contents">
        <Tooltip>
          {/* El Trigger de base-ui renderiza su propio <button> por defecto: envolvía la fila, encogía a su contenido
              y se centraba (icono en x = 96 en vez de 34, medido). Con `render` la propia fila es el disparador,
              igual que las demás filas del árbol (patrón de dialog.tsx con DialogPrimitive.Close). */}
          <TooltipTrigger
            render={
              <div
                onClick={() => void openDdlInEditor()}
                className="group flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md h-[var(--gdb-row)] px-1.5 transition-colors hover:bg-gdb-rowhover"
              />
            }
          >
            <IjIcon name="trigger" />
            <span className="min-w-0 flex-1 truncate text-xs font-jetbrains text-foreground">
              {trigger.name}
            </span>
            {meta && (
              <span className="ml-auto max-w-[45%] shrink-0 truncate font-jetbrains text-[10px] tabular-nums text-gdb-fgdim/70">
                {meta}
              </span>
            )}
          </TooltipTrigger>
          {detail && <TooltipContent>{detail}</TooltipContent>}
        </Tooltip>
      </ContextMenuTrigger>
      <ContextMenuContent align="start" className="min-w-40">
        <ContextMenuItem onClick={() => void openDdlInEditor()}>
          Ver DDL en editor
        </ContextMenuItem>
        <ContextMenuItem onClick={copyName}>Copiar nombre</ContextMenuItem>
        <ContextMenuItem onClick={() => void copyDdl()}>Copiar DDL</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
