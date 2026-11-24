/**
 * Vista de documentos de una colección de MongoDB (fase 81) — la versión DataDB de la vista
 * «Documents» de MongoDB Compass, que es la referencia que dio el usuario.
 *
 * QUÉ REPLICA DE COMPASS (y por qué):
 *  - **Barra de consulta** arriba con el filtro en JSON, «Buscar» a la derecha y «Limpiar»: es el
 *    gesto central de Compass, escribir `{ campo: "valor" }` y ver el resultado sin salir de la
 *    colección.
 *  - **Opciones** plegadas (proyección y orden) para no llenar la barra: en Compass viven detrás de
 *    «Options». Aquí son dos campos que se olvidan al cerrarse, como allí.
 *  - **Tarjeta por documento** con una fila por campo (`clave: valor`), el tipo con color y los
 *    objetos/arrays plegables con su resumen (`{3 campos}`, `[4]`). Una rejilla de columnas no sirve:
 *    los documentos de una colección NO comparten campos.
 *  - **Contador y paginación** a la derecha (`1–25 de 120`), con el tamaño de página en un selector.
 *  - **Vista JSON** conmutables: la tarjeta para leer, el JSON para copiar.
 *
 * QUÉ NO HACE TODAVÍA (fase siguiente, declarado en el PLAN): editar/insertar/borrar documentos,
 * índices, aggregations y explicar el plan.
 */
import * as React from "react";
import { Button } from "@/components/ui/button";
import { IjIcon } from "@/components/ij-icon";
import { cn } from "@/lib/utils";
import { mongoDelete, mongoFields, mongoFind, mongoInsert, mongoUpdate } from "@/lib/api";
import { useAppDispatch } from "@/hooks/use-app-state";
import { runWithConsoleSession } from "@/lib/session-reconnect-client";
import { MongoBorrarDialog, MongoDocumentDialog, type ModoDeDocumento } from "@/components/mongo-document-dialog";
import { plantillaParaDuplicar, plantillaParaEditar } from "@/shared/mongo-document-json";
import {
  cambiosRespectoA,
  convertirTexto,
  esEditable,
  textoEditable,
  type TipoValorOriginal,
} from "@/shared/mongo-values";
import { MongoQueryField } from "@/components/mongo-query-field";
import { SUGERENCIAS_MONGO } from "@/lib/mongo-snippets";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ConsoleBinding, Session } from "@/lib/types";
import { cacheDeVistasMongo } from "@/lib/mongo-vista";
import {
  esHoja,
  tipoDeValor,
  textoDeValor,
  type MongoFindResult,
  type TipoDeValor,
} from "@/shared/mongo-view";

/** Color por tipo, con los tokens de sintaxis del tema (no colores literales). */
const CLASE_TIPO: Record<TipoDeValor, string> = {
  string: "text-gdb-str",
  number: "text-gdb-num",
  boolean: "text-gdb-kw",
  null: "text-gdb-fgmuted",
  objectid: "text-gdb-const",
  date: "text-gdb-const",
  decimal: "text-gdb-num",
  long: "text-gdb-num",
  binary: "text-gdb-fgmuted",
  regex: "text-gdb-str",
  object: "text-gdb-fg",
  array: "text-gdb-fg",
};

function etiquetaDeTipo(tipo: TipoDeValor, valor: unknown): string {
  switch (tipo) {
    case "objectid":
      return "ObjectId";
    case "string":
      return "String";
    case "number":
      return typeof valor === "number" && Number.isInteger(valor) ? "Int32" : "Double";
    case "long":
      return "Int64";
    case "decimal":
      return "Decimal128";
    case "boolean":
      return "Boolean";
    case "date":
      return "Date";
    case "null":
      return "Null";
    case "binary":
      return "Binary";
    case "regex":
      return "RegExp";
    case "array":
      return Array.isArray(valor) ? `Array(${valor.length})` : "Array";
    case "object":
      return "Document";
  }
}

const TAMANOS_DE_PAGINA = [25, 50, 100];

/**
 * Una fila `clave: valor`. Se pliega si el valor es objeto o array y, en el primer nivel, se puede
 * EDITAR en el sitio (fase 85): clic en el valor → input, `⏎` lo manda al borrador, `⎋` lo descarta.
 *
 * La fila editada se marca con una barra a la izquierda y el valor anterior al pasar el ratón: es la
 * forma de «mostrar visualmente qué cambió» sin abrir un diff aparte.
 */
function FilaDeCampo({
  nombre,
  valor,
  profundidad,
  editable = false,
  cambiado = false,
  valorServidor,
  onCambio,
}: {
  nombre: string;
  valor: unknown;
  profundidad: number;
  editable?: boolean;
  cambiado?: boolean;
  /** Valor que tiene el documento en el servidor, para el «antes: …». */
  valorServidor?: unknown;
  onCambio?: (valor: unknown) => void;
}) {
  const [abierto, setAbierto] = React.useState(profundidad < 1);
  const [editando, setEditando] = React.useState(false);
  const [texto, setTexto] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const tipo = tipoDeValor(valor);
  const desplegable = !esHoja(tipo);
  const puedeEditar = editable && !desplegable && esEditable(tipo);
  const hijos: [string, unknown][] = Array.isArray(valor)
    ? valor.map((v, i) => [String(i), v] as [string, unknown])
    : desplegable
      ? Object.entries(valor as Record<string, unknown>)
      : [];

  function empezar() {
    if (!puedeEditar) return;
    setTexto(textoEditable(valor));
    setError(null);
    setEditando(true);
  }

  function confirmar() {
    const r = convertirTexto(texto, tipo as TipoValorOriginal);
    if (!r.ok) {
      // No se acepta y NO se toca el borrador: el valor sigue como estaba.
      setError(r.error);
      return;
    }
    onCambio?.(r.valor);
    setEditando(false);
    setError(null);
  }

  return (
    <div className="select-text">
      <div
        className={cn(
          "group flex items-baseline gap-1 rounded px-1 py-[1px]",
          desplegable && "cursor-pointer hover:bg-gdb-rowhover",
          puedeEditar && !editando && "cursor-text hover:bg-gdb-rowhover",
          cambiado && "border-l-2 border-gdb-accent bg-gdb-hover"
        )}
        onClick={desplegable ? () => setAbierto((a) => !a) : puedeEditar && !editando ? empezar : undefined}
        title={cambiado ? `Antes: ${textoDeValor(valorServidor)}` : undefined}
        style={{ paddingLeft: 4 + profundidad * 14 }}
      >
        {desplegable ? (
          <span className="flex w-3 shrink-0 justify-center text-[9px] text-gdb-fgmuted">
            {abierto ? "▾" : "▸"}
          </span>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="shrink-0 font-jetbrains text-[11px] text-gdb-fgstrong">{nombre}</span>
        <span className="shrink-0 text-[11px] text-gdb-fgmuted">:</span>

        {editando ? (
          <span className="flex min-w-0 flex-1 items-baseline gap-1">
            <input
              autoFocus
              value={texto}
              onChange={(e) => {
                setTexto(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  confirmar();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditando(false);
                  setError(null);
                }
              }}
              onBlur={() => {
                // Perder el foco sin ⏎ descarta: un clic fuera no debe guardar algo a medias.
                setEditando(false);
                setError(null);
              }}
              aria-label={`Editar ${nombre}`}
              spellCheck={false}
              className="min-w-0 flex-1 rounded border border-gdb-accent bg-gdb-field px-1 font-jetbrains text-[11px] text-gdb-fg outline-none"
            />
            {error && <span className="shrink-0 text-[10px] text-gdb-dangerfg">{error}</span>}
            {tipo === "null" && (
              <span className="shrink-0 text-[10px] text-gdb-fgmuted">escribe un texto y quedará como cadena</span>
            )}
          </span>
        ) : tipo === "boolean" ? (
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-[1px] font-jetbrains text-[10.5px] font-semibold",
              valor ? "bg-gdb-okbg text-gdb-okfg" : "bg-gdb-dangerbg text-gdb-dangerfg"
            )}
          >
            {valor ? "true" : "false"}
          </span>
        ) : tipo === "null" ? (
          <span className="inline-block rounded bg-gdb-contrast/70 px-1.5 py-[1px] font-jetbrains text-[10.5px] italic text-gdb-fgmuted">
            null
          </span>
        ) : (
          <span
            className={cn(
              "min-w-0 break-all font-jetbrains text-[11px]",
              CLASE_TIPO[tipo]
            )}
          >
            {textoDeValor(valor)}
          </span>
        )}
        {!editando && (
          <span className="ml-auto shrink-0 rounded border border-gdb-sep/70 px-1 font-jetbrains text-[10px] text-gdb-fgmuted">
            {etiquetaDeTipo(tipo, valor)}
          </span>
        )}
      </div>
      {desplegable && abierto && (
        <div>
          {hijos.map(([k, v]) => (
            // Los anidados se ven pero no se editan en la v1 (fase 85 §2): su editor es el de la v2.
            <FilaDeCampo key={k} nombre={k} valor={v} profundidad={profundidad + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function TarjetaDeDocumento({
  doc,
  original,
  indice,
  vista,
  editable,
  guardando,
  error,
  onCambio,
  onRevertir,
  onGuardar,
  onEditarJson,
  onDuplicar,
  onBorrar,
}: {
  /** Documento con el borrador ya aplicado. */
  doc: Record<string, unknown>;
  /** Documento tal como está en el servidor (para el diff y el «antes»). */
  original: Record<string, unknown>;
  indice: number;
  vista: "lista" | "json" | "tabla";
  editable: boolean;
  guardando: boolean;
  error: string | null;
  onCambio: (campo: string, valor: unknown) => void;
  onRevertir: () => void;
  onGuardar: () => void;
  onEditarJson: () => void;
  onDuplicar: () => void;
  onBorrar: () => void;
}) {
  const [copiado, setCopiado] = React.useState(false);
  const cambios = cambiosRespectoA(original, doc);
  const nCambios = Object.keys(cambios).length;

  return (
    <div className="group overflow-hidden rounded-md border border-gdb-sep bg-gdb-chrome">
      {/*
        Cabecera: chip con el número, la cuenta de cambios y —solo cuando hay cambios— Revertir y
        Guardar. Decisión del usuario (2026-10-21): los botones viven aquí, junto al número.
      */}
      <div className="flex items-center justify-between gap-2 border-b border-gdb-sep bg-gdb-th px-3 py-1">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="rounded border border-gdb-border/70 bg-gdb-chrome px-1.5 py-[1px] font-jetbrains text-[10px] font-medium tabular-nums text-gdb-fgstrong"
            title={`Documento ${indice} de esta página`}
          >
            #{indice}
          </span>
          {"_id" in doc && doc._id !== undefined && (
            <span className="truncate font-jetbrains text-[11px] text-gdb-const">
              {textoDeValor(doc._id)}
            </span>
          )}
          <span className="shrink-0 font-jetbrains text-[10px] text-gdb-fgmuted">
            {Object.keys(doc).length} {Object.keys(doc).length === 1 ? "campo" : "campos"}
          </span>
          {nCambios > 0 && (
            <span className="shrink-0 text-[10px] text-gdb-accent" title="Campos modificados sin guardar">
              ● {nCambios} {nCambios === 1 ? "cambio" : "cambios"}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {nCambios > 0 && (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={onRevertir}
                disabled={guardando}
                title="Descartar los cambios de este documento"
                className="h-6 px-2 text-[11px]"
              >
                Revertir
              </Button>
              <Button
                size="sm"
                onClick={onGuardar}
                disabled={guardando}
                title="Guardar los cambios en la base"
                className="h-6 px-2 text-[11px]"
              >
                {guardando ? "Guardando…" : "Guardar"}
              </Button>
            </>
          )}
          {editable && (
            <>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={onEditarJson}
                title="Editar el documento como JSON (incluye anidados)"
                aria-label="Editar el documento como JSON"
                className="h-5 w-5 text-[10px] text-gdb-fgmuted hover:text-gdb-fg"
              >
                {"{}"}
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={onDuplicar}
                title="Duplicar este documento"
                aria-label="Duplicar este documento"
                className="h-5 w-5 text-[11px] text-gdb-fgmuted hover:text-gdb-fg"
              >
                ⧉
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={onBorrar}
                title="Borrar este documento"
                aria-label="Borrar este documento"
                className="h-5 w-5 text-[11px] text-gdb-fgmuted hover:text-gdb-dangerfg"
              >
                ✕
              </Button>
            </>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            title="Copiar el documento como JSON"
            aria-label="Copiar el documento como JSON"
            className="h-5 w-5 opacity-0 transition-opacity group-hover:opacity-100"
            onClick={async () => {
              await navigator.clipboard.writeText(JSON.stringify(doc, null, 2));
              setCopiado(true);
              setTimeout(() => setCopiado(false), 1200);
            }}
          >
            <span className="text-[10px]">{copiado ? "✓" : "⧉"}</span>
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="mx-2 mt-1 rounded border border-gdb-dangerbg bg-gdb-dangerbg px-2 py-1 text-[10px] text-gdb-dangerfg">
          {error}
        </p>
      )}

      {vista === "json" ? (
        <pre className="max-h-80 overflow-auto p-2 font-jetbrains text-[11px] leading-[1.45] text-gdb-fg">
          {JSON.stringify(doc, null, 2)}
        </pre>
      ) : (
        <div className="py-1">
          {Object.entries(doc).map(([k, v]) => (
            <FilaDeCampo
              key={k}
              nombre={k}
              valor={v}
              profundidad={0}
              editable={editable && vista === "lista"}
              cambiado={Object.prototype.hasOwnProperty.call(cambios, k)}
              valorServidor={original[k]}
              onCambio={(valor) => onCambio(k, valor)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function MongoDocuments({
  consoleId,
  session,
  binding,
  coleccion,
  pestanaId,
}: {
  consoleId: string;
  session: Session | null;
  binding?: ConsoleBinding | null;
  coleccion: string;
  /** Id de la pestaña: la clave del caché de vistas (T1 de R100). */
  pestanaId: string;
}) {
  const dispatch = useAppDispatch();
  const sessionRef = React.useRef<Session | null>(session);
  const bindingRef = React.useRef<ConsoleBinding | null | undefined>(binding);
  React.useEffect(() => {
    sessionRef.current = session;
    bindingRef.current = binding;
  }, [session, binding]);

  const runWithSession = React.useCallback(
    <T,>(operation: (activeSession: Session) => Promise<T>) =>
      runWithConsoleSession(
        {
          consoleId,
          session: sessionRef.current,
          binding: bindingRef.current,
          onSessionChange: (next) => {
            sessionRef.current = next;
            dispatch({ type: "SET_SESSION", payload: { consoleId, session: next } });
          },
        },
        operation
      ),
    [consoleId, dispatch]
  );

  const readOnly = Boolean(session?.readOnly ?? binding?.readOnly);

  /**
   * Estado con el que nace la vista: lo que esta pestaña tenía la última vez (T1 de R100). Se lee con
   * el inicializador de `useState` —no en un efecto— para que corra exactamente una vez por montaje:
   * un `useEffect` llegaría DESPUÉS del primer render y la primera página se pediría igual.
   */
  const [vistaInicial] = React.useState(() => cacheDeVistasMongo.leer(pestanaId));
  const cargaInicialHechaRef = React.useRef(Boolean(vistaInicial?.resultado));
  const [filtro, setFiltro] = React.useState(vistaInicial?.filtro ?? "");
  const [proyeccion, setProyeccion] = React.useState(vistaInicial?.proyeccion ?? "");
  const [orden, setOrden] = React.useState(vistaInicial?.orden ?? "");
  const [opcionesAbiertas] = React.useState(vistaInicial?.opcionesAbiertas ?? false);
  const [pagina, setPagina] = React.useState(vistaInicial?.pagina ?? 0);
  const [porPagina, setPorPagina] = React.useState(vistaInicial?.porPagina ?? TAMANOS_DE_PAGINA[0]);
  const [vista, setVista] = React.useState<"lista" | "json" | "tabla">(vistaInicial?.vista ?? "lista");
  const [resultado, setResultado] = React.useState<MongoFindResult | null>(vistaInicial?.resultado ?? null);
  /**
   * Borradores por documento (fase 85): `clave` → valores editados. No tocan el servidor hasta
   * Guardar. La clave es el `_id` serializado, que es lo único estable de un documento.
   */
  const [borradores, setBorradores] = React.useState<Record<string, Record<string, unknown>>>(
    vistaInicial?.borradores ?? {}
  );
  const [guardando, setGuardando] = React.useState<Record<string, boolean>>({});
  const [erroresDoc, setErroresDoc] = React.useState<Record<string, string | null>>(
    vistaInicial?.erroresDoc ?? {}
  );
  /**
   * Diálogo de documento (fase 86): insertar, duplicar o editar el JSON completo (incluye anidados).
   * `documento` es el original cuando se edita o duplica; en «insertar» va vacío.
   */
  const [dialogo, setDialogo] = React.useState<
    { modo: ModoDeDocumento; texto: string; original?: Record<string, unknown> } | null
  >(null);
  const [dialogoGuardando, setDialogoGuardando] = React.useState(false);
  const [dialogoError, setDialogoError] = React.useState<string | null>(null);
  /** Confirmación de borrado: el documento que se va a borrar. */
  const [porBorrar, setPorBorrar] = React.useState<Record<string, unknown> | null>(null);
  const [borrando, setBorrando] = React.useState(false);
  const [borrarError, setBorrarError] = React.useState<string | null>(null);
  const [cargando, setCargando] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /**
   * `aplicado` es el filtro que se está MOSTRANDO, separado de lo que hay escrito en la barra.
   * Sin esa separación, teclear dispara una consulta por tecla o el contador miente: Compass hace
   * lo mismo — se escribe y se pulsa Buscar (o ⌘⏎).
   */
  const [aplicado, setAplicado] = React.useState(
    vistaInicial?.aplicado ?? { filtro: "", proyeccion: "", orden: "" }
  );
  /**
   * Campos de la colección para el autocompletado (fase 83). Se piden al abrir la colección: son los
   * que Mongo sí detecta, y sin ellos el usuario teclea los nombres a ciegas.
   */
  const [campos, setCampos] = React.useState<string[]>([]);

  React.useEffect(() => {
    const sid = session?.sessionId;
    if (!sid) return;
    let vivo = true;
    (async () => {
      try {
        const { campos: lista } = await mongoFields({ sessionId: sid, coleccion });
        if (vivo) setCampos(lista);
      } catch {
        // Sin campos el autocompletado de claves queda vacío; los operadores siguen funcionando.
        // No se muestra error: es una ayuda, no parte de la consulta.
      }
    })();
    return () => {
      vivo = false;
    };
  }, [session?.sessionId, coleccion]);

  const cargar = React.useCallback(
    async (opts: { filtro: string; proyeccion: string; orden: string }, paginaNueva: number, tamano: number) => {
      setCargando(true);
      setError(null);
      try {
        const { result: r } = await runWithSession((activeSession) =>
          mongoFind({
            sessionId: activeSession.sessionId,
            coleccion,
            filtro: opts.filtro,
            proyeccion: opts.proyeccion,
            orden: opts.orden,
            skip: paginaNueva * tamano,
            limit: tamano,
          })
        );
        setResultado(r);
      } catch (err) {
        // El IPC devuelve el error serializado y a veces llega con el prefijo «Error: »: se quita
        // para que el aviso empiece por el motivo («filtro inválido: …») y no por la palabra.
        const mensaje = err instanceof Error ? err.message : String(err);
        setError(mensaje.replace(/^Error:\s*/, ""));
        setResultado(null);
      } finally {
        setCargando(false);
      }
    },
    [coleccion, runWithSession]
  );

  const buscar = React.useCallback(() => {
    cargaInicialHechaRef.current = true;
    const siguiente = { filtro, proyeccion, orden };
    setAplicado(siguiente);
    setPagina(0);
    void cargar(siguiente, 0, porPagina);
  }, [filtro, proyeccion, orden, porPagina, cargar]);

  /*
   * Primera página, sin filtro (como Compass) — PERO sólo la primera vez de esta pestaña. Al cambiar
   * de colección el componente se desmonta (`key={tab.id}`) y al volver NACE con lo que el caché
   * guardó de la última visita: si ya hay resultado, repetir la consulta tiraría a la basura justo
   * lo que el usuario pidió conservar. Sólo una pestaña sin historial (caché vacío) pide la página
   * inicial. Un `setState` síncrono dentro de un efecto está prohibido por el lint del repo (renders
   * en cascada).
   */
  React.useEffect(() => {
    let vivo = true;
    // El `await` antes de la llamada es deliberado: el lint del repo (react-hooks/set-state-in-effect)
    // prohíbe tocar estado DENTRO del efecto de forma síncrona; en el siguiente microtask ya no lo es.
    (async () => {
      await Promise.resolve();
      // Con resultado en caché no se consulta: lo que el usuario ya tenía es lo que debe ver al volver.
      if (!vivo || cargaInicialHechaRef.current) return;
      cargaInicialHechaRef.current = true;
      await cargar({ filtro: "", proyeccion: "", orden: "" }, 0, TAMANOS_DE_PAGINA[0]);
    })();
    return () => {
      vivo = false;
    };
  }, [cargar]);

  const claveDe = (doc: Record<string, unknown>, i: number) =>
    String(doc._id ? JSON.stringify(doc._id) : i);

  /** Documento con el borrador aplicado, para pintar. */
  const conBorrador = (doc: Record<string, unknown>, clave: string) => ({
    ...doc,
    ...(borradores[clave] ?? {}),
  });

  function editarCampo(clave: string, campo: string, valor: unknown) {
    setBorradores((prev) => ({
      ...prev,
      [clave]: { ...(prev[clave] ?? {}), [campo]: valor },
    }));
    setErroresDoc((prev) => ({ ...prev, [clave]: null }));
  }

  function revertir(clave: string) {
    setBorradores((prev) => {
      const copia = { ...prev };
      delete copia[clave];
      return copia;
    });
    setErroresDoc((prev) => ({ ...prev, [clave]: null }));
  }

  async function guardar(doc: Record<string, unknown>, clave: string) {
    const original = doc;
    const borrador = borradores[clave] ?? {};
    const cambios = cambiosRespectoA(original, borrador);
    if (Object.keys(cambios).length === 0) return;

    // `antes` = valor que tenía el servidor para los campos que se tocan: el driver solo escribe si
    // siguen iguales (así no se pisa un cambio ajeno hecho mientras se editaba).
    const antes: Record<string, unknown> = {};
    for (const campo of Object.keys(cambios)) {
      if (Object.prototype.hasOwnProperty.call(original, campo)) antes[campo] = original[campo];
    }

    setGuardando((prev) => ({ ...prev, [clave]: true }));
    setErroresDoc((prev) => ({ ...prev, [clave]: null }));
    try {
      const {
        result: { documento },
      } = await runWithSession((activeSession) =>
        mongoUpdate({
          sessionId: activeSession.sessionId,
          coleccion,
          id: original._id,
          cambios,
          antes,
        })
      );
      // Se reemplaza por lo que devolvió el servidor (no por el borrador): si la base normalizó algo,
      // la tarjeta muestra la verdad.
      setResultado((prev) =>
        prev
          ? {
              ...prev,
              documentos: prev.documentos.map((d) =>
                claveDe(d, 0) === clave ? documento : d
              ),
            }
          : prev
      );
      setBorradores((prev) => {
        const copia = { ...prev };
        delete copia[clave];
        return copia;
      });
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : String(err);
      setErroresDoc((prev) => ({ ...prev, [clave]: mensaje.replace(/^Error:\s*/, "") }));
    } finally {
      setGuardando((prev) => ({ ...prev, [clave]: false }));
    }
  }

  /** Abre el diálogo en el modo pedido. */
  function abrirDialogo(modo: ModoDeDocumento, doc?: Record<string, unknown>) {
    setDialogoError(null);
    const texto =
      modo === "insertar"
        ? '{\n  \n}'
        : modo === "duplicar" && doc
          ? plantillaParaDuplicar(doc)
          : doc
            ? plantillaParaEditar(doc)
            : "{}";
    setDialogo({ modo, texto, original: doc });
  }

  async function guardarDialogo(documento: Record<string, unknown>) {
    if (!dialogo) return;
    setDialogoGuardando(true);
    setDialogoError(null);
    try {
      if (dialogo.modo === "editar" && dialogo.original) {
        const original = dialogo.original;
        // Se reutiliza el camino de la fase 85: solo los campos distintos, con los valores originales
        // como filtro (si el documento cambió por fuera, avisa en vez de sobrescribir).
        const cambios = cambiosRespectoA(original, documento);
        if (Object.keys(cambios).length === 0) {
          setDialogo(null);
          return;
        }
        const antes: Record<string, unknown> = {};
        for (const campo of Object.keys(cambios)) {
          if (Object.prototype.hasOwnProperty.call(original, campo)) antes[campo] = original[campo];
        }
        const {
          result: { documento: actualizado },
        } = await runWithSession((activeSession) =>
          mongoUpdate({
            sessionId: activeSession.sessionId,
            coleccion,
            id: original._id,
            cambios,
            antes,
          })
        );
        const clave = claveDe(original, 0);
        setResultado((prev) =>
          prev
            ? { ...prev, documentos: prev.documentos.map((d) => (claveDe(d, 0) === clave ? actualizado : d)) }
            : prev
        );
      } else {
        const {
          result: { documento: creado },
        } = await runWithSession((activeSession) =>
          mongoInsert({
            sessionId: activeSession.sessionId,
            coleccion,
            documento,
          })
        );
        // El nuevo entra arriba de la página actual y el total sube: se ve al instante sin recargar.
        setResultado((prev) =>
          prev
            ? { ...prev, documentos: [creado, ...prev.documentos].slice(0, porPagina), total: prev.total + 1 }
            : prev
        );
      }
      setDialogo(null);
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : String(err);
      setDialogoError(mensaje.replace(/^Error:\s*/, ""));
    } finally {
      setDialogoGuardando(false);
    }
  }

  async function borrarDocumento() {
    if (!porBorrar) return;
    const docPorBorrar = porBorrar;
    setBorrando(true);
    setBorrarError(null);
    try {
      const {
        result: { eliminados },
      } = await runWithSession((activeSession) =>
        mongoDelete({
          sessionId: activeSession.sessionId,
          coleccion,
          id: docPorBorrar._id,
        })
      );
      const clave = claveDe(docPorBorrar, 0);
      setResultado((prev) =>
        prev
          ? {
              ...prev,
              documentos: prev.documentos.filter((d) => claveDe(d, 0) !== clave),
              // Si ya no estaba (0), el total no baja: la lista ya no lo tenía.
              total: eliminados > 0 ? Math.max(0, prev.total - 1) : prev.total,
            }
          : prev
      );
      setBorradores((prev) => {
        const copia = { ...prev };
        delete copia[clave];
        return copia;
      });
      setPorBorrar(null);
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : String(err);
      setBorrarError(mensaje.replace(/^Error:\s*/, ""));
    } finally {
      setBorrando(false);
    }
  }

  const total = resultado?.total ?? 0;
  const desde = total === 0 ? 0 : pagina * porPagina + 1;
  const hasta = Math.min(total, (pagina + 1) * porPagina);
  const haySiguiente = hasta < total;

  function irA(p: number, tamano = porPagina) {
    cargaInicialHechaRef.current = true;
    setPagina(p);
    void cargar(aplicado, p, tamano);
  }

  /*
   * Cada cambio de la vista se guarda en el caché de la pestaña: es lo que hace que cambiar de
   * colección y volver no pierda el resultado, el filtro, la página ni los borradores sin guardar.
   */
  React.useEffect(() => {
    cacheDeVistasMongo.escribir(pestanaId, {
      filtro,
      proyeccion,
      orden,
      opcionesAbiertas,
      aplicado,
      pagina,
      porPagina,
      vista,
      resultado,
      borradores,
      erroresDoc,
    });
  }, [pestanaId, filtro, proyeccion, orden, opcionesAbiertas, aplicado, pagina, porPagina, vista, resultado, borradores, erroresDoc]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-gdb-editor">
      {/* --- Barra de consulta (estilo OpenDesign) ---------------------------- */}
      <div className="grid shrink-0 grid-cols-1 items-end gap-2 border-b border-gdb-sep bg-gdb-chrome px-3 py-2.5 md:grid-cols-[minmax(200px,2fr)_minmax(130px,1fr)_minmax(130px,1fr)_auto]">
        <div className="min-w-0">
          <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-wider text-gdb-muted">
            Filtro
          </span>
          <MongoQueryField
            valor={filtro}
            onCambio={setFiltro}
            onEnter={buscar}
            campos={campos}
            placeholder={'{ campo: "valor" }  ó  { edad: { $gt: 30 } }'}
            ariaLabel="Filtro de documentos"
          />
        </div>
        <div className="min-w-0">
          <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-wider text-gdb-muted">
            Orden
          </span>
          <MongoQueryField
            valor={orden}
            onCambio={setOrden}
            onEnter={buscar}
            campos={campos}
            placeholder="{ campo: -1 }"
            ariaLabel="Orden"
          />
        </div>
        <div className="min-w-0">
          <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-wider text-gdb-muted">
            Proyección
          </span>
          <MongoQueryField
            valor={proyeccion}
            onCambio={setProyeccion}
            onEnter={buscar}
            campos={campos}
            placeholder="{ campo: 1 }"
            ariaLabel="Proyección"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            onClick={buscar}
            disabled={cargando}
            title="Buscar (⏎)"
            className="h-7 gap-1.5 px-2.5"
          >
            {cargando ? "Buscando…" : "Buscar"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setFiltro("");
              setProyeccion("");
              setOrden("");
              setAplicado({ filtro: "", proyeccion: "", orden: "" });
              setPagina(0);
              void cargar({ filtro: "", proyeccion: "", orden: "" }, 0, porPagina);
            }}
            title="Limpiar el filtro"
            className="h-7 border-gdb-sep bg-transparent px-2"
          >
            Limpiar
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              title="Sugerencias de consulta (con su equivalente en SQL)"
              aria-label="Sugerencias de consulta"
              className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-gdb-fg hover:bg-gdb-hover data-[popup-open]:bg-gdb-hover"
            >
              Sugerencias
              <span aria-hidden="true" className="text-[9px]">
                ▾
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="max-h-[70vh] w-[380px] overflow-auto border-gdb-sep bg-gdb-chrome p-1 text-gdb-fg"
            >
              {SUGERENCIAS_MONGO.map((grupo) => (
                <DropdownMenuGroup key={grupo.titulo}>
                  <DropdownMenuLabel className="px-2 py-1 text-[10px] uppercase tracking-wide text-gdb-fgmuted">
                    {grupo.titulo}
                  </DropdownMenuLabel>
                  {grupo.items.map((item) => (
                    <DropdownMenuItem
                      key={item.etiqueta}
                      onClick={() => {
                        setFiltro(item.plantilla);
                        setAplicado({ filtro: item.plantilla, proyeccion, orden });
                        setPagina(0);
                        void cargar({ filtro: item.plantilla, proyeccion, orden }, 0, porPagina);
                      }}
                      className="flex flex-col items-start gap-0.5 px-2 py-1.5 text-xs"
                    >
                      <span className="flex w-full items-center justify-between gap-2">
                        <span className="text-gdb-fgstrong">{item.etiqueta}</span>
                        {item.sql && (
                          <span className="shrink-0 rounded bg-gdb-field px-1 font-jetbrains text-[9px] text-gdb-fgmuted">
                            {item.sql}
                          </span>
                        )}
                      </span>
                      <span className="w-full truncate font-jetbrains text-[10px] text-gdb-fgmuted">
                        {item.plantilla}
                      </span>
                      {item.nota && (
                        <span className="w-full text-[10px] leading-snug text-gdb-fgdim">{item.nota}</span>
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {!readOnly && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => abrirDialogo("insertar")}
              title="Insertar un documento nuevo"
              className="h-7 border-gdb-sep bg-transparent px-2"
            >
              + Documento
            </Button>
          )}
        </div>
      </div>

      {/* --- Barra de herramientas de resultados (3 vistas + paginación) ------- */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-gdb-sep bg-gdb-th px-3 py-1.5">
        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-md border border-gdb-sep bg-gdb-editor p-0.5" role="tablist">
            {(["lista", "json", "tabla"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setVista(v)}
                title={
                  v === "lista"
                    ? "Vista de tarjetas (árbol BSON)"
                    : v === "json"
                      ? "Vista JSON"
                      : "Vista de tabla"
                }
                className={cn(
                  "rounded-sm px-2.5 py-0.5 text-[11.5px] font-medium transition-colors",
                  vista === v
                    ? "bg-gdb-contrast text-gdb-fgstrong shadow-xs"
                    : "text-gdb-fgdim hover:text-gdb-fgstrong"
                )}
              >
                {v === "lista" ? "Lista" : v === "json" ? "JSON" : "Tabla"}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 text-[11.5px] text-gdb-fgdim">
            <IjIcon name="mongodb" className="size-3.5 text-gdb-enginemongo" />
            <span className="font-jetbrains text-gdb-fg">{coleccion}</span>
            {resultado && (
              <span>
                · {desde}–{hasta} de {total} · {resultado.ms} ms
              </span>
            )}
            {cargando && !resultado && <span>· cargando…</span>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <select
            value={porPagina}
            onChange={(e) => {
              const tamano = Number(e.target.value);
              setPorPagina(tamano);
              irA(0, tamano);
            }}
            aria-label="Documentos por página"
            className="h-6 rounded border border-gdb-sep bg-gdb-editor px-1.5 text-[11px] text-gdb-fg"
          >
            {TAMANOS_DE_PAGINA.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={pagina === 0 || cargando}
            onClick={() => irA(pagina - 1)}
            title="Página anterior"
            className="h-6 w-6"
          >
            ‹
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={!haySiguiente || cargando}
            onClick={() => irA(pagina + 1)}
            title="Página siguiente"
            className="h-6 w-6"
          >
            ›
          </Button>
        </div>
      </div>

      {/* --- Documentos ------------------------------------------------------ */}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {error && (
          <div
            role="alert"
            className="mb-2 rounded border border-gdb-dangerbg bg-gdb-dangerbg px-2 py-1.5 font-jetbrains text-[11px] text-gdb-dangerfg"
          >
            {error}
          </div>
        )}
        {!error && resultado && resultado.documentos.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-gdb-fgmuted">
            No hay documentos que cumplan el filtro.
          </p>
        )}
        {vista === "tabla" && resultado && resultado.documentos.length > 0 ? (
          (() => {
            const cols = Array.from(
              new Set(resultado.documentos.flatMap((d) => Object.keys(d)))
            );
            return (
              <div className="overflow-auto rounded-md border border-gdb-sep bg-gdb-editor">
                <table className="w-full border-separate border-spacing-0 font-jetbrains text-xs">
                  <thead>
                    <tr>
                      <th className="sticky top-0 z-10 w-10 border-b border-r border-gdb-sep bg-gdb-th px-2 py-1.5 text-center text-[11px] font-medium text-gdb-muted">
                        #
                      </th>
                      {cols.map((col) => (
                        <th
                          key={col}
                          className="sticky top-0 z-10 border-b border-r border-gdb-sep bg-gdb-th px-2.5 py-1.5 text-left font-sans text-xs font-semibold text-gdb-fgstrong whitespace-nowrap"
                        >
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {resultado.documentos.map((doc, i) => {
                      const clave = claveDe(doc, pagina * porPagina + i);
                      const actual = conBorrador(doc, clave);
                      return (
                        <tr
                          key={clave}
                          onClick={() => !readOnly && abrirDialogo("editar", doc)}
                          className={cn(
                            "odd:bg-gdb-editor even:bg-gdb-contrast/45 hover:bg-gdb-rowhover",
                            !readOnly && "cursor-pointer"
                          )}
                        >
                          <td className="border-b border-r border-gdb-grid bg-gdb-th/70 px-2 py-1 text-center text-[11px] text-gdb-muted select-none">
                            {pagina * porPagina + i + 1}
                          </td>
                          {cols.map((col) => {
                            const val = actual[col];
                            return (
                              <td
                                key={col}
                                className="max-w-[260px] truncate border-b border-r border-gdb-grid px-2.5 py-1 text-gdb-fg"
                              >
                                {val === undefined || val === null ? (
                                  <span className="rounded border border-gdb-sep bg-gdb-contrast px-1.5 py-0.5 text-[10.5px] italic text-gdb-muted">
                                    {val === null ? "null" : "—"}
                                  </span>
                                ) : typeof val === "boolean" ? (
                                  <span
                                    className={cn(
                                      "rounded px-1.5 py-0.5 text-[11px] font-semibold",
                                      val
                                        ? "bg-gdb-okbg text-gdb-okfg"
                                        : "bg-gdb-dangerbg text-gdb-dangerfg"
                                    )}
                                  >
                                    {String(val)}
                                  </span>
                                ) : typeof val === "object" ? (
                                  <span className="rounded bg-gdb-accent/15 px-1.5 py-0.5 text-[11px] text-gdb-accent">
                                    {Array.isArray(val) ? `[${val.length}]` : "{…}"}
                                  </span>
                                ) : (
                                  String(val)
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })()
        ) : (
          <div className="flex flex-col gap-2.5">
            {resultado?.documentos.map((doc, i) => {
              const clave = claveDe(doc, pagina * porPagina + i);
              return (
                <TarjetaDeDocumento
                  key={clave}
                  doc={conBorrador(doc, clave)}
                  original={doc}
                  indice={pagina * porPagina + i + 1}
                  vista={vista}
                  editable={!readOnly}
                  guardando={Boolean(guardando[clave])}
                  error={erroresDoc[clave] ?? null}
                  onCambio={(campo, valor) => editarCampo(clave, campo, valor)}
                  onRevertir={() => revertir(clave)}
                  onGuardar={() => void guardar(doc, clave)}
                  onEditarJson={() => abrirDialogo("editar", doc)}
                  onDuplicar={() => abrirDialogo("duplicar", doc)}
                  onBorrar={() => {
                    setBorrarError(null);
                    setPorBorrar(doc);
                  }}
                />
              );
            })}
          </div>
        )}
      </div>

      <MongoDocumentDialog
        abierto={dialogo !== null}
        modo={dialogo?.modo ?? "insertar"}
        textoInicial={dialogo?.texto ?? "{}"}
        onCerrar={() => setDialogo(null)}
        onGuardar={(documento) => void guardarDialogo(documento)}
        guardando={dialogoGuardando}
        errorServidor={dialogoError}
      />

      <MongoBorrarDialog
        abierto={porBorrar !== null}
        resumen={porBorrar?._id !== undefined ? `_id: ${JSON.stringify(porBorrar._id)}` : ""}
        onCerrar={() => setPorBorrar(null)}
        onConfirmar={() => void borrarDocumento()}
        borrando={borrando}
        error={borrarError}
      />
    </div>
  );
}
