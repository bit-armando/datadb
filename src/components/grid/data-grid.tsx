/**
 * El grid de datos sobre canvas (fase 11, T4) — `@glideapps/glide-data-grid`.
 *
 * Qué es y qué no, para que nadie se lleve una sorpresa:
 *
 * - **Es la capa de presentación del result set.** Pinta, ordena por una columna, deja redimensionar
 *   y seleccionar. La edición, la barra de cambios por lotes, la navegación por clave foránea y el
 *   resto de lo que hoy envuelve a la rejilla siguen en `results-grid.tsx` (tareas T5-T7).
 * - **No decide nada sobre los datos.** El texto de cada celda sale de `cell-model.ts`, que a su vez
 *   usa el mismo `cellText()` que el exportador y el editor; el orden, de `sorting.ts`. Esos dos son
 *   módulos puros con tests, y es a propósito: es la única parte del grid que se puede probar sin
 *   navegador.
 *
 * Tres requisitos de la librería que cuestan un rato descubrir (están medidos en
 * `.planning/research/spike-glide-data-grid.md`):
 *
 * 1. **`<div id="portal" />` tiene que ser el último hijo del `<body>`** o ningún editor abre: falla
 *    con «portal not found». Vive en `index.html`.
 * 2. **El canvas NO se estiliza con CSS.** El tema se construye en tiempo de ejecución leyendo los
 *    tokens `--gdb-*` y hay que RECONSTRUIRLO cuando el usuario cambia de tema o densidad. Pedir un
 *    token que no existe no da error: devuelve cadena vacía y el grid se queda en sus colores por
 *    defecto, lo que parece que no repinta.
 * 3. **`provideEditor` no recibe `[col, row]`**: la celda que se edita se lee de la selección.
 */
import * as React from "react";
// La hoja de estilos de la librería es OBLIGATORIA: sus clases son las que consumen las variables
// CSS que el propio componente inyecta (`--wmyidgi-1: 295px` → `height`). Sin ella el envoltorio se
// queda en alto 0, el canvas no se crea y el grid monta en silencio sin pintar nada — con el tema
// aplicado, que es lo que despista.
import "@glideapps/glide-data-grid/dist/index.css";
import {
  DataEditor,
  GridCellKind,
  type DataEditorRef,
  type DrawCellCallback,
  type DrawHeaderCallback,
  type GridCell,
  type GridColumn,
  type EditableGridCell,
  type GridSelection,
  type Item,
  type Theme,
} from "@glideapps/glide-data-grid";
import { EditableCell } from "@/components/editable-cell";
import { columnKey } from "@/lib/query-columns";
import type { QueryColumn } from "@/lib/types";
import { useThemeState, useThemeTokens } from "@/theme/theme-store";
import type { TokenKey } from "@/theme/tokens";
import { DENSITIES } from "@/theme/density";
import {
  booleanoParaGuardar,
  esColumnaBooleana,
  pintarCelda,
  tokenDeColorPorTipo,
  valorBooleano,
} from "./cell-model";
import { desdeGridSelection, extraerSeleccion, type ExtraccionDeSeleccion } from "./copy-as";
import { alturaDeFila, bordesVerticales, coloresDeTipo, filaAlternaDeRejilla, temaDeGrid, type TokenDelGrid } from "./grid-theme";
import { nivelDe, ordenarIndices, siguienteOrden, type Direccion, type OrdenDeGrid } from "./sorting";
import { filtrarIndices, parsearFiltros, type TextosDeFiltro } from "./filtering";
import { FilterRow, type FiltroRowHandle, type PosicionDeFiltro } from "./filter-row";

export interface DataGridProps {
  columnas: QueryColumn[];
  filas: Record<string, unknown>[];
  /** Selección actual, controlada desde fuera para que el contenedor pueda copiar, borrar, etc. */
  seleccion?: GridSelection;
  onSeleccion?: (s: GridSelection) => void;
  /**
   * Traduce la fila que se ve a la fila del array original. El grid ordena con índices (no mueve el
   * array) justo para que los cambios pendientes del contenedor no apunten a otra fila.
   */
  onOrdenCambiado?: (indicesVisibles: number[]) => void;
  /** Ancho de cada columna, persistido por el contenedor. */
  anchos?: Record<string, number>;
  onAnchoCambiado?: (columna: string, ancho: number) => void;
  /**
   * Edición de celda. El contenedor decide qué es editable (p. ej. la clave primaria no lo es, y
   * sin `tableContext` no se edita nada) y qué hacer con el valor confirmado; aquí solo se abre el
   * editor correcto y se entrega el valor.
   */
  puedeEditar?: (nombreDeColumna: string) => boolean;
  /**
   * R94: por qué una columna NO se puede editar (`null` si se puede). Con él, abrir una celda de
   * solo lectura enseña su valor y el motivo, en vez de un editor que acepta un valor y lo tira
   * (lo que reportó el usuario: «lo cambia pero no me deja confirmar»).
   */
  motivoSoloLectura?: (nombreDeColumna: string) => string | null;
  onEditarCelda?: (nombreDeColumna: string, filaOriginal: number, valor: unknown) => void;
  /**
   * Filas marcadas con el marcador de la izquierda. Se devuelven los índices del array ORIGINAL
   * (no los visibles), porque es contra ese array contra el que el contenedor guarda sus cambios.
   */
  onFilasSeleccionadas?: (indicesOriginales: number[]) => void;
  /** Estado de una fila en la edición por lotes, para teñirla como en el grid de siempre. */
  estadoDeFila?: (indiceOriginal: number) => "nueva" | "borrada" | null;
  /** Celda con un cambio pendiente: se tiñe para que se vea qué se va a guardar. */
  celdaEditada?: (nombreDeColumna: string, indiceOriginal: number) => boolean;
  /** Clic derecho sobre una celda (navegación por clave foránea, copiar…). */
  onMenuContextual?: (nombreDeColumna: string, indiceOriginal: number, x: number, y: number) => void;
  /**
   * Fase 12 (T1, D5): la celda ACTIVA, para que el value editor siga al cursor.
   *
   * No lo cubría ninguna de las salidas que ya tenía la rejilla: `onSeleccion` da el rango entero,
   * `onFilasSeleccionadas` las filas marcadas y `onEditarCelda` sólo habla cuando ya se confirmó
   * una edición. Faltaba justo «dónde está el cursor ahora», que es de lo único que vive un panel
   * que acompaña al foco.
   *
   * `null` cuando no hay celda activa (sólo filas o columnas marcadas, o nada).
   */
  onCeldaEnfocada?: (celda: { columna: string; indiceOriginal: number; valor: unknown } | null) => void;
  /**
   * Filtro local por columna (fase 13, T2; R38). Si viene, la rejilla enseña su fila de filtros y
   * filtra con ella; si no viene, no existe (la vista de tabla y los resultados de consola la
   * montan, pero la rejilla no la impone).
   *
   * El estado vive en el contenedor a propósito: la memoria por pestaña de resultado (T4) necesita
   * que sobreviva a los cambios de `result`, que es cuando el contenedor limpia sus cambios
   * pendientes.
   */
  filtros?: TextosDeFiltro;
  onCambiarFiltro?: (columna: string, valor: string) => void;
  onLimpiarFiltros?: () => void;
  /**
   * Filas (índices del array ORIGINAL) que se enseñan aunque no casen con el filtro.
   *
   * Decisión D4: una fila con cambios sin guardar no puede desaparecer por filtrar. Qué filas son
   * ésas lo sabe el contenedor (es quien tiene las ediciones pendientes), no la rejilla.
   */
  siempreVisibles?: ReadonlySet<number>;
  /**
   * Cuántas filas se están VIENDO después del filtro. La rejilla ya calcula esa lista para pintar;
   * publicarla evita que el contenedor repita el trabajo (100 000 filas son ~17 ms) sólo para
   * escribir «3 de 500 filas» en la barra.
   */
  onFilasVisibles?: (visibles: number) => void;
  /**
   * Fase 14 (T6, D2): **el texto que se copia** de una selección, en el formato activo.
   *
   * La rejilla NO conoce el dialecto SQL ni el nombre de la tabla (son del contenedor), así que
   * tampoco puede formatear: lo que hace es traducir la selección de glide a
   * `ExtraccionDeSeleccion` —columnas por nombre y filas por índice ORIGINAL, en orden visible— y
   * pedirle el texto a esta función. El contenedor la resuelve con `copiarComo` (`grid/copy-as.ts`)
   * y el formato que tenga activo.
   *
   * Devuelve `""` cuando no hay nada que copiar; en ese caso la rejilla no toca el portapapeles.
   */
  textoParaCopiar?: (extraccion: ExtraccionDeSeleccion) => string;
  /** Indica si la columna tiene una clave foránea navegable. */
  esColumnaFk?: (nombreDeColumna: string) => boolean;
  /** Se dispara al hacer clic sobre el indicador de flecha FK en una celda con valor no nulo. */
  onClickFk?: (nombreDeColumna: string, indiceOriginal: number) => void;
}

const ANCHO_POR_DEFECTO = 150;
const FK_ICON_HIT_WIDTH = 22;

function isInFkArrowHitZone(
  rectWidth: number,
  contentAlign: "left" | "right" | "center" | undefined,
  localX: number
): boolean {
  if (rectWidth < 36) return false;
  if (contentAlign === "right") return localX >= 0 && localX <= FK_ICON_HIT_WIDTH;
  return localX >= rectWidth - FK_ICON_HIT_WIDTH && localX <= rectWidth;
}

/*
 * ---- Indicador de orden de la cabecera (fase 14, T3) ----
 *
 * **Por qué hay que pintarlo aquí.** Glide NO dibuja indicadores de orden: en su fuente
 * (`data-grid-render.header.js`) no hay una sola referencia a *sort*, `overlayIcon` es un sprite
 * arbitrario y el `{ overlayIcon: undefined, hasMenu: false }` que la fase 11 puso en la columna
 * ordenada no cambia nada (los dos valores son los de por defecto). La línea base del spike T1 lo
 * midió: dos órdenes distintos de la misma columna daban **0 píxeles distintos** en su cabecera.
 * Así que el `▲`/`▼` sale de `dibujarCabecera`, que ya intercepta el pintado desde la fase 13 (la
 * fila de filtros le pidió desplazar el contenido).
 *
 * **Qué se pinta, y por qué así.** Como DataGrip, que enseña la flecha junto al nombre de la
 * columna y el **número de nivel a su derecha** («the number to the right of the marker (1 on the
 * picture) is the sorting level», *Sort data*, tables-sort.html): flecha rellena de 9×5 px y, solo
 * con **dos niveles o más**, el nivel en un cuerpo un 20 % menor. Con un nivel el número no
 * aparece — es el caso más común y no necesita explicación.
 *
 * **De qué color.** Un token del tema (`--gdb-fg`, el mismo que glide usa para el título de una
 * cabecera no seleccionada; ver `temaDeGrid`): tiene que leerse igual sobre las tres cabeceras que
 * puede haber debajo —la normal (`--gdb-th`), la de hover y la azul de columna seleccionada
 * (`--gdb-sel`)—, y el indicador NO puede depender del resalte de selección porque glide togglea
 * esa selección en CADA clic de cabecera (medido en T1): después del segundo clic la columna
 * ordenada puede quedarse sin resalte, y la flecha tiene que seguir viéndose.
 */
const ANCHO_FLECHA = 9;
const ALTO_FLECHA = 5;
/** Separación entre la flecha y el número de nivel. */
const HUECO_NIVEL = 3;
/** Aire entre el título recortado y el indicador: sin él, el último carácter toca la flecha. */
const HUECO_TITULO = 4;

/**
 * Fuente del número de nivel: la de la cabecera un 20 % más pequeña.
 *
 * Sale del `headerFontStyle` del tema (12 px en esta app) en vez de ser un tamaño fijo, para que
 * siga a la densidad y no haya que tocar dos sitios si algún día cambia el cuerpo base del grid.
 */
function fuenteDeNivel(fuenteCabecera: string): string {
  const coincidencia = /(\d+(?:\.\d+)?)px/.exec(fuenteCabecera);
  const tamano = coincidencia ? Number.parseFloat(coincidencia[1]) : 12;
  const familia = coincidencia
    ? fuenteCabecera.slice((coincidencia.index ?? 0) + coincidencia[0].length).trim()
    : "";
  return `600 ${Math.max(9, Math.round(tamano * 0.8))}px ${familia || "sans-serif"}`;
}

/**
 * Ancho que ocupa el indicador de una columna: la flecha y, si hay dos niveles o más, el hueco y el
 * número. Es lo que se le RESTA al contenido del título antes de recortarlo, así que se calcula en
 * un solo sitio y lo usan el recorte y el pintado (dos cuentas distintas acabarían separándose).
 */
function anchoDelIndicador(
  ctx: CanvasRenderingContext2D,
  nivel: { nivel: number; total: number },
  fuenteCabecera: string
): number {
  if (nivel.total < 2) return ANCHO_FLECHA;
  ctx.save();
  ctx.font = fuenteDeNivel(fuenteCabecera);
  const anchoNumero = ctx.measureText(String(nivel.nivel)).width;
  ctx.restore();
  return ANCHO_FLECHA + HUECO_NIVEL + anchoNumero;
}

/**
 * Pinta la flecha (y el número de nivel) de una columna ordenada, dentro de SU celda de cabecera.
 *
 * `rect` es el rectángulo de la celda en coordenadas del canvas (el que entrega `drawHeader` de
 * glide), así que el grupo se alinea al borde derecho menos el relleno horizontal del tema. Se
 * dibuja DESPUÉS del contenido (el título) y con la zona del indicador recortada antes de pintarlo
 * (ver `dibujarCabecera`): en una columna estrecha gana la flecha y el título se corta, que es la
 * prioridad que pide T3.
 *
 * La `y` del centro es la misma que usa glide para el texto de la cabecera (`rect.y + rect.height /
 * 2`), de modo que la flecha queda alineada con el título y —al estar dentro del desplazamiento de
 * la banda de filtros— sigue alineada también con la fila de filtros abierta.
 */
function pintarIndicadorDeOrden(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number },
  nivel: { nivel: number; direccion: Direccion; total: number },
  color: string,
  fuenteCabecera: string,
  xPad: number
): void {
  const centroY = rect.y + rect.height / 2;
  const bordeDerecho = rect.x + rect.width - xPad;
  const conNumero = nivel.total >= 2;

  ctx.save();
  ctx.fillStyle = color;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = conNumero ? fuenteDeNivel(fuenteCabecera) : fuenteCabecera;

  // Grupo alineado a la derecha: [▲][2]. El número va a la derecha del marcador (DataGrip).
  const separacion = conNumero ? HUECO_NIVEL : 0;
  const xFlecha = bordeDerecho - anchoDelIndicador(ctx, nivel, fuenteCabecera);

  ctx.beginPath();
  if (nivel.direccion === "asc") {
    ctx.moveTo(xFlecha, centroY + ALTO_FLECHA / 2);
    ctx.lineTo(xFlecha + ANCHO_FLECHA, centroY + ALTO_FLECHA / 2);
    ctx.lineTo(xFlecha + ANCHO_FLECHA / 2, centroY - ALTO_FLECHA / 2);
  } else {
    ctx.moveTo(xFlecha, centroY - ALTO_FLECHA / 2);
    ctx.lineTo(xFlecha + ANCHO_FLECHA, centroY - ALTO_FLECHA / 2);
    ctx.lineTo(xFlecha + ANCHO_FLECHA / 2, centroY + ALTO_FLECHA / 2);
  }
  ctx.closePath();
  ctx.fill();

  if (conNumero) {
    ctx.fillText(String(nivel.nivel), xFlecha + ANCHO_FLECHA + separacion, centroY);
  }
  ctx.restore();
}

/**
 * Mide el contenedor y devuelve píxeles.
 *
 * No es un adorno: a `DataEditor` hay que darle un tamaño NUMÉRICO. Con `width="100%"` /
 * `height="100%"` dentro de un contenedor flex, el envoltorio de glide se queda en `height: 0px`
 * —medido: host de 1068×295 y envoltorio de 1068×0— y **el canvas no llega a crearse**: el grid
 * monta, aplica su tema y no pinta nada, sin error en consola. Un porcentaje no resuelve contra un
 * padre cuya altura la decide `flex-1`.
 */
function useTamano(): [React.RefObject<HTMLDivElement | null>, { ancho: number; alto: number }] {
  const ref = React.useRef<HTMLDivElement>(null);
  const [tam, setTam] = React.useState({ ancho: 0, alto: 0 });
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const medir = () => {
      const r = el.getBoundingClientRect();
      setTam((prev) =>
        Math.round(r.width) === prev.ancho && Math.round(r.height) === prev.alto
          ? prev
          : { ancho: Math.round(r.width), alto: Math.round(r.height) }
      );
    };
    medir();
    const obs = new ResizeObserver(medir);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return [ref, tam];
}

export function DataGrid({
  columnas,
  filas,
  seleccion,
  onSeleccion,
  onOrdenCambiado,
  anchos,
  onAnchoCambiado,
  puedeEditar,
  motivoSoloLectura,
  onEditarCelda,
  onFilasSeleccionadas,
  estadoDeFila,
  celdaEditada,
  onMenuContextual,
  onCeldaEnfocada,
  filtros,
  onCambiarFiltro,
  onLimpiarFiltros,
  siempreVisibles,
  onFilasVisibles,
  textoParaCopiar,
  esColumnaFk,
  onClickFk,
}: DataGridProps) {
  const ref = React.useRef<DataEditorRef>(null);
  const [contenedorRef, tam] = useTamano();
  // Fase 14 (T2, D1): el orden es una lista de niveles; la lista vacía es «sin orden» (el tipo ya
  // no admite `null`). El ⌥+clic que apila niveles lo cablea T3 con el spike T1.
  const [orden, setOrden] = React.useState<OrdenDeGrid>([]);
  const filaDeFiltrosRef = React.useRef<FiltroRowHandle>(null);

  /**
   * Fase 14 (T3, D1): ¿el clic de cabecera que está en curso llevaba `⌥`?
   *
   * Hay que leerlo por FUERA del evento de glide porque sus args NO traen `altKey`:
   * `getMouseArgsForPosition` sólo copia `shiftKey`/`ctrlKey`/`metaKey` (data-grid.js:123-125) y los
   * args de cabecera (data-grid.js:174-207) tampoco lo incluyen. `⇧` y `⌘` ya los usa glide para
   * extender la selección de columnas (`columnSelect="multi"`), así que `⌥` es el único modificador
   * libre para «apilar» un nivel de orden — el gesto de DataGrip.
   *
   * La vía es un `pointerdown` en fase de CAPTURA sobre el contenedor de la rejilla: corre antes
   * que cualquier listener en burbuja y ve el `altKey` de verdad. Es la salida «viable» que midió el
   * spike T1: la cadena de glide es `pointerup` en burbuja sobre `window` (data-grid.js:662) →
   * `onMouseUp` → `data-editor.js:1360` (que es donde sale `onHeaderClicked`), así que el
   * `pointerdown` de la misma secuencia SIEMPRE llega antes (medido: press 0 px de cambio y release
   * 314 px en la columna `id`, y el `altKey` presente en los tres eventos de la secuencia).
   *
   * El ref se reescribe en cada `pointerdown` y no se limpia en el `pointerup`: el orden medido es
   * pointerdown → pointerup → click, y `onHeaderClicked` corre DURANTE el pointerup, así que
   * limpiarlo ahí llegaría tarde y se perdería el modificador.
   */
  const apilarRef = React.useRef(false);
  React.useEffect(() => {
    const contenedor = contenedorRef.current;
    if (!contenedor) return;
    const alPulsar = (evento: PointerEvent) => {
      apilarRef.current = evento.altKey;
    };
    contenedor.addEventListener("pointerdown", alPulsar, { capture: true });
    return () => contenedor.removeEventListener("pointerdown", alPulsar, { capture: true });
  }, [contenedorRef]);

  // Los colores se leen del STORE del tema, no con `getComputedStyle` sobre el documento.
  // Dos motivos: (1) así el tema del canvas se reconstruye cuando cambia el estado del tema —un
  // canvas no se repinta solo porque cambie una variable CSS, no hay CSS de por medio—, y la
  // dependencia del `useMemo` es real en vez de un comentario pidiendo que nadie la quite;
  // (2) `getComputedStyle` fuerza un reflujo, y esto se ejecuta en cada repintado del tema.
  const { tokens } = useThemeTokens();
  const { density: densidad, cuadricula, coloresPorTipo = true } = useThemeState();

  const leerToken = React.useCallback(
    (nombre: TokenDelGrid) => tokens[nombre.replace("--gdb-", "") as TokenKey] ?? "",
    [tokens]
  );

  // R98: colores por tipo de dato, ya ajustados al fondo de la celda.
  const porTipo = React.useMemo(() => coloresDeTipo(leerToken), [leerToken]);

  // R98: con la cuadrícula elegida en Apariencia (marcada por defecto).
  const tema = React.useMemo<Partial<Theme>>(
    () => temaDeGrid(leerToken, cuadricula) as Partial<Theme>,
    [leerToken, cuadricula]
  );
  const fondoAlterno = React.useMemo(() => filaAlternaDeRejilla(leerToken), [leerToken]);

  // La altura de fila la marca la densidad, igual que en el resto de la UI. Sale de la tabla de
  // métricas (la misma que genera `--gdb-row`), no del documento: así la dependencia es el valor
  // de verdad y no hay que leer el DOM en cada cambio de tema.
  const altoFila = React.useMemo(() => alturaDeFila(`${DENSITIES[densidad].row}px`), [densidad]);

  /**
   * Fase 13 (T2). La fila de filtros no se SUPERPONE a los datos: se reserva una banda dentro de la
   * cabecera del canvas (`headerHeight` crece una fila) y el texto de la columna se dibuja en la
   * mitad de arriba. Es la única forma de que los inputs queden «bajo las cabeceras» (lo pedido en
   * D1) sin tapar la primera fila, que es lo que pasaría con un div encima del canvas.
   */
  const filaDeFiltros = filtros !== undefined;
  const altoCabecera = Math.max(altoFila, 24);
  const bandaDeFiltros = filaDeFiltros ? altoFila : 0;
  const condiciones = React.useMemo(() => parsearFiltros(filtros ?? {}), [filtros]);

  // Declarado aquí (antes de `medirColumnas`, que necesita los anchos) y no junto a `getCellContent`.
  //
  // Ya NO lleva nada de orden: la fase 11 ponía `{ overlayIcon: undefined, hasMenu: false }` en la
  // columna ordenada creyendo que eso pintaba la flecha, y era inerte — los dos valores son los de
  // por defecto de glide (el indicador de orden de verdad lo pinta `dibujarCabecera`, T3). Al
  // quitarlo, la lista de columnas deja de depender de `orden`: el grid ya no se re-renderiza por
  // reconstruir un array idéntico en cada cambio de orden.
  const columnasDelGrid = React.useMemo<GridColumn[]>(
    () =>
      columnas.map((c) => {
        const clave = columnKey(c);
        return {
          id: clave,
          title: c.name,
          width: anchos?.[clave] ?? ANCHO_POR_DEFECTO,
        };
      }),
    [columnas, anchos]
  );

  /**
   * Mide dónde va el input de cada columna visible, en píxeles relativos al contenedor.
   *
   * NO se usa `getBounds(col, -1)` de cada columna, aunque sería lo natural, por un detalle medido de
   * glide: en `onVisibleRegionChanged` hace `setVisibleRegion(nuevaRegion)` y llama a nuestro
   * callback EN LA MISMA PASADA (data-editor.js), antes de re-renderizar; `getBounds` todavía usa el
   * desplazamiento viejo. Con scroll horizontal la fila de filtros se quedaba un paso atrás (13 y
   * 18 px de desvío medidos contra las separadoras pintadas) y, si no había otro evento, se quedaba
   * así.
   *
   * Así que se repite la cuenta de `computeBounds` de glide con los valores FRESCOS del evento:
   * `x = ancho del marcador + tx + Σ anchos desde la primera columna visible`. Del `getBounds` sólo se
   * usa la columna del marcador (`getBounds(-1, -1)`), que es fija y no depende del scroll.
   *
   * Una columna medio tapada por el marcador se recorta en su borde izquierdo: si no, su input se
   * pintaría encima del canal de números y del embudo de «Limpiar filtros».
   */
  const regionRef = React.useRef<{ x: number; tx: number }>({ x: 0, tx: 0 });
  const medirColumnas = React.useCallback((): PosicionDeFiltro[] => {
    const contenedor = contenedorRef.current;
    const grilla = ref.current;
    if (!contenedor || !grilla) return [];
    const marcador = grilla.getBounds(-1, -1);
    if (!marcador) return [];
    const rc = contenedor.getBoundingClientRect();
    // `computeBounds` suma 1 px de borde al ancho de cada columna; el ancho real es uno menos.
    const finDelMarcador = marcador.x - rc.x + marcador.width - 1;
    const { x: primera, tx } = regionRef.current;
    const posiciones: PosicionDeFiltro[] = [];
    let x = finDelMarcador + tx;
    for (let i = Math.max(0, primera); i < columnasDelGrid.length; i++) {
      const ancho = (columnasDelGrid[i] as { width?: number }).width ?? ANCHO_POR_DEFECTO;
      if (x >= rc.width) break;
      const izquierda = Math.max(x, finDelMarcador);
      const visible = x + ancho - izquierda;
      if (visible > 0) {
        posiciones.push({
          columna: columnKey(columnas[i]),
          etiqueta: columnas[i].name,
          izquierda,
          ancho: visible,
        });
      }
      x += ancho;
    }
    return posiciones;
  }, [columnas, columnasDelGrid, contenedorRef]);

  /**
   * Dibuja la cabecera: el contenido de glide —desplazado, si hay fila de filtros (fase 13)— y el
   * INDICADOR de orden encima (fase 14, T3).
   *
   * Se llama al contenido por defecto (`dibujarContenido`) con el contexto movido
   * -bandaDeFiltros/2, que es exactamente lo que lo recentra en la mitad de arriba, y no se repinta
   * el texto a mano a propósito: así se conservan la tipografía y el color según el estado (columna
   * seleccionada, con foco). Lo que glide NO pinta por su cuenta es la flecha de orden —en su fuente
   * (`data-grid-render.header.js`) no hay una sola referencia a *sort*—, y eso es lo que se añade
   * aquí: la flecha ▲/▼ y, con dos niveles o más, el número de nivel.
   *
   * El indicador se dibuja DENTRO del mismo desplazamiento, no fuera: su `y` es el centro de la
   * celda de cabecera (`rect` incluye la banda de filtros), así que al compartir el `translate` cae
   * siempre sobre la línea del título, con la fila de filtros abierta o cerrada.
   *
   * Antes de pintar el contenido se RECORTA su ancho a lo que deja libre el indicador: en una
   * columna ancha no se nota (el título nunca llega tan lejos), pero en una estrecha gana la flecha
   * y el título se corta, que es la prioridad que pide T3. El corte es del contenido, no del fondo:
   * el fondo y el borde de la celda los pinta glide por fuera de este callback.
   *
   * El canal de números de fila (`columnIndex < 0`) se dibuja como siempre: esa banda la ocupa el
   * embudo de «Limpiar filtros», fuera del canvas, y ahí no hay orden que indicar.
   */
  const dibujarCabecera = React.useCallback(
    (args: Parameters<DrawHeaderCallback>[0], dibujarContenido: () => void) => {
      // `columnIndex` es el `sourceIndex` de la columna: -1 en el canal de números de fila.
      const nivel = args.columnIndex >= 0 ? nivelDe(orden, String(args.column.id)) : null;
      // El tema que llega ya está «realizado» (trae `headerFontFull`, que el tipo `Theme` no declara:
      // quien lo añade es `mergeAndRealizeTheme` dentro de glide), así que se lee con un fallback.
      const tema = args.theme as typeof args.theme & { headerFontFull?: string };
      const fuenteCabecera =
        tema.headerFontFull ?? `${args.theme.headerFontStyle} ${args.theme.fontFamily}`;
      const ctx = args.ctx;

      if (args.columnIndex >= 0 && bandaDeFiltros > 0) {
        ctx.save();
        ctx.translate(0, -bandaDeFiltros / 2);
      }

      if (nivel !== null) {
        const recorte = Math.max(
          0,
          args.rect.width - anchoDelIndicador(ctx, nivel, fuenteCabecera) - HUECO_TITULO
        );
        ctx.save();
        ctx.beginPath();
        ctx.rect(args.rect.x, args.rect.y, recorte, args.rect.height);
        ctx.clip();
        dibujarContenido();
        ctx.restore();
        pintarIndicadorDeOrden(
          ctx,
          args.rect,
          nivel,
          leerToken("--gdb-fg"),
          fuenteCabecera,
          args.theme.cellHorizontalPadding
        );
      } else {
        dibujarContenido();
      }

      if (args.columnIndex >= 0 && bandaDeFiltros > 0) ctx.restore();
    },
    [bandaDeFiltros, orden, leerToken]
  );

  // Al cambiar el tamaño del contenedor, las columnas o sus anchos, las x de la fila de filtros
  // dejan de valer.
  React.useEffect(() => {
    filaDeFiltrosRef.current?.sincronizar();
  }, [tam.ancho, columnas, anchos, filaDeFiltros]);

  const indices = React.useMemo(
    () =>
      // Filtro ANTES del orden, y no al revés: ordenar 100 000 filas para tirar la mayoría después
      // es trabajo tirado, y el orden sólo tiene que decidir el orden de lo que se ve (por eso
      // `ordenarIndices` acepta la lista de candidatos).
      ordenarIndices(filas, orden, filtrarIndices(filas, condiciones, siempreVisibles)),
    [filas, orden, condiciones, siempreVisibles]
  );

  React.useEffect(() => {
    onOrdenCambiado?.(indices);
    onFilasVisibles?.(indices.length);
  }, [indices, onOrdenCambiado, onFilasVisibles]);

  /**
   * Fase 14 (T6, D2): el ⌘C de la rejilla, con formato activo y valores CRUDOS.
   *
   * Glide trae su propio copiado (`keybindings.copy`, `data-editor/copy-paste.js`), pero copia el
   * texto **pintado**: un NULL llega al portapapeles como el literal `[NULL]` y un valor de más de
   * 4 096 caracteres llega recortado con «…» (el recorte es de PINTURA, `cell-model.ts`, y se estaba
   * colando al portapapeles). Por eso aquí se apaga y el evento `copy` lo maneja la app: se lee el
   * valor crudo del array original, por índice, y se formatea con el formato activo — el
   * contenedor decide cuál (la rejilla no conoce el dialecto ni el nombre de la tabla).
   *
   * Tres cosas se copian de glide a propósito, medidas en su fuente:
   *
   * 1. **Escucha en `window` y en fase de burbuja** (`useEventListener("copy", onCopy, safeWindow,
   *    false, false)`, `data-editor.js:2573`). Es lo que hace que ⌘C y el menú nativo Edición →
   *    Copiar (rol `copy` del menú de Electron) lleguen al MISMO sitio: los dos disparan el evento
   *    `copy` del elemento con foco, y éste burbujea hasta la ventana.
   * 2. **Sólo actúa si el foco está en la rejilla**: `scrollRef.contains(activeElement) ||
   *    canvasRef.contains(activeElement)` (`data-editor.js:2489-2490`). Es imprescindible y no un
   *    detalle: la fila de filtros vive DENTRO del mismo contenedor (`FilterRow` es hermano del
   *    `DataEditor`), así que mirar el contenedor haría que ⌘C con el foco en un input copiara la
   *    rejilla en vez del texto del input.
   * 3. **`preventDefault()` + `clipboardData.setData`**: es la única forma de escribir el
   *    portapapeles desde un evento `copy` sin promesas por medio (`copyToClipboard` de glide hace
   *    exactamente esto).
   *
   * La selección y los índices se leen de un ref que se refresca tras cada render: el listener se
   * registra UNA vez (no en cada cambio de orden, de filtro o de selección) y aun así ve el estado
   * fresco. Es el mismo truco que usa el propio `useEventListener` de glide.
   */
  const copiaRef = React.useRef({ seleccion, indices, columnas, textoParaCopiar });
  // El ref se refresca en un EFECTO, no durante el render: escribir un ref mientras se renderiza es
  // lo que la regla `react-hooks/refs` de este repo prohíbe (y con razón — el render puede
  // descartarse). El efecto corre tras cada render y antes de que llegue cualquier evento de
  // usuario, así que el listener siempre ve el estado de la última pasada.
  React.useEffect(() => {
    copiaRef.current = { seleccion, indices, columnas, textoParaCopiar };
  });

  React.useEffect(() => {
    const contenedor = contenedorRef.current;
    if (!contenedor) return;
    const alCopiar = (evento: ClipboardEvent) => {
      const {
        seleccion: sel,
        indices: visibles,
        columnas: cols,
        textoParaCopiar: formatear,
      } = copiaRef.current;
      if (!formatear) return;
      // Se buscan en el momento del evento y no al registrar: con `tam` a 0 el canvas todavía no
      // existe (ver el montaje condicional del `DataEditor`).
      const activo = document.activeElement;
      const scroller = contenedor.querySelector(".dvn-scroller");
      const canvas = contenedor.querySelector("canvas");
      const enLaRejilla =
        (scroller !== null && scroller.contains(activo)) ||
        (canvas !== null && canvas.contains(activo));
      if (!enLaRejilla) return;
      // Sin selección no se toca nada: el copiado nativo sigue su curso (un input, un texto
      // seleccionado a mano en otra parte del panel).
      const datos = desdeGridSelection(sel);
      if (!datos) return;
      const texto = formatear(extraerSeleccion(datos, visibles, cols));
      if (texto === "") return;
      evento.preventDefault();
      evento.clipboardData?.setData("text/plain", texto);
    };
    window.addEventListener("copy", alCopiar);
    return () => window.removeEventListener("copy", alCopiar);
  }, [contenedorRef]);

  const getCellContent = React.useCallback(
    ([col, fila]: Item): GridCell => {
      const columna = columnas[col];
      const clave = columna ? columnKey(columna) : undefined;
      const filaReal = filas[indices[fila] ?? fila];
      const valor = clave !== undefined ? filaReal?.[clave] : undefined;
      const tipo = columna?.type ?? "";
      const pintada = pintarCelda(valor, tipo);
      const filaOriginal = indices[fila] ?? fila;
      const editada = clave !== undefined ? celdaEditada?.(clave, filaOriginal) : false;
      const soloLectura = !(clave !== undefined && puedeEditar?.(clave));
      /*
        R98: booleanos como CASILLA, como DataGrip. Se marca/desmarca con un clic sobre la casilla
        (lo hace glide y avisa en `onCellEdited`, abajo). NULL —o un valor que no es 0/1— sigue siendo
        texto: «[NULL]» atenuado, y su editor de siempre (true/false/NULL) con doble clic.
        La casilla marcada va en el acento del tema; `hoverEffectIntensity: 0` la deja a opacidad
        completa (glide la atenúa al 40 % si es de solo lectura, y se confundía con «desmarcada»).
      */
      const booleano = esColumnaBooleana(tipo) ? valorBooleano(valor) : null;
      if (booleano !== null) {
        return {
          kind: GridCellKind.Boolean,
          data: booleano,
          allowOverlay: false,
          // `readonly: true` evita que glide use su hitbox interno oculto de checkbox;
          // el clic en cualquier parte de la celda/pill y Enter/Space alternan el valor abajo.
          readonly: true,
          hoverEffectIntensity: 0,
          contentAlign: "left",
          copyData: booleano ? "true" : "false",
          themeOverride: {
            accentColor: leerToken("--gdb-accent"),
            textMedium: booleano ? leerToken("--gdb-accent") : leerToken("--gdb-fgdim"),
            ...(editada ? { bgCell: leerToken("--gdb-diffmod") } : {}),
          },
        };
      }
      const colorDeTipo = coloresPorTipo ? tokenDeColorPorTipo(tipo) : null;
      // El tinte de la celda editada gana al atenuado del NULL: lo que importa ver es que ESA celda
      // tiene un cambio sin guardar.
      const themeOverride = editada
        ? { bgCell: leerToken("--gdb-diffmod"), textDark: leerToken("--gdb-fg") }
        : pintada.esNulo
          ? { textDark: leerToken("--gdb-muted") }
          : colorDeTipo
            ? { textDark: porTipo[colorDeTipo] }
            : undefined;
      return {
        kind: GridCellKind.Text,
        data: pintada.texto,
        displayData: pintada.texto,
        allowOverlay: true,
        readonly: soloLectura,
        contentAlign: pintada.alineacion === "derecha" ? "right" : "left",
        themeOverride,
      };
    },
    [columnas, filas, indices, leerToken, puedeEditar, celdaEditada, coloresPorTipo, porTipo]
  );

  const dibujarCelda = React.useCallback<DrawCellCallback>(
    (args, drawContent) => {
      if (args.cell.kind === GridCellKind.Boolean) {
        const val = Boolean(args.cell.data);
        const { ctx, rect, theme } = args;
        const label = val ? "true" : "false";
        const bg = leerToken(val ? "--gdb-okbg" : "--gdb-dangerbg");
        const fg = leerToken(val ? "--gdb-okfg" : "--gdb-dangerfg");
        ctx.save();
        ctx.font = '600 11px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
        const textW = ctx.measureText(label).width;
        const pillW = Math.ceil(textW) + 12;
        const pillH = Math.min(18, Math.max(14, rect.height - 6));
        const px = rect.x + theme.cellHorizontalPadding;
        const py = rect.y + (rect.height - pillH) / 2;
        ctx.beginPath();
        ctx.roundRect(px, py, pillW, pillH, 3);
        ctx.fillStyle = bg;
        ctx.fill();
        ctx.fillStyle = fg;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(label, px + 6, rect.y + rect.height / 2 + 0.5);
        ctx.restore();
        return;
      }
      drawContent();
      if (!esColumnaFk) return;
      const columna = columnas[args.col];
      if (!columna) return;
      const clave = columnKey(columna);
      if (!esColumnaFk(clave)) return;
      const filaOriginal = indices[args.row] ?? args.row;
      const valor = filas[filaOriginal]?.[clave];
      if (valor === null || valor === undefined) return;
      if (args.rect.width < 36) return;

      const onLeft = args.cell.contentAlign === "right";
      const cx = onLeft ? args.rect.x + 12 : args.rect.x + args.rect.width - 12;
      const cy = args.rect.y + args.rect.height / 2;
      const hovered =
        args.hoverX !== undefined &&
        isInFkArrowHitZone(args.rect.width, args.cell.contentAlign, args.hoverX);
      const accent = leerToken("--gdb-accent");

      const { ctx } = args;
      ctx.save();
      // Pill badge behind the arrow so FK cells are immediately recognizable as clickable links
      const badgeW = 18;
      const badgeH = Math.min(18, Math.max(14, args.rect.height - 6));
      const bx = cx - badgeW / 2;
      const by = cy - badgeH / 2;
      ctx.beginPath();
      ctx.roundRect(bx, by, badgeW, badgeH, 4);
      ctx.globalAlpha = hovered ? 0.28 : 0.14;
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.globalAlpha = hovered ? 0.85 : 0.4;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.globalAlpha = hovered ? 1 : 0.9;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.6;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      // Diagonal arrow ↗ inside the badge
      ctx.moveTo(cx - 3.5, cy + 3.5);
      ctx.lineTo(cx + 3.5, cy - 3.5);
      ctx.moveTo(cx - 0.5, cy - 3.5);
      ctx.lineTo(cx + 3.5, cy - 3.5);
      ctx.lineTo(cx + 3.5, cy + 0.5);
      ctx.stroke();
      ctx.restore();
    },
    [esColumnaFk, columnas, indices, filas, leerToken]
  );

  return (
    <div
      ref={contenedorRef}
      className="relative h-full w-full"
      data-testid="data-grid"
      /*
       * Fase 14 (T3): el orden, publicado en el DOM como `ciudad:asc,id:desc` (vacío si no hay
       * orden, y en orden de PRECEDENCIA de los niveles).
       *
       * Es la misma idea que `focused-cell.ts` publicando la celda enfocada: el indicador se pinta en
       * un CANVAS, y del canvas no se puede leer texto. Sin este atributo, medir «¿qué orden tiene la
       * rejilla?» exigiría leer píxeles o el valor de la fila 0, y las dos cosas son indirectas y
       * frágiles. Con él, una sonda (o un test humano mirando el inspector) ve el estado real, y
       * además sirve de señal de «el orden ya se aplicó» para cronometrar el pintado.
       */
      data-orden={orden.map((n) => `${n.columna}:${n.direccion}`).join(",")}
    >
      {/* Con 0 píxeles no se monta: glide con tamaño 0 deja el canvas sin crear y luego no se
          recupera solo. */}
      {tam.ancho > 0 && tam.alto > 0 && (
      <DataEditor
        ref={ref}
        theme={tema}
        verticalBorder={bordesVerticales(cuadricula)}
        columns={columnasDelGrid}
        rows={filas.length}
        rowHeight={altoFila}
        /*
          Fase 13 (T2): la cabecera crece una fila para que la fila de filtros viva DENTRO de ella
          (su banda, la de abajo) y no encima de los datos. El texto de la columna se recentra en la
          banda de arriba con `drawHeader`.
        */
        headerHeight={altoCabecera + bandaDeFiltros}
        drawHeader={dibujarCabecera}
        onVisibleRegionChanged={(region, tx) => {
          // El scroll horizontal mueve cada columna: la fila de filtros tiene que seguirla. Se
          // guarda la región FRESCA (ver `medirColumnas`: `getBounds` va un render atrasado aquí) y
          // se avisa por handle imperativo, para no volver a renderizar la rejilla en cada frame.
          regionRef.current = { x: region.x, tx };
          filaDeFiltrosRef.current?.sincronizar();
        }}
        getCellContent={getCellContent}
        drawCell={dibujarCelda}
        onCellClicked={(celda, evento) => {
          const [col, fila] = celda;
          const columna = columnas[col];
          if (!columna) return;
          const clave = columnKey(columna);
          const filaOriginal = indices[fila] ?? fila;
          const valor = filas[filaOriginal]?.[clave];
          const tipo = columna.type ?? "";

          if (onClickFk && esColumnaFk?.(clave) && valor !== null && valor !== undefined) {
            const pintada = pintarCelda(valor, tipo);
            const align = pintada.alineacion === "derecha" ? "right" : "left";
            if (isInFkArrowHitZone(evento.bounds.width, align, evento.localEventX)) {
              onClickFk(clave, filaOriginal);
              return;
            }
          }

          if (esColumnaBooleana(tipo) && puedeEditar?.(clave)) {
            const actual = valorBooleano(valor);
            if (actual !== null) {
              onEditarCelda?.(clave, filaOriginal, booleanoParaGuardar(valor, !actual));
            }
          }
        }}
        onCellActivated={([col, fila]) => {
          const columna = columnas[col];
          if (!columna) return;
          const clave = columnKey(columna);
          if (!puedeEditar?.(clave)) return;
          if (!esColumnaBooleana(columna.type ?? "")) return;
          const filaOriginal = indices[fila] ?? fila;
          const valor = filas[filaOriginal]?.[clave];
          const actual = valorBooleano(valor);
          if (actual !== null) {
            onEditarCelda?.(clave, filaOriginal, booleanoParaGuardar(valor, !actual));
          }
        }}
        // `clickable-number`, no `number`: con el segundo el número de fila es decorativo y
        // pinchar en él no selecciona la fila — y de esa selección viven Duplicar, Borrar y
        // Copiar. En el grid DOM el número ya era pulsable, así que esto conserva el gesto.
        rowMarkers="clickable-number"
        smoothScrollX
        smoothScrollY
        width={tam.ancho}
        height={
          filas.length > 0
            ? Math.min(tam.alto, altoCabecera + bandaDeFiltros + filas.length * altoFila + 16)
            : tam.alto
        }
        // Selección tipo hoja de cálculo (R36): rango con ratón y teclado, columnas y filas.
        /*
          Tinte de fila para la edición por lotes: verde las nuevas, rojo las marcadas para borrar.
          Es lo mismo que hacía el grid DOM con `bg-gdb-okfg/15` y `bg-gdb-fail/15`, pero en canvas
          hay que darlo como colores, no como clases.
        */
        getRowThemeOverride={(fila) => {
          const estado = estadoDeFila?.(indices[fila] ?? fila);
          if (estado === "nueva") return { bgCell: leerToken("--gdb-okbg"), bgCellMedium: leerToken("--gdb-okbg") };
          if (estado === "borrada") return { bgCell: leerToken("--gdb-dangerbg"), bgCellMedium: leerToken("--gdb-dangerbg"), textDark: leerToken("--gdb-muted") };
          if (fila % 2 === 1) return { bgCell: fondoAlterno };
          return undefined;
        }}
        onCellContextMenu={(celda, evento) => {
          const [col, fila] = celda;
          const columna = columnas[col];
          if (!columna) return;
          evento.preventDefault();
          onMenuContextual?.(columnKey(columna), indices[fila] ?? fila, evento.bounds.x, evento.bounds.y);
        }}
        gridSelection={seleccion}
        onGridSelectionChange={(s) => {
          // Las filas marcadas con el marcador de la izquierda se devuelven en índices del array
          // ORIGINAL: el contenedor guarda sus cambios contra ese array, no contra el orden visible.
          if (onFilasSeleccionadas) {
            const visibles: number[] = [];
            for (const r of s?.rows ?? []) visibles.push(r as number);
            onFilasSeleccionadas(visibles.map((v) => indices[v] ?? v));
          }
          // Fase 12 (T1): publicar la celda activa. Se avisa también cuando deja de haberla, para
          // que el panel pueda vaciarse en vez de quedarse enseñando un valor que ya no está
          // seleccionado.
          if (onCeldaEnfocada) {
            const celda = s?.current?.cell;
            if (!celda) {
              onCeldaEnfocada(null);
            } else {
              const [col, filaVisible] = celda;
              const columna = columnas[col];
              const indiceOriginal = indices[filaVisible] ?? filaVisible;
              const clave = columna ? columnKey(columna) : undefined;
              onCeldaEnfocada(
                clave !== undefined
                  ? { columna: clave, indiceOriginal, valor: filas[indiceOriginal]?.[clave] }
                  : null
              );
            }
          }
          onSeleccion?.(s);
        }}
        rangeSelect="multi-rect"
        columnSelect="multi"
        rowSelect="multi"
        getCellsForSelection={true}
        /*
          Fase 14 (T6, D2): `copy: false` — el ⌘C lo maneja la app (ver el efecto de arriba), porque
          el de glide copia el texto PINTADO (`[NULL]`, recorte a 4 096 con «…») y no sabe de
          formatos. `selectAll` se queda: ⌘A es de glide.
        */
        keybindings={{ copy: false, selectAll: true }}
        maxColumnWidth={2400}
        maxColumnAutoWidth={1200}
        onColumnResize={(columna, nuevoAncho) => {
          if (!columna.id) return;
          onAnchoCambiado?.(columna.id, nuevoAncho);
        }}
        /*
          Los editores por tipo que ya tiene la app (`editable-cell.tsx`), dentro del overlay de
          glide. Dos cosas que hay que saber:
          - `provideEditor` NO recibe `[col, row]`: la celda que se edita se lee de la selección.
          - El overlay necesita `<div id="portal">` como último hijo del body (está en index.html).
        */
        provideEditor={(celda) => {
          if (celda.kind !== GridCellKind.Text) return undefined;
          return (props) => {
            const col = seleccion?.current?.cell?.[0] ?? 0;
            const filaVisible = seleccion?.current?.cell?.[1] ?? 0;
            const columna = columnas[col];
            const filaOriginal = indices[filaVisible] ?? filaVisible;
            if (!columna) return <div />;
            const clave = columnKey(columna);
            const valorCrudo = filas[filaOriginal]?.[clave];
            /*
              R94: celda de solo lectura. glide abre el overlay igual (la celda lleva
              `allowOverlay`, que es lo que deja VER un valor largo entero), pero aquí NO se monta el
              editor: antes se montaba, aceptaba el cambio y el contenedor lo descartaba sin avisar.
              Se enseña el valor seleccionable (para copiarlo) y el motivo; ⎋ o un clic fuera cierran.
            */
            if (!puedeEditar?.(clave)) {
              const motivo = motivoSoloLectura?.(clave) ?? "Solo lectura.";
              return (
                <div
                  className="min-w-[260px] max-w-[480px] bg-gdb-field p-1.5"
                  data-testid="celda-solo-lectura"
                  onKeyDown={(e) => {
                    if (e.key === "Escape" || e.key === "Enter") {
                      e.preventDefault();
                      props.onFinishedEditing(undefined);
                    }
                  }}
                >
                  <div className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground select-text">
                    {celda.kind === GridCellKind.Text ? celda.data : ""}
                  </div>
                  <div className="mt-1 border-t border-border pt-1 text-[10px] text-muted-foreground">
                    {motivo}
                  </div>
                </div>
              );
            }
            return (
              <div className="min-w-[260px] bg-gdb-field p-1" data-testid="editor-de-celda">
                <EditableCell
                  enLinea
                  value={valorCrudo}
                  columnType={columna.type}
                  onCommit={(nuevo) => {
                    onEditarCelda?.(clave, filaOriginal, nuevo);
                    // glide necesita una celda del mismo `kind` para cerrar el overlay.
                    const texto = nuevo === null || nuevo === undefined ? "" : String(nuevo);
                    props.onFinishedEditing({
                      ...(props.value as GridCell & { kind: GridCellKind.Text }),
                      data: texto,
                      displayData: texto,
                    } as EditableGridCell);
                  }}
                  onCancel={() => props.onFinishedEditing(undefined)}
                />
              </div>
            );
          };
        }}
        onCellEdited={([col, filaVisible], nuevo) => {
          /*
            Las celdas de TEXTO ya entregaron su valor en el `onCommit` del editor; aquí no hay nada
            que hacer con ellas. R98: la casilla de un booleano no tiene editor —glide la alterna con
            el clic y avisa aquí—, así que el cambio se manda desde este punto, con la misma forma que
            el valor original (1/0 en un TINYINT(1)).
          */
          if (nuevo.kind !== GridCellKind.Boolean || typeof nuevo.data !== "boolean") return;
          const columna = columnas[col];
          if (!columna) return;
          const clave = columnKey(columna);
          if (!puedeEditar?.(clave)) return;
          const filaOriginal = indices[filaVisible] ?? filaVisible;
          const original = filas[filaOriginal]?.[clave];
          onEditarCelda?.(clave, filaOriginal, booleanoParaGuardar(original, nuevo.data));
        }}
        onHeaderClicked={(col) => {
          const columna = columnas[col];
          if (!columna) return;
          // El `apilar` de D1 sale del `⌥` que capturó el `pointerdown` en captura (ver `apilarRef`):
          // con `⌥` el clic APILA un nivel detrás de los que ya había; sin él, REEMPLAZA el orden por
          // esta columna —o cicla asc → desc → nada si es el único nivel (el ciclo de siempre).
          setOrden((actual) => siguienteOrden(actual, columnKey(columna), apilarRef.current));
        }}
      />
      )}

      {/* La fila de filtros va DESPUÉS del canvas para quedar por encima (la banda que ocupa la
          reserva la cabecera, así que no tapa ninguna fila de datos). */}
      {filaDeFiltros && (
        <FilterRow
          ref={filaDeFiltrosRef}
          columnas={columnas.map((c) => columnKey(c))}
          filtros={filtros}
          onCambiarFiltro={onCambiarFiltro ?? (() => undefined)}
          onLimpiarFiltros={onLimpiarFiltros ?? (() => undefined)}
          medir={medirColumnas}
          altoCabecera={altoCabecera}
          altoFila={altoFila}
        />
      )}
    </div>
  );
}
