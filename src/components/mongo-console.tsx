import * as React from "react";
import { IjIcon } from "@/components/ij-icon";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getSchema, mongoCount, mongoFields, mongoFind, mongoInsert } from "@/lib/api";
import {
  aplicarCandidato,
  candidatosEn,
  contextoEn,
  type Candidato,
} from "@/lib/mongo-completion";
import { useAppDispatch } from "@/hooks/use-app-state";
import { highlightMongoLines } from "@/lib/mongo-console-highlight";
import { runWithConsoleSession } from "@/lib/session-reconnect-client";
import type { ConsoleBinding, SchemaNode, Session } from "@/lib/types";
import type { MongoFindResult } from "@/shared/mongo-view";
import "@/components/own-editor/own-editor.css";

function HighlightedLines({ text }: { text: string }) {
  const lines = React.useMemo(() => text.split("\n"), [text]);
  const tokensByLine = React.useMemo(() => highlightMongoLines(lines), [lines]);

  return (
    <>
      {lines.map((line, i) => {
        const tokens = tokensByLine[i];
        const parts: React.ReactNode[] = [];
        let cursor = 0;

        for (let j = 0; j < tokens.length; j++) {
          const t = tokens[j];
          if (t.from > cursor) parts.push(line.slice(cursor, t.from));
          parts.push(
            <span key={j} className={t.cls}>
              {line.slice(t.from, t.to)}
            </span>
          );
          cursor = t.to;
        }
        if (cursor < line.length) parts.push(line.slice(cursor));

        return (
          <React.Fragment key={i}>
            {parts.length > 0 ? parts : line}
            {i < lines.length - 1 ? "\n" : line === "" ? "\u200b" : null}
          </React.Fragment>
        );
      })}
    </>
  );
}

type ConsoleOutput =
  | { kind: "docs"; coleccion: string; res: MongoFindResult; ms: number }
  | { kind: "count"; coleccion: string; total: number; ms: number }
  | { kind: "collections"; items: string[]; ms: number }
  | { kind: "inserted"; coleccion: string; id: string; ms: number }
  | { kind: "error"; message: string };

function extraerBloqueBalanceado(texto: string, inicioParen: number): { contenido: string; fin: number } | null {
  if (texto[inicioParen] !== "(") return null;
  let profundidad = 0;
  let enComillas: '"' | "'" | null = null;
  let escapado = false;

  for (let i = inicioParen; i < texto.length; i++) {
    const ch = texto[i];
    if (escapado) {
      escapado = false;
      continue;
    }
    if (ch === "\\" && enComillas) {
      escapado = true;
      continue;
    }
    if ((ch === '"' || ch === "'") && !enComillas) {
      enComillas = ch;
      continue;
    }
    if (ch === enComillas) {
      enComillas = null;
      continue;
    }
    if (enComillas) continue;
    if (ch === "(") profundidad++;
    else if (ch === ")") {
      profundidad--;
      if (profundidad === 0) {
        return { contenido: texto.slice(inicioParen + 1, i).trim(), fin: i };
      }
    }
  }
  return null;
}

function parseMongoCommand(raw: string):
  | { type: "showCollections" }
  | { type: "find"; coleccion: string; filtro: string; orden: string; limit: number }
  | { type: "count"; coleccion: string; filtro: string }
  | { type: "insertOne"; coleccion: string; documento: string }
  | { type: "unsupported"; reason: string } {
  const cmd = raw.trim().replace(/;+\s*$/, "");
  if (!cmd) return { type: "unsupported", reason: "Escribe un comando de MongoDB para ejecutar." };

  if (/^show\s+collections$/i.test(cmd) || /^db\.getCollectionNames\s*\(\s*\)$/i.test(cmd)) {
    return { type: "showCollections" };
  }

  let coleccion = "";
  let resto = "";

  const getCollMatch = /^db\.getCollection\(\s*["']([^"']+)["']\s*\)\.([\s\S]+)$/.exec(cmd);
  if (getCollMatch) {
    coleccion = getCollMatch[1];
    resto = getCollMatch[2].trim();
  } else {
    const dotMatch = /^db\.([A-Za-z0-9_$-]+)\.([\s\S]+)$/.exec(cmd);
    if (!dotMatch) {
      return {
        type: "unsupported",
        reason:
          "Formato no reconocido. Usa: db.coleccion.find({...}).sort({...}).limit(25), db.coleccion.countDocuments({...}), db.coleccion.insertOne({...}) o show collections.",
      };
    }
    coleccion = dotMatch[1];
    resto = dotMatch[2].trim();
  }

  const methodMatch = /^(find|countDocuments|count|insertOne)\s*\(/.exec(resto);
  if (!methodMatch) {
    return {
      type: "unsupported",
      reason: `Método no soportado en la consola actual. Disponibles: find, countDocuments, insertOne y show collections.`,
    };
  }

  const method = methodMatch[1];
  const openIdx = resto.indexOf("(", method.length);
  const args = extraerBloqueBalanceado(resto, openIdx);
  if (!args) {
    return { type: "unsupported", reason: "Paréntesis sin cerrar en el comando." };
  }

  const tail = resto.slice(args.fin + 1);

  if (method === "countDocuments" || method === "count") {
    return { type: "count", coleccion, filtro: args.contenido || "{}" };
  }

  if (method === "insertOne") {
    if (!args.contenido) {
      return { type: "unsupported", reason: "insertOne requiere un documento JSON, ej: db.col.insertOne({ \"nombre\": \"Ana\" })." };
    }
    return { type: "insertOne", coleccion, documento: args.contenido };
  }

  // find(...).sort(...).limit(...)
  let orden = "";
  let limit = 25;
  const sortMatch = /\.sort\s*\(/.exec(tail);
  if (sortMatch) {
    const sortArgs = extraerBloqueBalanceado(tail, sortMatch.index + sortMatch[0].length - 1);
    if (sortArgs) orden = sortArgs.contenido;
  }
  const limitMatch = /\.limit\s*\(\s*(\d+)\s*\)/.exec(tail);
  if (limitMatch) {
    const n = Number(limitMatch[1]);
    if (Number.isFinite(n) && n > 0) limit = Math.min(n, 500);
  }

  return {
    type: "find",
    coleccion,
    filtro: args.contenido || "{}",
    orden,
    limit,
  };
}

interface SugerenciaConsola {
  etiqueta: string;
  detalle: string;
  tipo: "coleccion" | "metodo" | "campo" | "operador";
  reemplazarDesde: number;
  reemplazarHasta: number;
  textoInsertar: string;
  offsetCursor?: number;
}

const METODOS_COLECCION: { nombre: string; insertar: string; offset: number; detalle: string }[] = [
  { nombre: "find", insertar: "find({})", offset: 6, detalle: "Consultar documentos" },
  { nombre: "countDocuments", insertar: "countDocuments({})", offset: 16, detalle: "Contar documentos" },
  { nombre: "insertOne", insertar: "insertOne({})", offset: 11, detalle: "Insertar un documento" },
];

const METODOS_ENCADENADOS: { nombre: string; insertar: string; offset: number; detalle: string }[] = [
  { nombre: "sort", insertar: "sort({})", offset: 6, detalle: "Ordenar resultados" },
  { nombre: "limit", insertar: "limit(25)", offset: 8, detalle: "Limitar documentos" },
];

function extraerColeccionActiva(textoAntes: string): string | null {
  const getColl = /db\.getCollection\(\s*["']([^"']+)["']\s*\)/.exec(textoAntes);
  if (getColl) return getColl[1];
  const dot = /db\.([A-Za-z0-9_$-]+)\./.exec(textoAntes);
  return dot ? dot[1] : null;
}

function sugerenciasEn(
  comando: string,
  cursor: number,
  colecciones: string[],
  camposPorColeccion: Record<string, string[]>
): SugerenciaConsola[] {
  const antes = comando.slice(0, cursor);

  // 1. Encadenado después de `)...` (ej: `.find({}).s`)
  const chainMatch = /\)\s*\.([A-Za-z0-9_]*)$/.exec(antes);
  if (chainMatch) {
    const pref = chainMatch[1].toLowerCase();
    const desde = cursor - chainMatch[1].length;
    return METODOS_ENCADENADOS.filter((m) => m.nombre.toLowerCase().startsWith(pref)).map((m) => ({
      etiqueta: `${m.nombre}()`,
      detalle: m.detalle,
      tipo: "metodo" as const,
      reemplazarDesde: desde,
      reemplazarHasta: cursor,
      textoInsertar: m.insertar,
      offsetCursor: m.offset,
    }));
  }

  // 2. Método después de `db.coleccion.`
  const methodMatch =
    /db\.(?:[A-Za-z0-9_$-]+|getCollection\(\s*["'][^"']+["']\s*\))\.([A-Za-z0-9_]*)$/.exec(antes);
  if (methodMatch) {
    const pref = methodMatch[1].toLowerCase();
    const desde = cursor - methodMatch[1].length;
    return METODOS_COLECCION.filter((m) => m.nombre.toLowerCase().startsWith(pref)).map((m) => ({
      etiqueta: `${m.nombre}()`,
      detalle: m.detalle,
      tipo: "metodo" as const,
      reemplazarDesde: desde,
      reemplazarHasta: cursor,
      textoInsertar: m.insertar,
      offsetCursor: m.offset,
    }));
  }

  // 3. Colección después de `db.`
  const collMatch = /(?:^|[\s;])db\.([A-Za-z0-9_$-]*)$/.exec(antes);
  if (collMatch) {
    const pref = collMatch[1].toLowerCase();
    const desde = cursor - collMatch[1].length;
    return colecciones
      .filter((c) => c.toLowerCase().includes(pref))
      .slice(0, 12)
      .map((c) => ({
        etiqueta: c,
        detalle: "Colección",
        tipo: "coleccion" as const,
        reemplazarDesde: desde,
        reemplazarHasta: cursor,
        textoInsertar: `${c}.`,
      }));
  }

  // 4. Dentro de un argumento `{ ... }` (campos reales + operadores Mongo)
  const lastOpenBrace = antes.lastIndexOf("{");
  const lastCloseBrace = antes.lastIndexOf("}");
  if (lastOpenBrace !== -1 && lastOpenBrace > lastCloseBrace) {
    const subTexto = comando.slice(lastOpenBrace);
    const subCursor = cursor - lastOpenBrace;
    const ctx = contextoEn(subTexto, subCursor);
    const colActiva = extraerColeccionActiva(antes);
    const campos = colActiva ? camposPorColeccion[colActiva] ?? [] : [];
    const cands: Candidato[] = candidatosEn(ctx, campos);
    return cands.slice(0, 12).map((c) => {
      const ed = aplicarCandidato(subTexto, subCursor, ctx.desde, c.insercion);
      return {
        etiqueta: c.etiqueta,
        detalle: c.detalle ?? "",
        tipo: c.tipo === "campo" ? ("campo" as const) : ("operador" as const),
        reemplazarDesde: lastOpenBrace,
        reemplazarHasta: comando.length,
        textoInsertar: ed.texto,
        offsetCursor: ed.cursor,
      };
    });
  }

  return [];
}

export function MongoConsole({
  consoleId,
  session,
  binding,
}: {
  consoleId: string;
  session: Session;
  binding?: ConsoleBinding | null;
}) {
  const dispatch = useAppDispatch();
  const sessionRef = React.useRef(session);
  const bindingRef = React.useRef(binding);
  const loadedSchemaSessionRef = React.useRef<string | null>(null);
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

  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const backdropRef = React.useRef<HTMLPreElement | null>(null);
  const [colecciones, setColecciones] = React.useState<string[]>([]);
  const [camposPorColeccion, setCamposPorColeccion] = React.useState<Record<string, string[]>>({});
  const [cargando, setCargando] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [comando, setComando] = React.useState("show collections");
  const [cursor, setCursor] = React.useState(0);
  const [acAbierto, setAcAbierto] = React.useState(false);
  const [acIndice, setAcIndice] = React.useState(0);
  const [ejecutando, setEjecutando] = React.useState(false);
  const [salida, setSalida] = React.useState<ConsoleOutput | null>(null);
  const [copiado, setCopiado] = React.useState(false);

  const colEnCurso = React.useMemo(
    () => extraerColeccionActiva(comando.slice(0, cursor)),
    [comando, cursor]
  );

  React.useEffect(() => {
    if (!colEnCurso || !colecciones.includes(colEnCurso) || camposPorColeccion[colEnCurso]) {
      return;
    }
    let vivo = true;
    mongoFields({ sessionId: session.sessionId, coleccion: colEnCurso })
      .then(({ campos }) => {
        if (vivo) {
          setCamposPorColeccion((prev) => ({ ...prev, [colEnCurso]: campos }));
        }
      })
      .catch(() => {
        // Sin campos el autocompletado sigue ofreciendo operadores.
      });
    return () => {
      vivo = false;
    };
  }, [colEnCurso, colecciones, camposPorColeccion, session.sessionId]);

  const sugerencias = React.useMemo(
    () => (acAbierto ? sugerenciasEn(comando, cursor, colecciones, camposPorColeccion) : []),
    [acAbierto, comando, cursor, colecciones, camposPorColeccion]
  );
  const indiceActivo = sugerencias.length ? Math.min(acIndice, sugerencias.length - 1) : 0;

  function aceptarSugerencia(sug: SugerenciaConsola) {
    const nuevoValor =
      comando.slice(0, sug.reemplazarDesde) +
      sug.textoInsertar +
      comando.slice(sug.reemplazarHasta);
    const nuevoCursor =
      sug.reemplazarDesde + (sug.offsetCursor ?? sug.textoInsertar.length);
    setComando(nuevoValor);
    setCursor(nuevoCursor);
    setAcIndice(0);
    setAcAbierto(sug.tipo === "coleccion");
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nuevoCursor, nuevoCursor);
    });
  }

  React.useEffect(() => {
    const schemaKey = `${session.sessionId}:${session.database ?? ""}`;
    if (loadedSchemaSessionRef.current === schemaKey) {
      return;
    }
    let vivo = true;
    (async () => {
      try {
        const { result: esquema, session: activeSession } = await runWithSession<SchemaNode[]>(
          (s) => getSchema(s.sessionId)
        );
        if (!vivo) return;
        loadedSchemaSessionRef.current = `${activeSession.sessionId}:${activeSession.database ?? ""}`;
        setError(null);
        const lista = (esquema[0]?.tables ?? []).map((t) => t.name);
        setColecciones(lista);
        if (lista.length > 0) {
          setComando((prev) =>
            prev === "show collections" ? `db.${lista[0]}.find({}).limit(25)` : prev
          );
        }
      } catch (err) {
        if (vivo) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (vivo) setCargando(false);
      }
    })();
    return () => {
      vivo = false;
    };
  }, [session.sessionId, session.database, runWithSession]);

  const ejecutar = React.useCallback(async () => {
    const parsed = parseMongoCommand(comando);
    if (parsed.type === "unsupported") {
      setSalida({ kind: "error", message: parsed.reason });
      return;
    }

    let docObj: Record<string, unknown> | undefined;
    if (parsed.type === "insertOne") {
      try {
        const v = JSON.parse(parsed.documento) as unknown;
        if (!v || typeof v !== "object" || Array.isArray(v)) {
          throw new Error("El documento debe ser un objeto JSON válido.");
        }
        docObj = v as Record<string, unknown>;
      } catch (parseErr) {
        const msg =
          parseErr instanceof Error ? `JSON inválido: ${parseErr.message}` : "JSON inválido";
        setSalida({ kind: "error", message: msg.replace(/^Error:\s*/, "") });
        return;
      }
    }

    setEjecutando(true);
    const t0 = performance.now();
    try {
      const { result: nextSalida } = await runWithSession<ConsoleOutput>(async (activeSession) => {
        if (parsed.type === "showCollections") {
          const esquema = await getSchema(activeSession.sessionId);
          const items = (esquema[0]?.tables ?? []).map((t) => t.name);
          return { kind: "collections", items, ms: Math.round(performance.now() - t0) };
        }
        if (parsed.type === "count") {
          const { total } = await mongoCount({
            sessionId: activeSession.sessionId,
            coleccion: parsed.coleccion,
            filtro: parsed.filtro,
          });
          return {
            kind: "count",
            coleccion: parsed.coleccion,
            total,
            ms: Math.round(performance.now() - t0),
          };
        }
        if (parsed.type === "insertOne") {
          if (!docObj) {
            throw new Error("El documento debe ser un objeto JSON válido.");
          }
          const { documento: insertado } = await mongoInsert({
            sessionId: activeSession.sessionId,
            coleccion: parsed.coleccion,
            documento: docObj,
          });
          return {
            kind: "inserted",
            coleccion: parsed.coleccion,
            id: String(insertado._id ?? "ok"),
            ms: Math.round(performance.now() - t0),
          };
        }
        const res = await mongoFind({
          sessionId: activeSession.sessionId,
          coleccion: parsed.coleccion,
          filtro: parsed.filtro,
          orden: parsed.orden || undefined,
          skip: 0,
          limit: parsed.limit,
        });
        return {
          kind: "docs",
          coleccion: parsed.coleccion,
          res,
          ms: Math.round(performance.now() - t0),
        };
      });

      if (nextSalida.kind === "collections") {
        setColecciones(nextSalida.items);
      }
      setSalida(nextSalida);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSalida({ kind: "error", message: msg.replace(/^Error:\s*/, "") });
    } finally {
      setEjecutando(false);
    }
  }, [comando, runWithSession]);

  const primeraCol = colecciones[0] ?? "coleccion";

  const salidaJson = React.useMemo(() => {
    if (!salida) return "";
    if (salida.kind === "docs") return JSON.stringify(salida.res.documentos, null, 2);
    if (salida.kind === "collections") return JSON.stringify(salida.items, null, 2);
    if (salida.kind === "count") return JSON.stringify({ coleccion: salida.coleccion, total: salida.total }, null, 2);
    if (salida.kind === "inserted") return JSON.stringify({ insertedId: salida.id }, null, 2);
    return salida.message;
  }, [salida]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-gdb-editor">
      {/* Barra contextual de la consola Mongo */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gdb-sep bg-gdb-chrome px-3 py-1.5">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => void ejecutar()}
            disabled={ejecutando}
            title="Ejecutar comando MongoDB (Cmd/Ctrl+⏎)"
            className="h-7 gap-1.5 bg-primary px-2.5 text-primary-foreground hover:bg-primary/90"
          >
            <IjIcon name="run" />
            {ejecutando ? "Ejecutando…" : "Ejecutar"}
          </Button>
          <span className="h-4 w-px bg-gdb-sep" aria-hidden />
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setComando(`db.${primeraCol}.find({}).limit(25)`)}
            className="h-6 font-jetbrains text-[11px] text-gdb-fgdim hover:text-gdb-fgstrong"
          >
            find()
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setComando(`db.${primeraCol}.countDocuments({})`)}
            className="h-6 font-jetbrains text-[11px] text-gdb-fgdim hover:text-gdb-fgstrong"
          >
            countDocuments()
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setComando("show collections")}
            className="h-6 font-jetbrains text-[11px] text-gdb-fgdim hover:text-gdb-fgstrong"
          >
            show collections
          </Button>
        </div>

        <div className="flex items-center gap-2 text-xs text-gdb-fgdim">
          <IjIcon name="mongodb" className="size-3.5 text-gdb-enginemongo" />
          <span className="font-jetbrains text-[11px] text-gdb-fg">
            {session.name} · {session.database || "sin base"}
          </span>
        </div>
      </div>

      {/* Editor MQL con autocompletado */}
      <div className="relative border-b border-gdb-sep bg-gdb-editor p-3">
        <div className="relative overflow-hidden rounded border border-gdb-sep bg-gdb-field focus-within:border-gdb-accent">
          <pre
            ref={backdropRef}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words p-2.5 font-jetbrains text-xs leading-relaxed text-gdb-fgstrong"
          >
            <HighlightedLines text={comando} />
          </pre>
          <textarea
            ref={textareaRef}
            value={comando}
            onScroll={(e) => {
              if (backdropRef.current) {
                backdropRef.current.scrollTop = e.currentTarget.scrollTop;
                backdropRef.current.scrollLeft = e.currentTarget.scrollLeft;
              }
            }}
            onChange={(e) => {
              setComando(e.target.value);
              setCursor(e.target.selectionStart ?? e.target.value.length);
              setAcAbierto(true);
              setAcIndice(0);
            }}
            onClick={(e) => {
              setCursor(e.currentTarget.selectionStart ?? comando.length);
            }}
            onBlur={() => {
              setTimeout(() => setAcAbierto(false), 120);
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                setAcAbierto(false);
                void ejecutar();
                return;
              }
              if (e.ctrlKey && e.code === "Space") {
                e.preventDefault();
                setCursor(e.currentTarget.selectionStart ?? comando.length);
                setAcAbierto(true);
                return;
              }
              if (sugerencias.length > 0 && acAbierto) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setAcIndice((i) => (i + 1) % sugerencias.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setAcIndice((i) => (i - 1 + sugerencias.length) % sugerencias.length);
                  return;
                }
                if (e.key === "Tab" || e.key === "Enter") {
                  e.preventDefault();
                  aceptarSugerencia(sugerencias[indiceActivo]);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setAcAbierto(false);
                  return;
                }
              }
            }}
            rows={4}
            spellCheck={false}
            aria-label="Consola de comandos MongoDB"
            placeholder={`db.${primeraCol}.find({ "activo": true }).sort({ "_id": -1 }).limit(25)`}
            className="relative z-10 block w-full resize-y bg-transparent p-2.5 font-jetbrains text-xs leading-relaxed text-transparent caret-gdb-fgstrong outline-none placeholder:text-gdb-fgmuted selection:bg-gdb-accent/25"
          />
        </div>
        {acAbierto && sugerencias.length > 0 && (
          <div
            role="listbox"
            aria-label="Sugerencias de MongoDB"
            className="absolute right-3 left-3 z-40 mt-1 max-h-48 overflow-y-auto rounded-md border border-gdb-border bg-popover p-1 shadow-lg"
          >
            {sugerencias.map((sug, i) => (
              <button
                key={`${sug.tipo}:${sug.etiqueta}`}
                type="button"
                role="option"
                aria-selected={i === indiceActivo}
                onMouseDown={(e) => {
                  e.preventDefault();
                  aceptarSugerencia(sug);
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded px-2 py-1 text-left font-jetbrains text-xs",
                  i === indiceActivo
                    ? "bg-gdb-listsel text-gdb-fgstrong"
                    : "text-gdb-fg hover:bg-gdb-hover"
                )}
              >
                <span className="flex items-center gap-2 truncate">
                  <span
                    className={cn(
                      "rounded px-1 text-[9.5px] uppercase",
                      sug.tipo === "coleccion"
                        ? "bg-gdb-okbg text-gdb-okfg"
                        : sug.tipo === "metodo"
                          ? "bg-gdb-accent/15 text-gdb-accent"
                          : sug.tipo === "operador"
                            ? "bg-gdb-contrast text-gdb-const"
                            : "bg-gdb-contrast text-gdb-fgdim"
                    )}
                  >
                    {sug.tipo}
                  </span>
                  <span className="truncate font-medium">{sug.etiqueta}</span>
                </span>
                <span className="shrink-0 text-[10.5px] text-gdb-fgmuted">{sug.detalle}</span>
              </button>
            ))}
          </div>
        )}
        <div className="mt-1.5 flex items-center justify-between text-[11px] text-gdb-fgmuted">
          <span>
            Soporta <code className="text-gdb-fg">find().sort().limit()</code>,{" "}
            <code className="text-gdb-fg">countDocuments()</code>,{" "}
            <code className="text-gdb-fg">insertOne()</code> y{" "}
            <code className="text-gdb-fg">show collections</code>
          </span>
          <span className="font-jetbrains">Tab/⏎ Autocompletar · ⌘⏎ Ejecutar</span>
        </div>
      </div>

      {/* Accesos rápidos a colecciones */}
      <div className="flex items-center gap-1.5 overflow-x-auto border-b border-gdb-sep bg-gdb-chrome/50 px-3 py-1.5 scrollbar-thin">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-gdb-fgmuted">
          Colecciones ({colecciones.length}):
        </span>
        {cargando && <span className="text-[11px] text-gdb-fgmuted">Cargando…</span>}
        {error && <span className="text-[11px] text-gdb-dangerfg">{error}</span>}
        {colecciones.map((nombre) => (
          <button
            key={nombre}
            type="button"
            onClick={() =>
              dispatch({
                type: "OPEN_TABLE_TAB",
                payload: { schema: session.database || "", table: nombre },
              })
            }
            onDoubleClick={() => setComando(`db.${nombre}.find({}).limit(25)`)}
            title={`Clic: abrir colección ${nombre} en pestaña · Doble clic: usar en consola`}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded border border-gdb-sep/80 bg-gdb-editor px-2 py-0.5 font-jetbrains text-[11px] text-gdb-fg transition-colors hover:border-gdb-accent/60 hover:bg-gdb-rowhover"
            )}
          >
            <IjIcon name="table" className="size-3 text-gdb-icotbl" />
            <span>{nombre}</span>
          </button>
        ))}
      </div>

      {/* Salida de la consola */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-gdb-editor">
        {salida ? (
          <>
            <div className="flex items-center justify-between border-b border-gdb-sep bg-gdb-th px-3 py-1 text-[11px] text-gdb-fgdim">
              <span>
                {salida.kind === "docs" &&
                  `${salida.coleccion} · ${salida.res.documentos.length} de ${salida.res.total} documentos · ${salida.ms}ms`}
                {salida.kind === "count" &&
                  `${salida.coleccion} · total: ${salida.total} · ${salida.ms}ms`}
                {salida.kind === "collections" &&
                  `${salida.items.length} colecciones · ${salida.ms}ms`}
                {salida.kind === "inserted" &&
                  `Documento insertado en ${salida.coleccion} · ${salida.ms}ms`}
                {salida.kind === "error" && "Error de ejecución"}
              </span>
              {salida.kind !== "error" && (
                <div className="flex items-center gap-1.5">
                  {salida.kind === "docs" && (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        dispatch({
                          type: "OPEN_TABLE_TAB",
                          payload: { schema: session.database || "", table: salida.coleccion },
                        })
                      }
                      className="h-5 px-2 text-[11px]"
                    >
                      Abrir colección
                    </Button>
                  )}
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      void navigator.clipboard.writeText(salidaJson);
                      setCopiado(true);
                      setTimeout(() => setCopiado(false), 1200);
                    }}
                    className="h-5 px-2 text-[11px]"
                  >
                    {copiado ? "Copiado" : "Copiar JSON"}
                  </Button>
                </div>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3">
              {salida.kind === "error" ? (
                <div className="rounded border border-gdb-dangerborder bg-gdb-dangerbg px-3 py-2 font-jetbrains text-xs text-gdb-dangerfg">
                  {salida.message}
                </div>
              ) : (
                <pre className="select-text whitespace-pre-wrap break-words font-jetbrains text-xs leading-relaxed text-gdb-fgstrong">
                  <HighlightedLines text={salidaJson} />
                </pre>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-gdb-fgmuted">
            Ejecuta un comando arriba con ⌘⏎ o haz clic en una colección para abrir su vista de documentos.
          </div>
        )}
      </div>
    </div>
  );
}
