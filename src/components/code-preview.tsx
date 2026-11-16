/**
 * Vista previa de código SOLO LECTURA (JSON, SQL, Markdown, Python o texto).
 *
 * Antes montaba un CodeMirror no editable con `@codemirror/lang-json|sql|markdown|python`. Al
 * quitar CodeMirror (decisión del usuario, 2026-10-20) se reescribe con lo que ya hay en el repo:
 * el lexer propio para SQL/JSON y un `<pre>` por líneas. No es un editor: no acepta foco ni
 * teclado, solo se lee, que es lo que hacía antes con `readOnly`.
 *
 * Markdown y Python salen sin colorear, igual que antes cuando su extensión no estaba disponible:
 * no hay lexer propio para ellos y añadir uno sería código que nadie pidió.
 */
import * as React from "react";
import { highlightLines, type Dialecto } from "@/components/own-editor/highlight";
import { cn } from "@/lib/utils";

export interface CodePreviewProps {
  value: string;
  language: "json" | "sql" | "markdown" | "python" | "text";
  className?: string;
  /** Tamaño de fuente del bloque (CSS), p.ej. "13px". */
  fontSize?: string;
  /** Ajustar líneas largas al ancho del contenedor en vez de mantenerlas en una sola línea. */
  wrapLines?: boolean;
}

/** Dialecto del lexer que le corresponde a cada lenguaje (null = sin colorear). */
const dialectoDe: Record<CodePreviewProps["language"], Dialecto | null> = {
  sql: "standard",
  json: "standard", // el lexer pinta cadenas, números y claves igual de bien
  markdown: null,
  python: null,
  text: null,
};

export function CodePreview({ value, language, className, fontSize, wrapLines }: CodePreviewProps) {
  const lineas = React.useMemo(() => value.split("\n"), [value]);

  const tokens = React.useMemo(() => {
    const dialecto = dialectoDe[language];
    return dialecto ? highlightLines(lineas, dialecto) : lineas.map(() => []);
  }, [lineas, language]);

  return (
    <pre
      className={cn(
        "m-0 h-full overflow-auto bg-transparent p-3 font-mono leading-5 text-gdb-fg",
        className
      )}
      style={fontSize ? { fontSize } : undefined}
      aria-label={`Vista previa de ${language}`}
    >
      <code>
        {lineas.map((linea, i) => {
          const tramos: React.ReactNode[] = [];
          let cursor = 0;
          tokens[i].forEach((t, j) => {
            if (t.from > cursor) tramos.push(linea.slice(cursor, t.from));
            tramos.push(
              <span key={j} className={t.cls}>
                {linea.slice(t.from, t.to)}
              </span>
            );
            cursor = t.to;
          });
          if (cursor < linea.length) tramos.push(linea.slice(cursor));
          return (
            <div key={i} className={cn(wrapLines ? "whitespace-pre-wrap break-words" : "whitespace-pre")}>
              {tramos.length ? tramos : linea || " "}
            </div>
          );
        })}
      </code>
    </pre>
  );
}
