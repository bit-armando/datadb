import * as React from "react";
import { dialectoSql } from "@/shared/connection-net";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CodePreview, type CodePreviewProps } from "./code-preview";
import {
  type ExportFormat,
  formatResult,
  downloadText,
  downloadBinary,
  copyToClipboard,
  extensionForFormat,
} from "@/lib/export-formats";
import { buildXlsx, XLSX_MIME_TYPE } from "@/lib/xlsx-export";
import type { QueryResult, TableContext } from "@/lib/types";
import { useActiveSession } from "@/hooks/use-app-state";
import { DownloadIcon, CopyIcon, FileOutputIcon, EyeIcon } from "lucide-react";

const FORMAT_LABELS: Record<ExportFormat, string> = {
  csv: "CSV",
  xlsx: "Excel (.xlsx)",
  json: "JSON",
  markdown: "Markdown",
  pretty: "Pretty (tabla)",
  sql: "SQL INSERTs",
  "sql-update": "SQL UPDATEs",
  "sql-delete": "SQL DELETEs",
  pandas: "Python pandas",
};

const PREVIEW_LIMIT = 30;

const FORMAT_LANGUAGES: Record<ExportFormat, CodePreviewProps["language"]> = {
  csv: "text",
  xlsx: "text",
  json: "json",
  markdown: "markdown",
  pretty: "text",
  sql: "sql",
  "sql-update": "sql",
  "sql-delete": "sql",
  pandas: "python",
};

interface ResultExporterProps {
  result: QueryResult;
  tableContext?: TableContext | null;
}

export function ResultExporter({ result, tableContext }: ResultExporterProps) {
  /**
   * Fase 14 (D4): el dialecto del SQL exportado es el de la conexión con foco. Sin esto, el
   * INSERT/UPDATE/DELETE salía con comillas invertidas (y `TRUE`/`FALSE`) contra cualquier motor,
   * así que el SQL exportado no ejecutaba ni en Postgres ni en SQL Server.
   */
  const session = useActiveSession();
  const [format, setFormat] = React.useState<ExportFormat>("csv");
  const [tableName, setTableName] = React.useState(() => {
    // Consulta libre: el campo se deja VACÍO a propósito. El formateador pone entonces su nombre
    // por defecto (`tabla`) y avisa en la primera línea de que hay que cambiarlo antes de ejecutar.
    // Antes se rellenaba con `exported_table`, que parecía una tabla real y no lo era: el INSERT se
    // ejecutaba contra una tabla inexistente sin que nada lo dijera.
    if (!tableContext) return "";
    return tableContext.schema
      ? `${tableContext.schema}.${tableContext.table}`
      : tableContext.table;
  });
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [showFullPreview, setShowFullPreview] = React.useState(false);
  const [exportingXlsx, setExportingXlsx] = React.useState(false);

  const pkColumnNames = React.useMemo(
    () => tableContext?.pkColumns.map((c) => c.name) ?? [],
    [tableContext]
  );
  const requiresPk = format === "sql-update" || format === "sql-delete";
  const canGenerate = !requiresPk || pkColumnNames.length > 0;

  function buildContent(): string {
    if (!canGenerate) return "";
    return formatResult(format, result, {
      tableName: format.startsWith("sql") ? tableName : undefined,
      pkColumns: requiresPk ? pkColumnNames : undefined,
      // Fase 14 (T4/D4): el dialecto sale de la sesión con foco, y el esquema va APARTE de la tabla
      // para que el formateador los entrecomille por separado (`"public"."clientes"`). El campo
      // «Tabla» puede venir cualificado (`public.clientes`, que es como se rellena desde una tabla):
      // el formateador respeta lo escrito y en ese caso no duplica el esquema.
      dialecto: dialectoSql(session?.type),
      schema: tableContext?.schema,
    });
  }

  function openPreview() {
    setShowFullPreview(false);
    setPreviewOpen(true);
  }

  async function handleCopy() {
    try {
      await copyToClipboard(buildContent());
      toast.success("Resultado copiado al portapapeles");
    } catch {
      toast.error("No se pudo copiar");
    }
  }

  function handleDownload() {
    const content = buildContent();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `export-${format}-${timestamp}.${extensionForFormat(format)}`;
    downloadText(filename, content);
    toast.success(`Descargado ${filename}`);
    setPreviewOpen(false);
  }

  async function handleDownloadXlsx() {
    setExportingXlsx(true);
    try {
      const bytes = await buildXlsx(result, { sheetName: tableContext?.table });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `export-xlsx-${timestamp}.xlsx`;
      downloadBinary(filename, bytes, XLSX_MIME_TYPE);
      toast.success(`Descargado ${filename}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No se pudo exportar a Excel");
    } finally {
      setExportingXlsx(false);
    }
  }

  const fullContent = format === "xlsx" ? "" : buildContent();
  const allLines = fullContent.split("\n");
  const hasMore = allLines.length > PREVIEW_LIMIT;
  const previewContent = showFullPreview
    ? fullContent
    : allLines.slice(0, PREVIEW_LIMIT).join("\n") +
      (hasMore
        ? `\n\n[... ${allLines.length - PREVIEW_LIMIT} línea(s) más ...]`
        : "");

  return (
    <>
      <div className="flex items-center gap-2">
        <FileOutputIcon className="size-3 text-muted-foreground" />
        <Select
          value={format}
          onValueChange={(v) => setFormat(v as ExportFormat)}
        >
          <SelectTrigger className="h-7 w-36 text-xs" aria-label="Formato de exportación">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(FORMAT_LABELS) as ExportFormat[]).map((f) => (
              <SelectItem key={f} value={f}>
                {FORMAT_LABELS[f]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {format.startsWith("sql") && (
          <div className="flex items-center gap-1">
            <Label className="text-xs text-muted-foreground">Tabla</Label>
            <Input
              value={tableName}
              onChange={(e) => setTableName(e.target.value)}
              className="h-7 w-40 text-xs"
              placeholder="schema.tabla"
            />
          </div>
        )}

        {requiresPk && !canGenerate && (
          <span className="text-xs text-destructive">
            Sin PK detectada: abre esta consulta como tabla de una sola entidad para generar {FORMAT_LABELS[format]}.
          </span>
        )}

        {format === "xlsx" ? (
          <Button
            size="xs"
            variant="outline"
            onClick={handleDownloadXlsx}
            disabled={exportingXlsx || result.columns.length === 0}
          >
            <DownloadIcon className="size-3" />
            {exportingXlsx ? "Exportando…" : "Descargar .xlsx"}
          </Button>
        ) : (
          <Button size="xs" variant="outline" onClick={openPreview} disabled={!canGenerate}>
            <EyeIcon className="size-3" />
            Vista previa
          </Button>
        )}
      </div>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="flex max-h-[60vh] max-w-4xl flex-col overflow-hidden p-4">
          <DialogHeader>
            <DialogTitle>Vista previa — {FORMAT_LABELS[format]}</DialogTitle>
            <DialogDescription>
              {allLines.length} línea(s) en total.
              {hasMore && !showFullPreview && " Mostrando primeras 30."}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-75 flex-1 overflow-auto rounded-md border">
            <CodePreview
              value={previewContent}
              language={FORMAT_LANGUAGES[format]}
              className="h-full min-w-max text-xs"
            />
          </div>

          <DialogFooter className="flex items-center justify-between sm:justify-between">
            <div>
              {hasMore && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setShowFullPreview((v) => !v)}
                >
                  {showFullPreview ? "Mostrar muestra" : "Mostrar todo"}
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2 rounded-lg border bg-muted p-2">
              <Button size="sm" variant="secondary" onClick={handleCopy}>
                <CopyIcon className="size-4" />
                Copiar
              </Button>
              <Button size="sm" variant="default" onClick={handleDownload}>
                <DownloadIcon className="size-4" />
                Descargar
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
