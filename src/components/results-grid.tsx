import { dialectoSql } from "@/shared/connection-net";
import * as React from "react";
import { IjIcon } from "@/components/ij-icon";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ResultExporter } from "./result-exporter";
import { setFormatoDeCopia, setMaxRows, useDataSettings } from "@/lib/data-settings";
import { claveDeAnchos, useAnchosDeRejilla } from "@/lib/grid-widths";
import { setCeldaEnfocada, type CeldaEnfocada } from "@/lib/focused-cell";
import { DataGrid } from "./grid/data-grid";
import {
  copiarComo,
  desdeGridSelection,
  extraerSeleccion,
  ETIQUETA_DE_FORMATO,
  FORMATOS_DE_COPIA,
  type ExtraccionDeSeleccion,
  type FormatoDeCopia,
  type OpcionesDeCopia,
} from "./grid/copy-as";
import { firmaDeColumnas, hayFiltro, type TextosDeFiltro } from "./grid/filtering";
import type { GridSelection } from "@glideapps/glide-data-grid";
import { MAX_ROWS_CEILING, MIN_MAX_ROWS, DEFAULT_MAX_ROWS, PRESETS_DE_FILAS } from "@/shared/limits";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AiDataDialog } from "./ai-data-dialog";
import { batchEdit } from "@/lib/api";
import { motivoDeSoloLectura } from "@/lib/result-origin";
import { columnKey } from "@/lib/query-columns";
import { useAppState, useActiveSession } from "@/hooks/use-app-state";
import {
  TESTID_REJILLA,
  registrarManejadoresDeRejilla,
} from "@/shell/keyboard-router";
import type {
  QueryResult,
  TableContext,
  BatchOperation,
} from "@/lib/types";

/*
  Fase 11 (T7): este archivo ya NO importa `@tanstack/react-table` ni `@tanstack/react-virtual`.
  La rejilla de resultados es `./grid/data-grid` (canvas, glide-data-grid) y aquí queda sólo lo que
  la rodea: la barra de acciones, la edición por lotes contra la base y el exportador. Lo borrado
  —columnas de tanstack, virtualizador, arrastre de celdas, foco de celda, copiado de celdas
  sueltas— eran ~470 líneas que duplicaban lo que la rejilla ya trae.

  Fase 14 (T6/T7): aquí viven también el «data extractor» activo (el selector de la barra), el
  camino ÚNICO de copiado (`copiarSeleccion`) y el menú contextual del clic derecho. Se borró el
  TERCER escapador de CSV del repo (`formatCopyValue`/`formatValuesForCopy`): el formato de cada
  valor lo decide `copiarComo` con el escapador único de `lib/export-formats.ts`.
*/

type RowData = Record<string, unknown> & { __newId?: string };

interface ResultsGridProps {
  result: QueryResult;
  tableContext: TableContext | null;
  onNavigateFk?: (
    schema: string,
    table: string,
    column: string,
    value: unknown,
    sourceTable?: string,
    sourceColumn?: string
  ) => void;
  onRefresh?: () => Promise<void> | void;
  offset?: number;
  onPrevPage?: () => Promise<void> | void;
  onNextPage?: () => Promise<void> | void;
  /**
   * Fase 13 (T4): estado de los filtros controlado desde fuera.
   *
   * El panel de resultados lo usa para recordarlos **por pestaña**: aquí, dentro, no pueden vivir
   * porque el efecto de abajo limpia todo cuando cambia `result` — que es justo lo que pasa al
   * cambiar de pestaña. Si no se pasan, la rejilla los lleva sola (es el caso de la vista de tabla,
   * que no tiene pestañas).
   */
  filtros?: TextosDeFiltro;
  onCambiarFiltros?: (filtros: TextosDeFiltro) => void;
}

/** Un valor en una línea corta para el tooltip de cambios pendientes (R94). */
function textoCorto(valor: unknown): string {
  if (valor === null || valor === undefined) return "NULL";
  const texto = typeof valor === "object" ? JSON.stringify(valor) : String(valor);
  return texto.length > 60 ? `${texto.slice(0, 57)}…` : texto;
}

function newId() {
  return `new-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export const ResultsGrid = React.memo(function ResultsGrid({
  result,
  tableContext,
  onNavigateFk,
  onRefresh,
  offset = 0,
  onPrevPage,
  onNextPage,
  filtros: filtrosDeFuera,
  onCambiarFiltros,
}: ResultsGridProps) {
  const { aiSettings } = useAppState();
  // Ediciones en la grilla van contra la sesión de la consola con foco.
  const session = useActiveSession();
  const { maxRows, formatoDeCopia } = useDataSettings();
  /**
   * R99-A: anchos de columna PERSISTENTES de esta rejilla (store `datadb-grid-widths-v1`, en
   * `lib/grid-widths.ts`). Se persisten porque redimensionar es una preferencia de comodidad del
   * usuario —darle sitio a una columna de fechas, de JSON o de un número que no cabe— y, si viviera
   * sólo en el estado del componente, se perdería en cuanto se re-ejecutara la consulta (cada
   * ejecución construye un `result` nuevo y remonta la rejilla), que es justo el caso del reporte:
   * en localStorage sobrevive a re-ejecutar la MISMA consulta y a reabrir la app.
   *
   * La clave decide QUÉ rejillas comparten anchos. Cuando el resultado ES una tabla (vista de tabla
   * o `SELECT … FROM una_tabla` resuelto por el parseo) la clave es por perfil+tabla
   * (`tabla:<perfil>:<esquema>.<tabla>`, en `lib/grid-widths.ts`): los anchos que le van bien a
   * `Banks_Bank` no le van bien a otra tabla, y las otras bases del mismo perfil (puertos,
   * servidores distintos) tienen tablas distintas con el mismo nombre — por eso entra el perfil.
   * En cualquier otro caso (consulta libre, JOIN, resultado de consola) la clave es la FIRMA DE
   * COLUMNAS del resultado (`consulta:<firma>`, `firmaDeColumnas` de `grid/filtering`): la misma
   * lista de columnas en el mismo orden es en la práctica «la misma consulta», y sus anchos son
   * intercambiables aunque el SQL cambie en un espacio.
   */
  const perfil = session?.profileId ?? null;
  const claveDeRejilla = tableContext
    ? claveDeAnchos({ profileId: perfil, schema: tableContext.schema, table: tableContext.table, firma: "" })
    : claveDeAnchos({ profileId: perfil, firma: firmaDeColumnas(result.columns) });
  const [anchos, cambiarAncho] = useAnchosDeRejilla(claveDeRejilla);
  const [seleccionCanvas, setSeleccionCanvas] = React.useState<GridSelection | undefined>();
  const [aiDataOpen, setAiDataOpen] = React.useState(false);
  /**
   * Fase 14 (T6): los índices VISIBLES que está enseñando la rejilla (posición visible → índice del
   * array original), tal como los publica `onOrdenCambiado`. Los necesita el copiado que NO entra
   * por la rejilla —el botón «Copiar» de la barra y el menú contextual—, que tienen que resolver la
   * misma selección que el ⌘C y con el mismo mapa de orden/filtro.
   *
   * El ⌘C no los usa: allí la rejilla traduce la selección con sus propios índices (que son éstos).
   */
  const [indicesVisibles, setIndicesVisibles] = React.useState<number[]>([]);
  /**
   * Fase 14 (T7): dónde se abrió el menú contextual del clic derecho, y sobre qué celda.
   *
   * `x`/`y` son coordenadas de VIEWPORT (glide las da como `event.bounds`, calculadas desde el
   * `getBoundingClientRect` del canvas), y por eso el ancla del menú es un elemento
   * `position: fixed`. `columna`/`indice` son de la celda pulsada: hacen falta para decidir si el
   * ítem «Ir a la referenciada» existe (la columna tiene que ser FK) y con qué valor navegar.
   */
  const [menuContextual, setMenuContextual] = React.useState<{
    x: number;
    y: number;
    columna: string;
    indice: number;
  } | null>(null);
  /**
   * Fase 13: la fila de filtros. `abierta` es una preferencia de vista (no se recuerda por pestaña
   * de resultado: es el mismo gesto en todas), y los textos van controlados desde fuera cuando el
   * panel de resultados los recuerda por pestaña (T4).
   */
  const [filaDeFiltrosAbierta, setFilaDeFiltrosAbierta] = React.useState(false);
  const [filtrosPropios, setFiltrosPropios] = React.useState<TextosDeFiltro>({});
  const filtros = filtrosDeFuera ?? filtrosPropios;
  /**
   * Lo que REALMENTE se está aplicando: los textos sólo filtran con la fila encendida.
   *
   * Es una sola expresión a propósito, y no dos (una para pasar a la rejilla y otra para el rótulo):
   * con la fila apagada el filtro no se aplicaba pero el contador seguía diciendo «50 de 50 filas»
   * —un rótulo que insinúa un filtro que no está puesto—, medido el 2026-10-12. El contador y la
   * rejilla tienen que mirar el mismo interruptor o acaban discrepando.
   */
  const filtrosAplicados = filaDeFiltrosAbierta ? filtros : undefined;
  /** Cuántas filas se ven tras el filtro: lo publica la rejilla, que ya calcula esa lista. */
  const [filasVisibles, setFilasVisibles] = React.useState<number | null>(null);
  /**
   * Filas marcadas, por id (`getRowId`). La alimenta el grid sobre canvas y de ella viven Duplicar,
   * Borrar y Copiar. Antes era el estado de selección de `@tanstack/react-table`.
   */
  const [rowSelection, setRowSelection] = React.useState<Record<string, true>>({});

  /** Nombre de la clave primaria EN LA TABLA: es el que va al `WHERE` del lote. */
  const pkColumn = tableContext?.pkColumns[0]?.name;
  /**
   * R94: nombre de la clave primaria EN EL RESULTADO, que es con el que se lee de cada fila. Con
   * un alias (`SELECT ficha.id AS ficha_id …`) no coincide con `pkColumn`; sin contexto por origen
   * (vista de tabla, parseo del SQL) es el mismo.
   */
  const pkKey = tableContext?.pkEnResultado ?? pkColumn;
  const canEdit = !!tableContext && !!pkColumn && !!pkKey;
  /**
   * R94: agregar, duplicar y borrar filas solo cuando el resultado ES la tabla (todas sus columnas
   * salen de ella y con su nombre). En un JOIN una fila del resultado no es una fila de la tabla:
   * ahí solo se cambian valores (UPDATE por clave), como el caso que reportó el usuario.
   */
  const puedeAgregar = canEdit && !tableContext?.soloActualizar;

  /**
   * R94: la columna REAL de la tabla para una columna del resultado (`undefined` = no es de la
   * tabla editable). Sin mapa (contexto de siempre) el nombre del resultado ES el de la columna.
   */
  const columnaReal = React.useCallback(
    (nombre: string): string | undefined =>
      tableContext?.columnasDelResultado ? tableContext.columnasDelResultado[nombre] : nombre,
    [tableContext]
  );

  /** Por qué una columna no se deja editar (`null` = se puede). Es el texto del editor y del rótulo. */
  const motivoSoloLectura = React.useCallback(
    (nombre: string) => motivoDeSoloLectura(nombre, tableContext, result.columns),
    [tableContext, result.columns]
  );

  /**
   * Cambios pendientes por celda. `column` es el nombre EN EL RESULTADO (con él se pinta la celda y
   * se lee la fila) y `columnaReal` el de la tabla (con él se arma el UPDATE): con alias difieren.
   */
  const [editedCells, setEditedCells] = React.useState<
    Map<string, { pkValue: unknown; column: string; columnaReal: string; value: unknown }>
  >(new Map());
  const [newRows, setNewRows] = React.useState<RowData[]>([]);
  const [rowsToDelete, setRowsToDelete] = React.useState<Map<string, unknown>>(new Map());
  const [saving, setSaving] = React.useState(false);

  const handleCellChange = React.useCallback(
    (row: RowData, columnId: string, value: unknown) => {
      if (!tableContext || !pkColumn || !pkKey) return;
      // Sin `@tanstack/react-table` no hay id sintético de columna: el grid pasa el nombre real.
      const originalName = columnId;
      // R94: una columna que no se puede editar NO entra en los cambios pendientes. Antes el
      // editor aceptaba el valor y aquí se tiraba sin decir nada; ahora el editor ni lo ofrece
      // (ver `motivoSoloLectura`), y esto es la segunda red por si llega por otra vía.
      const real = columnaReal(originalName);
      if (real === undefined || motivoSoloLectura(originalName) !== null) {
        console.warn("[rejilla] edición ignorada en columna de solo lectura", originalName);
        return;
      }
      if (row.__newId) {
        setNewRows((prev) =>
          prev.map((r) => (r.__newId === row.__newId ? { ...r, [originalName]: value } : r))
        );
        return;
      }
      const pkValue = row[pkKey];
      const key = `${pkValue}::${originalName}`;
      // El valor ORIGINAL sale del resultado, no de `row`: `row` es la fila de `editedData`, que ya
      // lleva el cambio pendiente. Comparar con ella hacía que volver a confirmar el MISMO valor
      // (reabrir la celda y ⏎, medido en la app con la sonda de R94) borrara el cambio pendiente
      // en silencio, porque «el nuevo valor es igual al de la fila».
      const filaOriginal = result.rows.find((r) => Object.is(r[pkKey], pkValue));
      const originalValue = filaOriginal ? filaOriginal[originalName] : row[originalName];
      if (Object.is(originalValue, value)) {
        setEditedCells((prev) => {
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
        return;
      }
      setEditedCells((prev) => {
        const next = new Map(prev);
        next.set(key, { pkValue, column: originalName, columnaReal: real, value });
        return next;
      });
    },
    [tableContext, pkColumn, pkKey, columnaReal, motivoSoloLectura, result.rows]
  );

  const getRowId = React.useMemo(() => {
    return (row: RowData, index: number) =>
      row.__newId
        ? row.__newId
        : pkKey
          ? String(row[pkKey] ?? `row-${index}`)
          : `row-${index}`;
  }, [pkKey]);

  const editedData = React.useMemo(() => {
    const base = result.rows.map((row) => {
      const clone: RowData = { ...row };
      for (const edit of editedCells.values()) {
        if (edit.pkValue === row[pkKey!]) {
          clone[edit.column] = edit.value;
        }
      }
      return clone;
    });
    return [...base, ...newRows];
  }, [result.rows, pkKey, editedCells, newRows]);

  /**
   * Fase 11 (T7): aquí vivía el arrastre de celdas del grid DOM — `dragStateRef`, `selectCellRange`,
   * `startDrag`, `updateDrag` y el copiado de celdas sueltas, todo construido sobre los ids de fila
   * y columna de `@tanstack/react-table`. El grid sobre canvas trae selección de rango, arrastre y
   * copiado propios, así que eran ~120 líneas que sólo podían desincronizarse con la rejilla.
   */

  const prevResultRef = React.useRef(result);
  /** Columnas del último result, para saber si los filtros locales siguen valiendo (fase 13). */
  const firmaPreviaRef = React.useRef(firmaDeColumnas(result.columns));

  React.useEffect(() => {
    if (prevResultRef.current === result) return;
    prevResultRef.current = result;
    setRowSelection({});
    setEditedCells(new Map());
    setNewRows([]);
    setRowsToDelete(new Map());
    // Fase 13: los filtros locales sólo se tiran si cambian las COLUMNAS (`firmaDeColumnas`).
    // Aplicar un WHERE, refrescar o paginar traen un result nuevo con las mismas columnas, y ahí el
    // filtro sigue teniendo sentido. Cuando vienen de fuera (panel de resultados, por pestaña) no se
    // tocan aquí: de eso se encarga el panel, que sabe a qué pestaña pertenece cada result.
    const firma = firmaDeColumnas(result.columns);
    if (filtrosDeFuera === undefined && firma !== firmaPreviaRef.current) setFiltrosPropios({});
    firmaPreviaRef.current = firma;
  }, [result, filtrosDeFuera]);

  const cambiarFiltro = React.useCallback(
    (columna: string, valor: string) => {
      const siguientes = { ...(filtrosDeFuera ?? filtrosPropios), [columna]: valor };
      if (onCambiarFiltros) onCambiarFiltros(siguientes);
      else setFiltrosPropios(siguientes);
    },
    [filtrosDeFuera, filtrosPropios, onCambiarFiltros]
  );

  const limpiarFiltros = React.useCallback(() => {
    if (onCambiarFiltros) onCambiarFiltros({});
    else setFiltrosPropios({});
  }, [onCambiarFiltros]);

  /**
   * Filas con cambios sin guardar, por índice del array original (decisión D4).
   *
   * Filtrar no puede llevarse por delante una edición que todavía no se ha confirmado: si la fila
   * desaparece, el usuario no tiene forma de saber que sigue pendiente ni de recuperarla. Estas
   * filas se siguen enseñando (teñidas, que es como el grid ya marca lo pendiente).
   *
   * Se calcula aquí y no en la rejilla porque el contenedor es quien sabe qué está pendiente: las
   * filas nuevas van al final de `editedData`, y las editadas y marcadas para borrar se localizan
   * por clave primaria (el mismo criterio con el que se arma el lote contra la base).
   */
  const indicesConCambios = React.useMemo(() => {
    const indices = new Set<number>();
    for (let i = 0; i < newRows.length; i++) indices.add(result.rows.length + i);
    if ((editedCells.size > 0 || rowsToDelete.size > 0) && pkKey) {
      const porClave = new Map<string, number>();
      result.rows.forEach((fila, i) => porClave.set(String(fila[pkKey]), i));
      for (const edicion of editedCells.values()) {
        const i = porClave.get(String(edicion.pkValue));
        if (i !== undefined) indices.add(i);
      }
      for (const clave of rowsToDelete.keys()) {
        const i = porClave.get(clave);
        if (i !== undefined) indices.add(i);
      }
    }
    return indices;
  }, [newRows.length, editedCells, rowsToDelete, result.rows, pkKey]);

  /**
   * Fase 11 (T7): las filas marcadas, sin pasar por `@tanstack/react-table`.
   *
   * La selección la lleva `rowSelection` (un `Record<id, true>`), que alimenta el grid sobre
   * canvas. Antes esto era `table.getSelectedRowModel().rows`, y la tabla de tanstack existía
   * sobre todo para eso: con la rejilla en canvas no queda nada que ordenar ni paginar en el
   * cliente, así que la tabla sobra.
   */
  const filasSeleccionadas = React.useCallback((): RowData[] => {
    const ids = new Set(Object.keys(rowSelection));
    if (ids.size === 0) return [];
    return editedData.filter((fila, i) => ids.has(getRowId(fila, i)));
  }, [rowSelection, editedData, getRowId]);

  function addRow() {
    const empty: RowData = { __newId: newId() };
    if (tableContext) {
      for (const col of tableContext.columns) {
        if (!col.isPrimaryKey) {
          empty[col.name] = null;
        }
      }
    }
    setNewRows((prev) => [...prev, empty]);
  }

  function discardChanges() {
    setEditedCells(new Map());
    setNewRows([]);
    setRowsToDelete(new Map());
    setRowSelection({});
    toast("Cambios descartados");
  }

  async function confirmChanges() {
    if (!tableContext || !pkColumn || !session) return;
    const operations: BatchOperation[] = [];
    const updates = new Map<string, { pkValue: unknown; changes: Record<string, unknown> }>();

    for (const edit of editedCells.values()) {
      const entry = updates.get(String(edit.pkValue)) || {
        pkValue: edit.pkValue,
        changes: {},
      };
      // R94: el UPDATE usa la columna REAL (con alias, el nombre del resultado no existe en la tabla).
      entry.changes[edit.columnaReal] = edit.value;
      updates.set(String(edit.pkValue), entry);
    }
    for (const entry of updates.values()) {
      operations.push({ type: "update", pkValue: entry.pkValue, changes: entry.changes });
    }

    for (const row of newRows) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { __newId, ...values } = row;
      operations.push({ type: "insert", values });
    }

    for (const [, pkValue] of rowsToDelete) {
      operations.push({ type: "delete", pkValue });
    }

    if (operations.length === 0) {
      toast("No hay cambios para guardar");
      return;
    }

    setSaving(true);
    try {
      await batchEdit(session.sessionId, {
        schema: tableContext.schema,
        table: tableContext.table,
        pkColumn,
        operations,
      });
      toast.success(`${operations.length} operación(es) aplicadas`);
      setEditedCells(new Map());
      setNewRows([]);
      setRowsToDelete(new Map());
      setRowSelection({});
      await onRefresh?.();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSaving(false);
    }
  }

  function duplicateSelected() {
    if (!tableContext || !pkColumn || !puedeAgregar) return;
    const selected = filasSeleccionadas();
    const added: RowData[] = [];
    for (const row of selected) {
      const copy: RowData = { __newId: newId() };
      for (const col of tableContext.columns) {
        if (!col.isPrimaryKey) {
          copy[col.name] = row[col.name];
        }
      }
      added.push(copy);
    }
    if (added.length) {
      setNewRows((prev) => [...prev, ...added]);
      toast(`${added.length} fila(s) duplicada(s)`);
    }
  }

  function deleteRows(rows: RowData[]) {
    if (!tableContext || !pkKey || !puedeAgregar) return;
    const toRemoveNew: string[] = [];
    const toDelete = new Map<string, unknown>();
    for (const row of rows) {
      const newId = String(row.__newId);
      if (newId && newId !== "undefined") {
        toRemoveNew.push(newId);
      } else {
        const pkValue = row[pkKey];
        toDelete.set(String(pkValue), pkValue);
      }
    }
    if (toRemoveNew.length) {
      setNewRows((prev) => prev.filter((r) => !toRemoveNew.includes(String(r.__newId))));
    }
    if (toDelete.size) {
      setRowsToDelete((prev) => {
        const next = new Map(prev);
        for (const [key, value] of toDelete) next.set(key, value);
        return next;
      });
    }
  }

  function deleteSelected() {
    deleteRows(filasSeleccionadas());
  }

  /**
   * Fase 14 (T6, D2): el «data extractor» activo y el camino ÚNICO de copiado.
   *
   * Un solo sitio arma el texto de una selección, y lo usan los tres caminos que copian: el ⌘C (y
   * con él el menú nativo Edición → Copiar, que dispara el mismo evento `copy`), el botón «Copiar»
   * de la barra y los dos ítems del menú contextual. Antes había tres caminos distintos y DOS
   * escapadores de CSV conviviendo con el del exportador.
   *
   * El dialecto sale de la sesión activa (`session.type`), que es exactamente el union que espera
   * `copiarComo` para entrecomillar el INSERT. Sin sesión se asume Postgres: es el motor con el que
   * se prueban las vistas de tabla y el único de los tres cuyo entrecomillado (`"tabla"`) no
   * rompería nada al pegarse en un cliente Postgres; un INSERT con comillas invertidas contra
   * Postgres, en cambio, NO ejecuta.
   */
  const dialecto = dialectoSql(session?.type);
  const opcionesDeCopia = React.useMemo<OpcionesDeCopia>(
    () => ({ dialecto, tabla: tableContext?.table, schema: tableContext?.schema }),
    [dialecto, tableContext]
  );

  /** Texto de una extracción ya resuelta, en el formato pedido. */
  const textoDeSeleccion = React.useCallback(
    (extraccion: ExtraccionDeSeleccion, formato: FormatoDeCopia) =>
      copiarComo(formato, editedData, extraccion, opcionesDeCopia),
    [editedData, opcionesDeCopia]
  );

  /**
   * Copia la selección ACTUAL en el formato pedido y AVISA del resultado real.
   *
   * Ojo con `navigator.clipboard`: aquí NO hay evento `copy` (es una llamada desde un clic), así que
   * la vía es la API asíncrona. En el ⌘C se usa `clipboardData.setData` dentro del evento, que es
   * lo que hace que el portapapeles se escriba de forma síncrona y fiable.
   *
   * El aviso va DESPUÉS de que la promesa se resuelva, y no antes: `writeText` se rechaza con
   * `NotAllowedError` si el documento no tiene el foco (medido en la fase 14, T8, con la ventana
   * detrás), y antes de esto el rechazo quedaba sin capturar y el aviso decía «Copiado» igualmente
   * — un éxito falso con el portapapeles intacto. Ahora un fallo se ve (aviso de error) y queda en la
   * consola. Si no hay nada seleccionado no se avisa nada: no pasó nada.
   */
  const copiarSeleccion = React.useCallback(
    (formato: FormatoDeCopia): void => {
      const extraccion = extraerSeleccion(
        desdeGridSelection(seleccionCanvas),
        indicesVisibles,
        result.columns
      );
      const texto = textoDeSeleccion(extraccion, formato);
      if (texto === "") return;
      navigator.clipboard.writeText(texto).then(
        () => toast(`Copiado como ${ETIQUETA_DE_FORMATO[formato]}`),
        (error: unknown) => {
          console.error("[copiar] no se pudo escribir en el portapapeles", error);
          toast.error("No se pudo copiar al portapapeles", {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      );
    },
    [seleccionCanvas, indicesVisibles, result.columns, textoDeSeleccion]
  );

  /** ¿Hay algo seleccionado? Es lo que habilita «Copiar»: rango, filas marcadas o columnas. */
  const haySeleccion = desdeGridSelection(seleccionCanvas) !== undefined;

  /**
   * El texto que la rejilla pide en su evento `copy` (prop `textoParaCopiar`). Usa el formato
   * ACTIVO: cambiar de formato en el selector es lo que decide en qué formato copia ⌘C.
   */
  const textoParaCopiar = React.useCallback(
    (extraccion: ExtraccionDeSeleccion) => textoDeSeleccion(extraccion, formatoDeCopia),
    [textoDeSeleccion, formatoDeCopia]
  );

  function copySelectedRows() {
    copiarSeleccion(formatoDeCopia);
  }

  const selectedRowCount = Object.keys(rowSelection).length;

  /** R94: cuántos cambios hay sin guardar (celdas, filas nuevas y filas marcadas para borrar). */
  const pendientes = editedCells.size + newRows.length + rowsToDelete.size;
  /**
   * R94: la lista de lo pendiente, una línea por cambio, para el tooltip del rótulo y de «Guardar».
   * La fila se nombra por su clave primaria (`id = 6300196`), que es lo que el UPDATE va a usar, y
   * no por su posición en la rejilla, que cambia al ordenar o filtrar.
   */
  const detallePendientes = React.useMemo(() => {
    const lineas: string[] = [];
    const original = new Map<string, Record<string, unknown>>();
    if (pkKey) for (const fila of result.rows) original.set(String(fila[pkKey]), fila);
    for (const e of editedCells.values()) {
      const antes = original.get(String(e.pkValue))?.[e.column];
      lineas.push(`${pkKey} = ${String(e.pkValue)} · ${e.column}: ${textoCorto(antes)} → ${textoCorto(e.value)}`);
    }
    if (newRows.length > 0) lineas.push(`${newRows.length} fila(s) nueva(s)`);
    for (const clave of rowsToDelete.keys()) lineas.push(`${pkKey} = ${clave} · borrar fila`);
    return lineas.join("\n");
  }, [editedCells, newRows.length, rowsToDelete, result.rows, pkKey]);

  /**
   * Fase 15 (T5) — LOS MANEJADORES DE ESTA REJILLA, al enrutador de teclado.
   *
   * QUÉ CAMBIÓ Y POR QUÉ
   * --------------------
   * Hasta aquí, la rejilla tenía su propio `onKeyDown` de React sobre el contenedor que sólo
   * atendía DOS teclas: `⌘D` (duplicar filas marcadas) y `⌫`/`Delete` (borrarlas) — y las atendía
   * por burbujeo, sin mirar el foco: escribiendo DENTRO del overlay de edición de una celda,
   * `⌫` marcaba filas para borrar en vez de borrar un carácter. Ese manejador SE BORRÓ: la fase 15
   * trae un enrutador único en captura (`src/shell/keyboard-router.ts`) que decide por el foco del
   * DOM y llama a los manejadores de la instancia que lo tiene.
   *
   * POR QUÉ SE REGISTRAN POR INSTANCIA Y NO COMO UN SINGLETON: `ResultsGrid` está montada DOS veces
   * a la vez con frecuencia (el panel de resultados del dock inferior mientras la pestaña de vista
   * de tabla está abierta en el área principal, y al revés). El enrutador busca el contenedor
   * registrado MÁS CERCANO al elemento con foco (`manejadoresDeRejillaMasCercanos`) y llama a
   * ESOS: `⌘⏎` guarda en la rejilla que tiene el foco, no en «la rejilla».
   *
   * EL CONTRATO: cada manejador devuelve si ACTUÓ. `false` = «yo no tengo nada que hacer con esta
   * pulsación» y el enrutador NO consume la tecla (sigue su camino: glide, el menú…). Por eso se
   * comprueban aquí las precondiciones que antes miraba el manejador viejo (filas marcadas, poder
   * editar, paginación disponible). La única excepción es `guardarCambios`: el ENRUTADOR consume
   * `⌘⏎` siempre en la rejilla (ver `consumeSiempre` en el registro: en DataGrip, `⌘⏎` en el data
   * editor no ejecuta la consulta ni aunque no haya cambios).
   *
   * El efecto se ejecuta en CADA render a propósito (sin array de dependencias), como los
   * listeners de `app-shell.tsx`: los manejadores cierran sobre estado del render (filas marcadas,
   * `canEdit`, `offset`…), y volver a registrarlos es una asignación en un `WeakMap`. Con un array
   * de dependencias habría que enumerar media docena y cualquier olvido dejaría un manejador con
   * estado viejo: un bug silencioso.
   */
  const rejillaRef = React.useRef<HTMLDivElement>(null);
  /**
   * La última celda que ESTA rejilla publicó (la misma que va al store `focused-cell` para el panel
   * del valor). `F4` (#105) la necesita para saber qué fila referenciada abrir: leer el store
   * global valdría casi siempre, pero con dos rejillas montadas puede quedarse apuntando a la
   * celda de la OTRA si el foco cambió sin mover la selección.
   */
  const celdaDeEstaRejilla = React.useRef<CeldaEnfocada | null>(null);

  React.useEffect(() => {
    const contenedor = rejillaRef.current;
    if (!contenedor) return;
    return registrarManejadoresDeRejilla(contenedor, {
      // #96 Submit Changes (⌘⏎). `confirmChanges` ya sale en silencio sin contexto de tabla o sin
      // sesión, y avisa con «No hay cambios para guardar» cuando el conjunto está vacío.
      guardarCambios: () => {
        void confirmChanges();
        return true;
      },
      // #101 Add Row (⌘N). Sólo en rejillas editables: en un result set suelto (sin contexto de
      // tabla) no hay INSERT posible y la tecla no se consume.
      agregarFila: () => {
        if (!puedeAgregar) return false;
        addRow();
        return true;
      },
      // #101 Delete Row (⌘⌫, y alias ⌫/⌦ de la app). Como el manejador viejo: sin filas marcadas no
      // se hace nada (y ahora además la tecla NO se traga, que era el otro defecto del viejo).
      borrarSeleccionadas: () => {
        if (!puedeAgregar || Object.keys(rowSelection).length === 0) return false;
        deleteSelected();
        return true;
      },
      // Clone Row (⌘D de la app, contexto distinto del ⌘D del editor): filas marcadas → copias.
      duplicarSeleccionadas: () => {
        if (!puedeAgregar || Object.keys(rowSelection).length === 0) return false;
        duplicateSelected();
        return true;
      },
      // #103 Previous / Next Page. Las MISMAS precondiciones que los botones de la barra (que es
      // donde el usuario ve si la acción está disponible): sin paginación o en la primera página,
      // `⌘⌥↑` no se consume.
      paginaAnterior: () => {
        if (!onPrevPage || offset === 0) return false;
        void onPrevPage();
        return true;
      },
      paginaSiguiente: () => {
        if (!onNextPage || result.rowCount < result.effectiveLimit) return false;
        void onNextPage();
        return true;
      },
      // #105 Related Rows (F4): «Ir a la referenciada» de la celda enfocada, si es una FK. Es el
      // mismo camino que el ítem del menú contextual (`onNavigateFk`), no una segunda navegación.
      irALaReferenciada: () => {
        if (!onNavigateFk) return false;
        const celda = celdaDeEstaRejilla.current;
        if (!celda) return false;
        const real = columnaReal(celda.columna);
        const meta = tableContext?.columns.find((c) => c.name === real);
        if (!meta?.fk) return false;
        onNavigateFk(meta.fk.schema, meta.fk.table, meta.fk.column, celda.valor, tableContext?.table, real);
        return true;
      },
      // #18 Refresh (⌘R): re-ejecutar la consulta de ESTA rejilla. `onRefresh` es el prop que ya
      // usan el botón «Ejecutar» de la vista de tabla y el refresco del panel de resultados.
      refrescar: () => {
        if (!onRefresh) return false;
        void onRefresh();
        return true;
      },
    });
  });

  /**
   * Fase 14 (T7): la fila referenciada de la celda sobre la que se abrió el menú contextual, si la
   * columna es una clave foránea.
   *
   * Se calcula aquí —y no al abrir el menú— para que el valor salga del estado VIVO: la celda del
   * clic derecho puede haberse editado (cambio pendiente) mientras el menú estaba abierto. Es el
   * mismo criterio que usaba el clic derecho directo de la fase 13 (`meta.fk` + `fila[nombre]`).
   */
  const fkDelMenu = React.useMemo(() => {
    if (!menuContextual) return null;
    const real = columnaReal(menuContextual.columna);
    const meta = tableContext?.columns.find((c) => c.name === real);
    const fila = editedData[menuContextual.indice];
    if (!meta?.fk || !fila) return null;
    return { fk: meta.fk, valor: fila[menuContextual.columna], sourceColumn: real };
  }, [menuContextual, tableContext, editedData, columnaReal]);

  return (
    <div ref={rejillaRef} data-testid={TESTID_REJILLA} className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-gdb-sep bg-gdb-th px-3 py-1.5">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {/* Con filtro puesto, el contador dice cuántas de cuántas se ven: sin eso, «500 filas»
              cuando la rejilla enseña 3 es una contradicción a la vista. */}
          {/*
            Fase 70 (T4): el «N filas · X ms» vive en la BARRA FINA del panel de resultados, encima
            de esta barra. Aquí solo queda lo que esa barra no dice: el número de columnas y, cuando
            hay filtro, «n de N filas» — que es la señal de que la rejilla está recortando y por eso
            no puede faltar. Repetir filas y milisegundos en dos franjas pegadas era ruido.
            `filtrosAplicados`, no `filtros`: con la fila de filtros apagada el filtro no se aplica.
          */}
          {hayFiltro(filtrosAplicados ?? {}) && filasVisibles !== null && (
            <>
              <span className="font-medium text-foreground">
                {filasVisibles} de {editedData.length} filas
              </span>
              <span>·</span>
            </>
          )}
          <span>{result.columns.length} columnas</span>
          {/* Fase 11 (T2): el tope de filas se edita aquí, junto a la paginación, que es donde el
              usuario se entera de que el result set venía cortado. Es un ajuste de datos, no de
              apariencia, así que no cabía en el diálogo de Apariencia; y abrir un diálogo nuevo de
              Ajustes para un solo número era peor. */}
          <label className="flex items-center gap-1" title={`Filas máximas por consulta (${MIN_MAX_ROWS}–${MAX_ROWS_CEILING}). Se aplica a la siguiente consulta.`}>
            <span>máx.</span>
            <input
              // `key`: el campo es no controlado (para poder teclear sin commits por pulsación), así
              // que al cambiar el tope desde los presets hay que remontarlo o seguiría enseñando el
              // número viejo. No molesta al teclear porque el valor sólo se confirma al salir.
              key={maxRows}
              type="number"
              min={MIN_MAX_ROWS}
              max={MAX_ROWS_CEILING}
              step={100}
              defaultValue={maxRows}
              onBlur={(e) => setMaxRows(Number(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              className="h-5 w-[72px] rounded border border-input bg-input/30 px-1 text-right font-mono text-[10px] outline-none focus-visible:border-ring"
              aria-label="Filas máximas por consulta"
            />
          </label>
          {/* Fase 13 (T6, R55): el tope en un clic. El número de al lado sigue editable para
              cualquier valor intermedio. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  title="Topes rápidos de filas"
                  aria-label="Topes rápidos de filas"
                >
                  <IjIcon name="chevronDown" />
                </Button>
              }
            />
            <DropdownMenuContent align="start" className="min-w-44">
              {/* Los presets salen de `PRESETS_DE_FILAS`, el mismo módulo que el acotado: así un
                  preset no puede quedar por debajo del mínimo (fue el bug del «50» que daba 100). */}
              {PRESETS_DE_FILAS.map((tope) => (
                <DropdownMenuItem key={tope} onClick={() => setMaxRows(tope)} className="gap-2">
                  <span className="flex-1">
                    {tope === DEFAULT_MAX_ROWS
                      ? `Por defecto (${tope.toLocaleString("es-MX")} filas)`
                      : `${tope} filas`}
                  </span>
                  {maxRows === tope && <span className="text-[10px] text-muted-foreground">actual</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {result.limitApplied && (
            <>
              <Badge variant="outline" className="text-[10px]">
                LIMIT {result.effectiveLimit}
              </Badge>
              <span className="font-mono text-[10px]">
                filas {offset + 1}–{offset + result.rowCount}
              </span>
              {(onPrevPage || onNextPage) && (
                <div className="flex items-center gap-0.5">
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => onPrevPage?.()}
                    disabled={!onPrevPage || offset === 0}
                    title="Página anterior"
                  >
                    <IjIcon name="chevronLeft" />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => onNextPage?.()}
                    disabled={!onNextPage || result.rowCount < result.effectiveLimit}
                    title="Página siguiente"
                  >
                    <IjIcon name="chevronRight" />
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {puedeAgregar && (
            <>
              <Button size="xs" variant="outline" onClick={addRow} title="Agregar fila">
                <IjIcon name="add" />
                <span className="hidden sm:inline">Agregar</span>
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={duplicateSelected}
                disabled={selectedRowCount === 0}
                title="Duplicar selección"
              >
                <IjIcon name="copy" />
                <span className="hidden sm:inline">Duplicar</span>
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={deleteSelected}
                disabled={selectedRowCount === 0}
                title="Borrar selección"
              >
                <IjIcon name="remove" />
                <span className="hidden sm:inline">Borrar</span>
              </Button>
            </>
          )}
          {canEdit && (
            <>
              {/*
                R94: QUÉ se va a guardar, a la vista. Antes la única pista de un cambio pendiente era
                el tinte de la celda, y con una fila fuera de pantalla (o un tinte flojo) el usuario
                no sabía qué fila ni qué columna había cambiado. El rótulo cuenta los cambios y su
                tooltip los lista uno por uno (clave · columna: antes → después); «Guardar» solo se
                enciende cuando hay algo que guardar, como el «Submit» de DataGrip.
              */}
              {pendientes > 0 && (
                <span
                  data-testid="cambios-pendientes"
                  title={detallePendientes}
                  className="rounded border border-gdb-warn/60 bg-gdb-warnbg px-1.5 py-0.5 text-[10px] font-medium text-gdb-fgstrong"
                >
                  {pendientes === 1 ? "1 cambio sin guardar" : `${pendientes} cambios sin guardar`}
                </span>
              )}
              <Button
                size="xs"
                variant={pendientes > 0 ? "default" : "outline"}
                onClick={confirmChanges}
                disabled={saving || pendientes === 0}
                title={pendientes > 0 ? `Guardar en ${tableContext?.table} (⌘⏎)\n${detallePendientes}` : "No hay cambios que guardar"}
                data-testid="guardar-cambios"
              >
                <IjIcon name="push" />
                <span className="hidden sm:inline">Guardar</span>
              </Button>
              <Button size="xs" variant="outline" onClick={discardChanges} disabled={pendientes === 0}>
                <IjIcon name="revert" />
                <span className="hidden sm:inline">Descartar</span>
              </Button>
            </>
          )}
          {!canEdit && result.columns.length > 0 && (
            /* R94: un resultado que no se puede editar LO DICE, con el porqué en el tooltip. */
            <span
              data-testid="solo-lectura"
              title={motivoSoloLectura(columnKey(result.columns[0])) ?? undefined}
              className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"
            >
              Solo lectura
            </span>
          )}
          <Button
            size="xs"
            variant="outline"
            onClick={copySelectedRows}
            disabled={!haySeleccion}
            title={`Copiar la selección como ${ETIQUETA_DE_FORMATO[formatoDeCopia]}`}
          >
            <IjIcon name="copy" />
            <span className="hidden sm:inline">Copiar</span>
          </Button>
          {/*
            Fase 14 (T6, D2): el selector del «data extractor» activo, al lado de «Copiar» — donde
            DataGrip pone su desplegable de data extractors (el ⌘C de la rejilla copia en el formato
            que se elija aquí). Enseña el ACTIVO y persiste en `datadb-data-settings-v1`.
          */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  size="xs"
                  variant="outline"
                  title="Formato en el que copia ⌘C"
                  aria-label="Formato en el que copia ⌘C"
                >
                  <span className="font-mono text-[10px]">{ETIQUETA_DE_FORMATO[formatoDeCopia]}</span>
                  <IjIcon name="chevronDown" />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="min-w-44">
              {FORMATOS_DE_COPIA.map((formato) => (
                <DropdownMenuItem
                  key={formato}
                  onClick={() => setFormatoDeCopia(formato)}
                  className="gap-2"
                >
                  <span className="flex-1">{ETIQUETA_DE_FORMATO[formato]}</span>
                  {formatoDeCopia === formato && (
                    <span className="text-[10px] text-muted-foreground">activo</span>
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Fase 13 (R38): la fila de filtros local. El embudo va en la barra, como en DataGrip;
              dentro de la fila hay otro para limpiar todo de una vez. */}
          <Button
            size="xs"
            variant={filaDeFiltrosAbierta ? "secondary" : "outline"}
            onClick={() => setFilaDeFiltrosAbierta((abierta) => !abierta)}
            title="Filtrar el resultado por columna"
            aria-pressed={filaDeFiltrosAbierta}
          >
            <IjIcon name="filter" />
            <span className="hidden sm:inline">Filtrar</span>
          </Button>
          {hayFiltro(filtros) && (
            <Button size="xs" variant="outline" onClick={limpiarFiltros} title="Limpiar los filtros">
              <IjIcon name="close" />
              <span className="hidden sm:inline">Limpiar filtros</span>
            </Button>
          )}
          <ResultExporter
            key={tableContext ? `${tableContext.schema}.${tableContext.table}` : "no-context"}
            result={result}
            tableContext={tableContext}
          />
          {aiSettings?.enabled !== false && result.rows.length > 0 && (
            <Button size="xs" variant="outline" onClick={() => setAiDataOpen(true)}>
              <IjIcon name="ai" />
              <span className="hidden sm:inline">Datos con IA</span>
            </Button>
          )}
        </div>
      </div>

      <AiDataDialog
        open={aiDataOpen}
        onOpenChange={setAiDataOpen}
        result={result}
        tableContext={tableContext}
      />

        <div className="relative flex-1 overflow-hidden bg-gdb-editor">
          <DataGrid
            columnas={result.columns}
            /*
              R99-A: anchos persistidos de arriba. glide-data-grid NO cambia el ancho por su cuenta:
              en cada mousemove del borde de la cabecera llama a `onColumnResize` y espera que la app
              actualice el ancho; si este par no está conectado, el callback es vacío y el ancho
              vuelve a 150 px en el frame siguiente (el arrastre «no hace nada», el reporte).
            */
            anchos={anchos}
            onAnchoCambiado={cambiarAncho}
            // `editedData`, no `result.rows`: así se ven las filas nuevas y los valores ya
            // cambiados, igual que en el grid de siempre.
            filas={editedData}
            seleccion={seleccionCanvas}
            onSeleccion={setSeleccionCanvas}
            // Mismas reglas que la rejilla vieja: sin contexto de tabla no se edita, y la clave
            // primaria nunca (es lo que identifica la fila en el UPDATE).
            // R94: la regla es UNA (`motivoDeSoloLectura`): sin contexto no se edita, la clave
            // primaria nunca, y en un JOIN solo las columnas de la tabla editable.
            puedeEditar={(nombre) => canEdit && motivoSoloLectura(nombre) === null}
            motivoSoloLectura={motivoSoloLectura}
            onEditarCelda={(nombre, filaOriginal, valor) => {
              const fila = editedData[filaOriginal];
              if (fila) handleCellChange(fila, nombre, valor);
            }}
            // Puente con la barra de acciones: Agregar, Duplicar, Borrar y Copiar trabajan sobre
            // `rowSelection`, y es el canvas quien la alimenta.
            onFilasSeleccionadas={(indicesOriginales) => {
              const siguiente: Record<string, true> = {};
              for (const i of indicesOriginales) {
                const fila = editedData[i];
                if (fila) siguiente[getRowId(fila, i)] = true;
              }
              setRowSelection(siguiente);
            }}
            estadoDeFila={(i) => {
              const fila = editedData[i];
              if (!fila) return null;
              if (fila.__newId) return "nueva";
              if (pkKey && rowsToDelete.has(String(fila[pkKey]))) return "borrada";
              return null;
            }}
            celdaEditada={(nombre, i) => {
              const fila = editedData[i];
              if (!fila || !pkKey) return false;
              return editedCells.has(`${fila[pkKey]}::${nombre}`);
            }}
            esColumnaFk={
              onNavigateFk && tableContext
                ? (nombre) => Boolean(tableContext.columns.find((c) => c.name === columnaReal(nombre))?.fk)
                : undefined
            }
            onClickFk={
              onNavigateFk && tableContext
                ? (nombre, indiceOriginal) => {
                    const real = columnaReal(nombre);
                    const meta = tableContext.columns.find((c) => c.name === real);
                    const fila = editedData[indiceOriginal];
                    if (!meta?.fk || !fila) return;
                    onNavigateFk(meta.fk.schema, meta.fk.table, meta.fk.column, fila[nombre], tableContext.table, real);
                  }
                : undefined
            }
            /*
              Fase 12 (T1, D5): publicar la celda activa para el value editor del dock derecho.
              Se calcula aquí y no en la rejilla porque las reglas de «editable» son del contenedor
              (hay contexto de tabla, no es clave primaria) y porque el `confirmar` tiene que entrar
              por `handleCellChange`, que es la barra de cambios pendientes (D3).
            */
            onCeldaEnfocada={(celda) => {
              if (!celda) {
                celdaDeEstaRejilla.current = null;
                setCeldaEnfocada(null);
                return;
              }
              const meta = tableContext?.columns.find((c) => c.name === columnaReal(celda.columna));
              const editable = canEdit && motivoSoloLectura(celda.columna) === null;
              // El mismo objeto va al store global (para el panel del valor) y al ref de ESTA
              // rejilla (para el F4 del enrutador, fase 15 T5): el ref no se pisa entre instancias.
              const publicada: CeldaEnfocada = {
                columna: celda.columna,
                tipo: meta?.type ?? result.columns.find((c) => columnKey(c) === celda.columna)?.type ?? "",
                indiceOriginal: celda.indiceOriginal,
                valor: celda.valor,
                editable,
                confirmar: editable
                  ? (valor) => {
                      const fila = editedData[celda.indiceOriginal];
                      if (fila) handleCellChange(fila, celda.columna, valor);
                    }
                  : undefined,
              };
              celdaDeEstaRejilla.current = publicada;
              setCeldaEnfocada(publicada);
            }}
            onMenuContextual={(nombre, i, x, y) => {
              // Fase 14 (T7, D3): el clic derecho **ya no navega directo** a la fila referenciada.
              // Abre un menú con «Copiar», «Copiar como ▸» y —sólo si la columna es FK— «Ir a la
              // referenciada», que es lo que antes hacía el gesto por sí solo.
              //
              // La SELECCIÓN la mueve glide, no esta app: en su `onContextMenu` hace
              // `if (!gridSelectionHasItem(gridSelection, args.location)) updateSelectedCell(...)`
              // (`data-editor.js:2309-2311`) justo después de llamar a este callback, así que
              // cuando el usuario pulse un ítem del menú la selección ya es la celda del clic
              // (como en una hoja de cálculo). Medido en la sonda de T7.
              setMenuContextual({ x, y, columna: nombre, indice: i });
            }}
            /*
              Fase 14 (T6): el texto del ⌘C. La rejilla traduce la selección (con sus índices de
              orden/filtro) y aquí se formatea con el formato ACTIVO y el dialecto de la sesión.
            */
            textoParaCopiar={textoParaCopiar}
            /*
              Fase 14 (T6): los índices visibles, para que el botón «Copiar» y el menú contextual
              resuelvan la misma selección que el ⌘C sin depender de la rejilla.
            */
            onOrdenCambiado={setIndicesVisibles}
            // Fase 13: la fila de filtros sólo existe cuando está abierta (mismo `filtrosAplicados`
            // que decide el rótulo del contador), y las filas con cambios pendientes no se esconden
            // por filtrar (D4).
            filtros={filtrosAplicados}
            onCambiarFiltro={cambiarFiltro}
            onLimpiarFiltros={limpiarFiltros}
            siempreVisibles={indicesConCambios}
            onFilasVisibles={setFilasVisibles}
          />
        </div>

      {/*
        Fase 14 (T7, D3): el menú contextual del clic derecho.

        Es un `DropdownMenu` CONTROLADO cuya ancla es un elemento de 1×1 px puesto en las
        coordenadas del clic: `Menu.Positioner` de base-ui sabe anclarse a un `VirtualElement` o a un
        elemento real, pero el wrapper de `components/ui/dropdown-menu.tsx` sólo reenvía al
        Positioner `align/alignOffset/side/sideOffset` (el resto de props van al `Popup`), así que la
        vía que no obliga a tocar la capa de primitivos es un ancla real y diminuta. `bounds` de
        glide viene en coordenadas de VIEWPORT (`getBoundsForItem` suma el `getBoundingClientRect`
        del canvas), de ahí el `position: fixed`.

        Tres decisiones que conviene no re-descubrir:

        - **`modal={false}`**: un menú contextual no es un diálogo. Con el modo modal por defecto,
          base-ui bloquea el scroll de la página y las interacciones de fuera mientras está abierto.
        - **`Copiar` usa el formato ACTIVO; «Copiar como ▸» NO lo cambia** (D7): copia una vez en el
          formato elegido y el siguiente ⌘C sigue en el activo. Un menú que cambia un ajuste
          persistente sin decirlo es una sorpresa al siguiente ⌘C.
        - **Se escribe con `navigator.clipboard.writeText`**, no con `clipboardData`: aquí no hay
          evento `copy` (es un clic en un ítem), que es la única vía síncrona.
      */}
      <DropdownMenu
        open={menuContextual !== null}
        onOpenChange={(abierto) => {
          if (!abierto) setMenuContextual(null);
        }}
        modal={false}
      >
        <DropdownMenuTrigger
          // `nativeButton={false}`: el disparador de este menú NO es un botón, es el ancla de 1×1 px
          // donde se abrió el menú contextual. Sin esto, base-ui avisa por consola de que un
          // componente que se comporta como botón debería ser un `<button>` nativo.
          nativeButton={false}
          render={
            <span
              aria-hidden
              data-testid="ancla-menu-contextual"
              style={{
                position: "fixed",
                left: menuContextual?.x ?? 0,
                top: menuContextual?.y ?? 0,
                width: 1,
                height: 1,
                pointerEvents: "none",
              }}
            />
          }
        />
        <DropdownMenuContent align="start" side="bottom" sideOffset={2} className="min-w-52">
          <DropdownMenuItem
            className="gap-2"
            onClick={() => copiarSeleccion(formatoDeCopia)}
          >
            <IjIcon name="copy" />
            <span className="flex-1">Copiar</span>
            <DropdownMenuShortcut>{ETIQUETA_DE_FORMATO[formatoDeCopia]}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2">
              <span className="flex-1">Copiar como</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {FORMATOS_DE_COPIA.map((formato) => (
                <DropdownMenuItem
                  key={formato}
                  className="gap-2"
                  onClick={() => {
                    // D7: se copia UNA vez en este formato y el formato ACTIVO no se toca.
                    copiarSeleccion(formato);
                  }}
                >
                  <span className="flex-1">{ETIQUETA_DE_FORMATO[formato]}</span>
                  {formatoDeCopia === formato && (
                    <span className="text-[10px] text-muted-foreground">activo</span>
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {fkDelMenu && (
            <>
              <DropdownMenuSeparator />
              {/* Lo que hacía el clic derecho antes de esta fase (NR7): navegar a la fila
                  referenciada. Ahora es un ítem del menú, y sólo existe si la columna es FK. */}
              <DropdownMenuItem
                className="gap-2"
                onClick={() => {
                  onNavigateFk?.(
                    fkDelMenu.fk.schema,
                    fkDelMenu.fk.table,
                    fkDelMenu.fk.column,
                    fkDelMenu.valor,
                    tableContext?.table,
                    fkDelMenu.sourceColumn
                  );
                }}
              >
                <IjIcon name="foreignKey" />
                <span className="flex-1">Ir a la referenciada</span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
});
