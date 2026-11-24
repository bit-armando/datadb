import { dialectoSql } from "@/shared/connection-net";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAppState, useAppDispatch, useActiveConsole } from "@/hooks/use-app-state";
import { runQuery as apiRunQuery } from "@/lib/api";
import { quoteIdentifier, quoteValue } from "@/lib/quote";
import { runWithConsoleSession } from "@/lib/session-reconnect-client";
import type { ConsoleBinding, TableTab, TableContext, QueryResult, Session } from "@/lib/types";
import { ResultsGrid } from "./results-grid";
import { FkQuickViewDialog, type FkQuickTarget } from "./fk-quick-view-dialog";
import { ColumnAutocompleteInput } from "./column-autocomplete-input";
import { IjIcon } from "@/components/ij-icon";
import { useConectarConsola } from "@/hooks/use-conectar-consola";
import { PlayIcon } from "lucide-react";

interface TableViewTabProps {
  tab: TableTab;
}

export function TableViewTab({ tab }: TableViewTabProps) {
  const state = useAppState();
  const { schema } = state;
  const dispatch = useAppDispatch();
  const activeConsole = useActiveConsole();
  const tabConsole =
    (tab.consoleId ? state.consoles.find((c) => c.id === tab.consoleId) : undefined) ??
    activeConsole;
  const session = tabConsole.session;
  const binding = tabConsole.binding;
  // R101: sin sesión, la pestaña ofrece reconectar por sí misma (el «Conectar» de la barra superior).
  const { conectar, conectando } = useConectarConsola();
  const [conectandoTab, setConectandoTab] = React.useState(false);
  const { target } = tab;

  const sessionRef = React.useRef<Session | null>(session);
  const bindingRef = React.useRef<ConsoleBinding | null | undefined>(binding);
  const consoleIdRef = React.useRef<string>(tabConsole.id);
  React.useEffect(() => {
    sessionRef.current = session;
    bindingRef.current = binding;
    consoleIdRef.current = tabConsole.id;
  }, [session, binding, tabConsole.id]);

  const [whereClause, setWhereClause] = React.useState("");
  const [orderBy, setOrderBy] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<QueryResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [tableContext, setTableContext] = React.useState<TableContext | null>(null);

  /**
   * Fase 13 (T5). `whereAplicado` es el último `WHERE` que se llegó a ejecutar: es a donde vuelve
   * Escape, para poder deshacer un experimento sin borrar letra a letra.
   *
   * El historial guarda lo aplicado (no lo tecleado), que es lo que hace útil la flecha: volver a la
   * condición de hace tres consultas.
   */
  const [whereAplicado, setWhereAplicado] = React.useState("");
  const [historialWhere, setHistorialWhere] = React.useState<string[]>([]);
  const [orderAplicado, setOrderAplicado] = React.useState("");
  const [historialOrder, setHistorialOrder] = React.useState<string[]>([]);
  /** Qué campo dio el último error, para marcar ESE input y no los dos. */
  const [campoConError, setCampoConError] = React.useState<"where" | "order" | null>(null);

  const dbType = session?.type ?? binding?.type ?? "postgres";

  const columns = React.useMemo(() => {
    const node = schema?.find((s) => s.name === target.schema);
    return node?.tables.find((t) => t.name === target.table)?.columns ?? [];
  }, [schema, target]);

  const buildQuery = React.useCallback(() => {
    const qSchema = quoteIdentifier(target.schema, dialectoSql(dbType));
    const qTable = quoteIdentifier(target.table, dialectoSql(dbType));
    let q = `SELECT * FROM ${qSchema}.${qTable}`;
    const parts: string[] = [];
    if (target.whereColumn && target.whereValue !== undefined) {
      parts.push(
        `${quoteIdentifier(target.whereColumn, dialectoSql(dbType))} = ${quoteValue(target.whereValue)}`
      );
    }
    if (whereClause.trim()) {
      parts.push(`(${whereClause.trim()})`);
    }
    if (parts.length) {
      q += ` WHERE ${parts.join(" AND ")}`;
    }
    if (orderBy.trim()) {
      q += ` ORDER BY ${orderBy.trim()}`;
    }
    // Fase 13 (T6, R55): aquí había un `LIMIT 50` fijo mientras la propia barra enseñaba el campo
    // «máx.» que la fase 11 hizo configurable — un control que mentía. El tope lo pone ahora el
    // camino común de `query:execute` (`applyLimit`, con el valor del usuario), que además es quien
    // informa `limitApplied`/`effectiveLimit` para la insignia y la paginación.
    return q;
  }, [target, whereClause, orderBy, dbType]);

  const detectContext = React.useCallback(() => {
    if (!schema) {
      setTableContext(null);
      return;
    }
    const node = schema.find((s) => s.name === target.schema);
    const table = node?.tables.find((t) => t.name === target.table);
    if (!table || table.columns.filter((c) => c.isPrimaryKey).length !== 1) {
      setTableContext(null);
      return;
    }
    setTableContext({
      schema: target.schema,
      table: target.table,
      pkColumns: table.columns.filter((c) => c.isPrimaryKey),
      columns: table.columns,
    });
  }, [schema, target]);

  const load = React.useCallback(
    async (
      sql: string,
      opciones: { campo?: "where" | "order"; where?: string; order?: string } = {}
    ) => {
      if (!sessionRef.current) return;
      setLoading(true);
      setError(null);
      try {
        const { result: res } = await runWithConsoleSession(
          {
            consoleId: consoleIdRef.current,
            session: sessionRef.current,
            binding: bindingRef.current,
            onSessionChange: (next) => {
              sessionRef.current = next;
              dispatch({
                type: "SET_SESSION",
                payload: { consoleId: consoleIdRef.current, session: next },
              });
            },
          },
          (s) => apiRunQuery(s.sessionId, sql)
        );
        setResult(res);
        setCampoConError(null);
        /*
         * Fase 13 (T5): el historial y el «último aplicado» (a donde vuelve Escape) sólo apuntan lo
         * que **corrió bien**. Apuntando lo tecleado, un `WHERE` con error dejaba a Escape devolviendo
         * justo la condición rota — medido en la sonda.
         */
        if (opciones.where !== undefined) {
          setWhereAplicado(opciones.where);
          setHistorialWhere((previos) =>
            [opciones.where!, ...previos.filter((t) => t !== opciones.where)].slice(0, 20)
          );
        }
        if (opciones.order !== undefined) {
          setOrderAplicado(opciones.order);
          setHistorialOrder((previos) =>
            [opciones.order!, ...previos.filter((t) => t !== opciones.order)].slice(0, 20)
          );
        }
        detectContext();
      } catch (err) {
        // Fase 13 (T5): el error se queda pegado al CAMPO que lo causó (borde rojo + mensaje con su
        // nombre). Antes sólo salía un toast que se va solo y no dice cuál de los dos campos era.
        setError(String(err));
        setCampoConError(opciones.campo ?? null);
        toast.error(String(err));
      } finally {
        setLoading(false);
      }
    },
    [detectContext, dispatch]
  );

  /** Aplica lo escrito en `WHERE` (T5). El historial se apunta en `load`, y sólo si tuvo éxito. */
  const aplicarWhere = React.useCallback(() => {
    void load(buildQuery(), { campo: "where", where: whereClause });
  }, [whereClause, buildQuery, load]);

  React.useEffect(() => {
    if (!session) return;
    void (async () => {
      await load(buildQuery());
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, session?.sessionId, load]);

  async function refresh() {
    // «Ejecutar» también deja rastro en el historial: es la misma condición, aplicada a mano.
    await load(buildQuery(), { where: whereClause, order: orderBy });
  }

  /** Los dos campos se aplican igual: Enter y Escape (T5). */
  function revertirWhere() {
    setWhereClause(whereAplicado);
  }

  /**
   * `ORDER BY` con el mismo contrato que el `WHERE`: si Enter funciona en uno y no en el de al lado,
   * el gesto se vuelve una lotería. Su historial es aparte porque son condiciones distintas.
   */
  const aplicarOrder = React.useCallback(() => {
    void load(buildQuery(), { campo: "order", order: orderBy });
  }, [orderBy, buildQuery, load]);

  const [fkQuickTarget, setFkQuickTarget] = React.useState<FkQuickTarget | null>(null);

  function handleNavigateFk(
    schema: string,
    table: string,
    column: string,
    value: unknown,
    sourceTable?: string,
    sourceColumn?: string
  ) {
    setFkQuickTarget({ schema, table, column, value, sourceTable, sourceColumn });
  }

  function handleOpenFkInTab(fkTarget: FkQuickTarget) {
    dispatch({
      type: "OPEN_TABLE_TAB",
      payload: {
        schema: fkTarget.schema,
        table: fkTarget.table,
        whereColumn: fkTarget.column,
        whereValue: fkTarget.value,
      },
    });
  }

  async function handleConectarPestana() {
    if (tabConsole.id === activeConsole.id) {
      await conectar();
      return;
    }
    if (!tabConsole.binding) {
      toast.error("La consola no está atada a ninguna conexión: elige un perfil en Conexiones…");
      return;
    }
    setConectandoTab(true);
    try {
      const { session: woken } = await runWithConsoleSession(
        {
          consoleId: tabConsole.id,
          session: null,
          binding: tabConsole.binding,
          onSessionChange: (next) => {
            sessionRef.current = next;
            dispatch({ type: "SET_SESSION", payload: { consoleId: tabConsole.id, session: next } });
          },
        },
        async (s) => s
      );
      toast.success(`Consola conectada a ${woken.name}`);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setConectandoTab(false);
    }
  }

  // R101: sin sesión (el worker cierra las inactivas a los 10 min) la pestaña no ejecuta nada y antes
  // quedaba muda. Aquí se ofrece el mismo «Conectar» de la barra superior, sin salir de la pestaña.
  // Va DESPUÉS de todos los hooks (regla de hooks): el return temprano no los salta.
  if (!session) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-editor text-xs text-gdb-fgmuted">
        <IjIcon name="connect" className="size-6 opacity-50" />
        <p className="max-w-sm text-center leading-relaxed">
          Esta pestaña no tiene conexión. Conéctala para ver los datos de{" "}
          <span className="font-jetbrains text-gdb-fg">{target.table}</span>.
        </p>
        <Button size="sm" onClick={() => void handleConectarPestana()} disabled={conectando || conectandoTab} data-testid="conectar-en-pestana" className="h-7 gap-1.5">
          <IjIcon name="connect" />
          {conectando || conectandoTab ? "Conectando…" : "Conectar"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-sm font-medium">
          {target.schema}.{target.table}
        </div>
        <ColumnAutocompleteInput
          columns={columns}
          value={whereClause}
          onChange={setWhereClause}
          placeholder="WHERE ... (Enter para aplicar)"
          onAplicar={aplicarWhere}
          onRevertir={revertirWhere}
          historial={historialWhere}
          invalido={campoConError === "where"}
        />
        <ColumnAutocompleteInput
          columns={columns}
          value={orderBy}
          onChange={setOrderBy}
          placeholder="ORDER BY ..."
          onAplicar={aplicarOrder}
          onRevertir={() => setOrderBy(orderAplicado)}
          historial={historialOrder}
          invalido={campoConError === "order"}
        />
        <Button size="sm" onClick={refresh} disabled={loading}>
          <PlayIcon className="size-4" />
          Ejecutar
        </Button>
      </div>
      {error && (
        <div
          data-testid="error-de-la-condicion"
          className="rounded-md bg-destructive/10 p-2 text-xs text-destructive"
        >
          {/* Fase 13 (T5): el mensaje nombra el campo que lo causó y se queda en pantalla; el toast
              solo (que se va en segundos) obligaba a repetir la consulta para volver a leerlo. */}
          <span className="font-medium">
            {campoConError === "where" ? "WHERE" : campoConError === "order" ? "ORDER BY" : "Error"}:
          </span>{" "}
          {error}
        </div>
      )}
      {result && (
        <div className="min-h-0 flex-1">
          <ResultsGrid
            result={result}
            tableContext={tableContext}
            onNavigateFk={handleNavigateFk}
            onRefresh={refresh}
          />
        </div>
      )}
      <FkQuickViewDialog
        target={fkQuickTarget}
        session={session}
        onClose={() => setFkQuickTarget(null)}
        onOpenInTab={handleOpenFkInTab}
      />
    </div>
  );
}
