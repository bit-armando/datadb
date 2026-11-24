import { cellText } from "./cell-value";
import { columnKey } from "./query-columns";
import type { QueryResult } from "./types";

export interface XlsxExportOptions {
  sheetName?: string;
}

export const XLSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const EXCEL_MAX_CELL_CHARS = 32767;
const EXCEL_MAX_SHEET_NAME_CHARS = 31;
const WIDTH_SAMPLE_ROWS = 200;
const MIN_COL_WIDTH = 10;
const MAX_COL_WIDTH = 50;

const NUMERIC_SQL_TYPE_RE =
  /\b(?:(?:tiny|small|medium|big)?int(?:eger|\d*)?|(?:small|big)?serial\d*|numeric|decimal|float\d*|double(?:\s+precision)?|real|(?:small)?money|number)\b/i;

const SAFE_NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

const UTF8_ENCODER = new TextEncoder();

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Converts a 0-based column index to Excel column letters (`0 -> "A"`, `26 -> "AA"`).
 */
export function colIndexToLetters(index: number): string {
  let n = index;
  let result = "";
  while (n >= 0) {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

/**
 * Sanitizes a worksheet name according to Excel constraints:
 * strips `\ / ? * [ ] :`, trims leading/trailing single quotes `'`,
 * truncates to 31 characters, and falls back to `"Resultados"` if empty.
 */
export function sanitizeSheetName(name?: string): string {
  if (!name) return "Resultados";
  const cleaned = name
    .replace(/[\\/?*[\]:]/g, "")
    .trim()
    .replace(/^'+|'+$/g, "")
    .slice(0, EXCEL_MAX_SHEET_NAME_CHARS)
    .replace(/^'+|'+$/g, "")
    .trim();
  return cleaned.length > 0 ? cleaned : "Resultados";
}

function isIllegalXmlCharCode(code: number): boolean {
  return (
    code <= 0x08 ||
    code === 0x0b ||
    code === 0x0c ||
    (code >= 0x0e && code <= 0x1f) ||
    code === 0xfffe ||
    code === 0xffff
  );
}

function stripIllegalXmlChars(text: string): string {
  let out = "";
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    if (isIllegalXmlCharCode(text.charCodeAt(i))) {
      if (last < i) out += text.slice(last, i);
      last = i + 1;
    }
  }
  if (last === 0) return text;
  if (last < text.length) out += text.slice(last);
  return out;
}

function prepareXmlText(text: string): string {
  const stripped = stripIllegalXmlChars(text);
  return stripped.length > EXCEL_MAX_CELL_CHARS
    ? stripped.slice(0, EXCEL_MAX_CELL_CHARS)
    : stripped;
}

function escapeXmlEntities(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Strips illegal XML 1.0 control characters, truncates to Excel's 32,767-char cell limit,
 * and escapes `& < > " '`.
 */
export function escapeXmlText(text: string): string {
  return escapeXmlEntities(prepareXmlText(text));
}

function isNumericSqlType(sqlType: string): boolean {
  const normalized = sqlType.trim().toLowerCase();
  if (!normalized || normalized.endsWith("[]")) return false;
  return NUMERIC_SQL_TYPE_RE.test(normalized);
}

/**
 * Parses a numeric string into a finite JS number only when the column has a numeric SQL type
 * and the value has at most 15 significant digits (Excel IEEE-754 precision limit).
 */
export function parseSafeExcelNumber(value: string, sqlType: string): number | null {
  if (!isNumericSqlType(sqlType)) return null;
  if (!SAFE_NUMBER_RE.test(value)) return null;
  const digits = value.replace(/[-.]/g, "");
  if (digits.length > 15) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildInlineStrCell(ref: string, text: string, styleIndex?: number): string {
  const prepared = prepareXmlText(text);
  const needsPreserve = /^\s|\s$|[\r\n\t]/.test(prepared);
  const escaped = escapeXmlEntities(prepared);
  const styleAttr = styleIndex !== undefined ? ` s="${styleIndex}"` : "";
  const spaceAttr = needsPreserve ? ' xml:space="preserve"' : "";
  return `<c r="${ref}" t="inlineStr"${styleAttr}><is><t${spaceAttr}>${escaped}</t></is></c>`;
}

function computeColumnWidths(
  result: QueryResult,
  keys: readonly string[]
): number[] {
  const sampleCount = Math.min(result.rows.length, WIDTH_SAMPLE_ROWS);
  return result.columns.map((col, colIdx) => {
    let maxLen = col.name.length;
    const key = keys[colIdx];
    for (let r = 0; r < sampleCount; r++) {
      const raw = result.rows[r][key];
      if (raw === null || raw === undefined) continue;
      const text = cellText(raw) ?? "";
      if (text.length > maxLen) {
        maxLen = text.length;
      }
    }
    return Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, maxLen + 3));
  });
}

function buildContentTypesXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    "</Types>"
  );
}

function buildRootRelsXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    "</Relationships>"
  );
}

function buildWorkbookXml(sheetName: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    "<sheets>" +
    `<sheet name="${escapeXmlText(sheetName)}" sheetId="1" r:id="rId1"/>` +
    "</sheets>" +
    "</workbook>"
  );
}

function buildWorkbookRelsXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    "</Relationships>"
  );
}

function buildStylesXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2">' +
    '<font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
    "</fonts>" +
    '<fills count="3">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F4F7"/><bgColor indexed="64"/></patternFill></fill>' +
    "</fills>" +
    '<borders count="2">' +
    "<border><left/><right/><top/><bottom/><diagonal/></border>" +
    '<border><left/><right/><top/><bottom style="thin"><color rgb="FFD0D7DE"/></bottom><diagonal/></border>' +
    "</borders>" +
    '<cellStyleXfs count="1">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>' +
    "</cellStyleXfs>" +
    '<cellXfs count="2">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>' +
    "</cellXfs>" +
    "</styleSheet>"
  );
}

function buildWorksheetXml(result: QueryResult): string {
  const { columns, rows } = result;
  if (columns.length === 0) {
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      "<sheetData/>" +
      "</worksheet>"
    );
  }

  const keys = columns.map((c) => columnKey(c));
  const colLetters = columns.map((_, idx) => colIndexToLetters(idx));
  const lastCol = colLetters[columns.length - 1];
  const lastRow = rows.length + 1;
  const widths = computeColumnWidths(result, keys);

  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    `<dimension ref="A1:${lastCol}${lastRow}"/>`,
    '<sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>',
    "<cols>",
  ];

  for (let i = 0; i < widths.length; i++) {
    const colNum = i + 1;
    parts.push(
      `<col min="${colNum}" max="${colNum}" width="${widths[i]}" customWidth="1"/>`
    );
  }
  parts.push("</cols>", "<sheetData>");

  // Row 1: headers
  parts.push('<row r="1">');
  for (let c = 0; c < columns.length; c++) {
    parts.push(buildInlineStrCell(`${colLetters[c]}1`, columns[c].name, 1));
  }
  parts.push("</row>");

  // Data rows (2..N+1)
  for (let r = 0; r < rows.length; r++) {
    const excelRow = r + 2;
    const row = rows[r];
    parts.push(`<row r="${excelRow}">`);
    for (let c = 0; c < columns.length; c++) {
      const raw = row[keys[c]];
      if (raw === null || raw === undefined) continue;

      const ref = `${colLetters[c]}${excelRow}`;
      if (typeof raw === "boolean") {
        parts.push(`<c r="${ref}" t="b"><v>${raw ? 1 : 0}</v></c>`);
      } else if (typeof raw === "number") {
        if (Number.isFinite(raw)) {
          parts.push(`<c r="${ref}" t="n"><v>${raw}</v></c>`);
        } else {
          parts.push(buildInlineStrCell(ref, String(raw)));
        }
      } else if (typeof raw === "string") {
        const parsed = parseSafeExcelNumber(raw, columns[c].type);
        if (parsed !== null) {
          parts.push(`<c r="${ref}" t="n"><v>${parsed}</v></c>`);
        } else {
          parts.push(buildInlineStrCell(ref, raw));
        }
      } else {
        parts.push(buildInlineStrCell(ref, cellText(raw) ?? ""));
      }
    }
    parts.push("</row>");
  }

  parts.push("</sheetData>");
  if (rows.length > 0) {
    parts.push(`<autoFilter ref="A1:${lastCol}${lastRow}"/>`);
  }
  parts.push("</worksheet>");
  return parts.join("");
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const cs = new CompressionStream("deflate-raw");
    const writer = cs.writable.getWriter();
    const writePromise = (async () => {
      await writer.write(new Uint8Array(data));
      await writer.close();
    })();
    const readPromise = (async () => {
      const reader = cs.readable.getReader();
      const chunks: Uint8Array[] = [];
      let totalLength = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalLength += value.byteLength;
      }
      const out = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    })();
    const [, compressed] = await Promise.all([writePromise, readPromise]);
    return compressed;
  } catch {
    return null;
  }
}

function currentDosTimestamp(): { time: number; date: number } {
  const now = new Date();
  const year = Math.max(1980, now.getFullYear());
  const date = ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const time =
    (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  return { time, date };
}

interface ZipPreparedEntry {
  nameBytes: Uint8Array;
  payload: Uint8Array;
  method: number;
  crc: number;
  uncompressedSize: number;
  compressedSize: number;
  localHeaderOffset: number;
}

async function buildZipArchive(
  files: { name: string; content: string }[]
): Promise<Uint8Array> {
  const { time: dosTime, date: dosDate } = currentDosTimestamp();
  const prepared: ZipPreparedEntry[] = [];
  let localAreaSize = 0;
  let centralDirSize = 0;

  for (const file of files) {
    const nameBytes = UTF8_ENCODER.encode(file.name);
    const uncompressed = UTF8_ENCODER.encode(file.content);
    const crc = crc32(uncompressed);
    const deflated = await deflateRaw(uncompressed);
    const useDeflate =
      deflated !== null && deflated.byteLength < uncompressed.byteLength;
    const payload = useDeflate ? deflated : uncompressed;
    const method = useDeflate ? 8 : 0;

    prepared.push({
      nameBytes,
      payload,
      method,
      crc,
      uncompressedSize: uncompressed.byteLength,
      compressedSize: payload.byteLength,
      localHeaderOffset: localAreaSize,
    });

    localAreaSize += 30 + nameBytes.byteLength + payload.byteLength;
    centralDirSize += 46 + nameBytes.byteLength;
  }

  const totalSize = localAreaSize + centralDirSize + 22;
  const archive = new Uint8Array(totalSize);
  const view = new DataView(archive.buffer);
  let offset = 0;

  // Local file headers + payloads
  for (const entry of prepared) {
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 0x0800, true);
    view.setUint16(offset + 8, entry.method, true);
    view.setUint16(offset + 10, dosTime, true);
    view.setUint16(offset + 12, dosDate, true);
    view.setUint32(offset + 14, entry.crc, true);
    view.setUint32(offset + 18, entry.compressedSize, true);
    view.setUint32(offset + 22, entry.uncompressedSize, true);
    view.setUint16(offset + 26, entry.nameBytes.byteLength, true);
    view.setUint16(offset + 28, 0, true);
    offset += 30;
    archive.set(entry.nameBytes, offset);
    offset += entry.nameBytes.byteLength;
    archive.set(entry.payload, offset);
    offset += entry.payload.byteLength;
  }

  // Central directory headers
  const centralDirOffset = offset;
  for (const entry of prepared) {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 20, true);
    view.setUint16(offset + 8, 0x0800, true);
    view.setUint16(offset + 10, entry.method, true);
    view.setUint16(offset + 12, dosTime, true);
    view.setUint16(offset + 14, dosDate, true);
    view.setUint32(offset + 16, entry.crc, true);
    view.setUint32(offset + 20, entry.compressedSize, true);
    view.setUint32(offset + 24, entry.uncompressedSize, true);
    view.setUint16(offset + 28, entry.nameBytes.byteLength, true);
    view.setUint16(offset + 30, 0, true);
    view.setUint16(offset + 32, 0, true);
    view.setUint16(offset + 34, 0, true);
    view.setUint16(offset + 36, 0, true);
    view.setUint32(offset + 38, 0, true);
    view.setUint32(offset + 42, entry.localHeaderOffset, true);
    offset += 46;
    archive.set(entry.nameBytes, offset);
    offset += entry.nameBytes.byteLength;
  }

  // End of central directory record
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, prepared.length, true);
  view.setUint16(offset + 10, prepared.length, true);
  view.setUint32(offset + 12, centralDirSize, true);
  view.setUint32(offset + 16, centralDirOffset, true);
  view.setUint16(offset + 20, 0, true);

  return archive;
}

/**
 * Generates a native OOXML `.xlsx` workbook in memory as a `Uint8Array`.
 */
export async function buildXlsx(
  result: QueryResult,
  options?: XlsxExportOptions
): Promise<Uint8Array> {
  const sheetName = sanitizeSheetName(options?.sheetName);
  const files = [
    { name: "[Content_Types].xml", content: buildContentTypesXml() },
    { name: "_rels/.rels", content: buildRootRelsXml() },
    { name: "xl/workbook.xml", content: buildWorkbookXml(sheetName) },
    { name: "xl/_rels/workbook.xml.rels", content: buildWorkbookRelsXml() },
    { name: "xl/styles.xml", content: buildStylesXml() },
    { name: "xl/worksheets/sheet1.xml", content: buildWorksheetXml(result) },
  ];
  return buildZipArchive(files);
}
