/**
 * Fila de filtros local (fase 13, T2; R38, decisión D1).
 *
 * Son inputs de DOM **encima** del canvas, alineados con sus columnas. La decisión de D1 fue
 * exactamente esta: lo de DataGrip y sin un clic previo por columna, a cambio de la alineación
 * (que es todo el trabajo de este archivo).
 *
 * Cómo se alinea, que es lo único delicado:
 *
 * 1. La rejilla reserva una banda dentro de SU cabecera (ver `data-grid.tsx`: `headerHeight` crece
 *    una fila y el texto de la columna se dibuja desplazado hacia arriba). Esta fila se coloca
 *    justo en esa banda, así que **no tapa ninguna fila de datos** — que es el fallo evidente de
 *    superponer un div sobre un canvas.
 * 2. La x y el ancho de cada input salen de `getBounds(columna, -1)` de la rejilla, que devuelve la
 *    geometría YA con el scroll horizontal aplicado y en coordenadas de cliente (medido en
 *    `computeBounds`: suma `translateX` y luego el rect del canvas). Por eso no hay que adivinar
 *    nada: se resta el rect del contenedor y ya está.
 * 3. La fila **no se re-renderiza en cada frame de scroll**: la rejilla avisa con `sincronizar()`
 *    (handle imperativo) y aquí sólo se actualiza el estado si alguna x se movió más de medio px.
 *    Re-renderizar este componente no re-renderiza el canvas; re-renderizar `data-grid.tsx` sí.
 *
 * Las columnas fuera de la vista no se renderizan: con 50 columnas eso es la diferencia entre 50
 * inputs y los 8 que se ven.
 */
import * as React from "react";
import { IjIcon } from "@/components/ij-icon";
import type { TextosDeFiltro } from "./filtering";

/** Dónde va el input de una columna, en píxeles relativos al contenedor de la rejilla. */
export interface PosicionDeFiltro {
  columna: string;
  etiqueta?: string;
  izquierda: number;
  ancho: number;
}

export interface FiltroRowHandle {
  /** Recoloca los inputs. La llama la rejilla al hacer scroll o al cambiar columnas o tamaño. */
  sincronizar: () => void;
}

/**
 * ¿Son las mismas posiciones? Medio píxel de tolerancia porque `getBounds` devuelve fracciones del
 * gesto suave de scroll (`smoothScrollX`), y sin ese margen cada frame del scroll re-renderizaría la
 * fila entera.
 */
function mismasPosiciones(a: PosicionDeFiltro[], b: PosicionDeFiltro[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (p, i) =>
        p.columna === b[i].columna &&
        p.etiqueta === b[i].etiqueta &&
        Math.abs(p.izquierda - b[i].izquierda) < 0.5 &&
        Math.abs(p.ancho - b[i].ancho) < 0.5
    )
  );
}

interface FilterRowProps {
  /** Nombres de columna, en el mismo orden que la rejilla. */
  columnas: string[];
  filtros: TextosDeFiltro;
  onCambiarFiltro: (columna: string, valor: string) => void;
  onLimpiarFiltros: () => void;
  /** Mide las columnas visibles. La implementa la rejilla (es la única que tiene el `ref`). */
  medir: () => PosicionDeFiltro[];
  /** Alto de la banda del texto de la cabecera, encima de esta fila. */
  altoCabecera: number;
  /** Alto de la fila. Sale de la densidad, nunca fijo: la densidad es configurable (fase 7). */
  altoFila: number;
}

/**
 * Retardo de tecleo antes de filtrar.
 *
 * No es superstición: el filtro recorre el result set entero (100 000 filas son ~17 ms medidos en
 * `filtering.test.ts`) y además dispara el repintado de la rejilla. Aplicarlo en cada pulsación
 * funciona, pero deja el tecleo con tirones; con 150 ms se siente inmediato (el umbral de lo que se
 * percibe como instantáneo ronda los 100 ms) sin pagar el coste por letra.
 */
const RETARDO_MS = 150;

export const FilterRow = React.forwardRef<FiltroRowHandle, FilterRowProps>(function FilterRow(
  { columnas, filtros, onCambiarFiltro, onLimpiarFiltros, medir, altoCabecera, altoFila },
  ref
) {
  const [posiciones, setPosiciones] = React.useState<PosicionDeFiltro[]>([]);

  /**
   * Ajuste de estado en render, no en un efecto: React lo permite (y el repo ya usa el patrón)
   * cuando el estado se deriva de algo que se puede medir sin efectos secundarios — aquí,
   * `getBounds` sobre un canvas ya pintado.
   *
   * La alternativa era un `useLayoutEffect` que llamara a `recolocar()`, y el lint de este repo lo
   * rechaza (`react-hooks/set-state-in-effect`) por lo que es: renders en cascada.
   */
  const medidas = medir();
  if (!mismasPosiciones(posiciones, medidas)) setPosiciones(medidas);

  React.useImperativeHandle(
    ref,
    () => ({
      // Con la misma guarda que el ajuste en render: el scroll dispara esto en cada frame, y sin
      // filtrar las posiciones iguales re-renderizaríamos la fila por nada.
      sincronizar: () =>
        setPosiciones((previas) => {
          const nuevas = medir();
          return mismasPosiciones(previas, nuevas) ? previas : nuevas;
        }),
    }),
    [medir]
  );

  const hayAlguno = columnas.some((c) => (filtros[c] ?? "").trim() !== "");

  return (
    <div
      data-testid="fila-de-filtros"
      className="absolute right-0 left-0 z-10 flex border-b border-gdb-grid bg-gdb-th"
      style={{ top: altoCabecera, height: altoFila }}
      // Los clics dentro de la fila no deben llegar al canvas (que los interpretaría como clic en
      // la celda de debajo): el input para el evento en su propio manejador, pero el hueco entre
      // inputs tiene que pararlo aquí.
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* A la izquierda, sobre el canal de los números de fila, el embudo que limpia todo. Es el
          «Clear Local Filter For All Columns» de DataGrip, donde está a mano. */}
      <button
        type="button"
        onClick={onLimpiarFiltros}
        disabled={!hayAlguno}
        title="Limpiar filtros"
        aria-label="Limpiar filtros"
        className={
          "absolute top-0 left-0 flex h-full w-6 items-center justify-center border-r border-gdb-grid " +
          (hayAlguno
            ? "text-gdb-fg hover:bg-gdb-hover"
            : "opacity-40")
        }
      >
        <IjIcon name="filter" />
      </button>

      {posiciones.map((p) => (
        <EntradaDeFiltro
          key={p.columna}
          columna={p.columna}
          etiqueta={p.etiqueta}
          valor={filtros[p.columna] ?? ""}
          onCambiar={onCambiarFiltro}
          izquierda={p.izquierda}
          ancho={p.ancho}
        />
      ))}
    </div>
  );
});

/**
 * Un input de la fila, con su propio borrador.
 *
 * El borrador local existe porque el estado de verdad (el texto aplicado) vive arriba y se aplica
 * con retardo: sin él, el cursor saltaría y el valor tecleado se perdería entre pulsaciones. El
 * caso que hay que cuidar es el de fuera: si el filtro cambia por otra vía (Limpiar filtros), el
 * input tiene que adoptarlo — y distinguirlo del cambio que provocamos nosotros es lo que hace
 * `ultimoEnviado`.
 */
function EntradaDeFiltro({
  columna,
  etiqueta,
  valor,
  onCambiar,
  izquierda,
  ancho,
}: {
  columna: string;
  etiqueta?: string;
  valor: string;
  onCambiar: (columna: string, valor: string) => void;
  izquierda: number;
  ancho: number;
}) {
  const label = etiqueta ?? columna;
  const [borrador, setBorrador] = React.useState(valor);
  const ultimoEnviado = React.useRef(valor);
  const temporizador = React.useRef<number | undefined>(undefined);

  React.useEffect(() => {
    if (valor === ultimoEnviado.current) return;
    // Cambió desde fuera (p. ej. «Limpiar filtros»): se adopta.
    ultimoEnviado.current = valor;
    setBorrador(valor);
  }, [valor]);

  // Sin esto, un temporizador vivo tras desmontar llama a `onCambiar` con el componente ya fuera.
  React.useEffect(() => () => window.clearTimeout(temporizador.current), []);

  const enviar = React.useCallback(
    (nuevo: string) => {
      ultimoEnviado.current = nuevo;
      onCambiar(columna, nuevo);
    },
    [columna, onCambiar]
  );

  const alTeclear = (nuevo: string) => {
    setBorrador(nuevo);
    window.clearTimeout(temporizador.current);
    temporizador.current = window.setTimeout(() => enviar(nuevo), RETARDO_MS);
  };

  const alPulsarTecla = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // que Escape no le llegue al grid (cierra editores / limpia selección)
      window.clearTimeout(temporizador.current);
      setBorrador("");
      enviar("");
      return;
    }
    if (e.key === "Enter") {
      // Aplicar ya, sin esperar al retardo.
      e.preventDefault();
      window.clearTimeout(temporizador.current);
      enviar(borrador);
    }
  };

  const conFiltro = borrador.trim() !== "";

  return (
    <div
      className="absolute top-0 h-full border-r border-gdb-grid"
      style={{ left: izquierda, width: ancho }}
    >
      <input
        value={borrador}
        onChange={(e) => alTeclear(e.target.value)}
        onKeyDown={alPulsarTecla}
        placeholder="filtrar…"
        aria-label={`Filtro de la columna ${label}`}
        spellCheck={false}
        className={
          "h-full w-full bg-transparent px-1.5 pr-5 font-mono text-[11px] outline-none " +
          "placeholder:text-gdb-muted focus:bg-gdb-field " +
          (conFiltro ? "text-gdb-fgstrong" : "text-gdb-fg")
        }
      />
      {/* La × de cada columna: quitar este filtro sin borrar letra a letra. */}
      {conFiltro && (
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()} // no robarle el foco al input
          onClick={() => {
            window.clearTimeout(temporizador.current);
            setBorrador("");
            enviar("");
          }}
          title={`Quitar el filtro de ${label}`}
          aria-label={`Quitar el filtro de ${label}`}
          className="absolute top-1/2 right-1 -translate-y-1/2 text-gdb-muted hover:text-gdb-fg"
        >
          <IjIcon name="close" />
        </button>
      )}
    </div>
  );
}
