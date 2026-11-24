import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import {
  buildXlsx,
  colIndexToLetters,
  escapeXmlText,
  parseSafeExcelNumber,
  sanitizeSheetName,
} from "./xlsx-export";
import type { QueryResult } from "./types";

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
 * Lightweight ZIP parser that validates EOCD, Central Directory, Local File Headers,
 * and CRC-32 checksums for every entry, returning filename -> UTF-8 contents.
 */
function readZipEntries(zip: Uint8Array): Map<string, string> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });

  // Locate End of Central Directory (0x06054b50)
  let eocdOffset = -1;
  for (let i = zip.byteLength - 22; i >= Math.max(0, zip.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  assert.notEqual(eocdOffset, -1, "End of Central Directory record not found");

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  assert.equal(cdOffset + cdSize, eocdOffset, "Central directory size/offset mismatch");

  const entries = new Map<string, string>();
  let cursor = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    assert.equal(view.getUint32(cursor, true), 0x02014b50, "Invalid Central Directory signature");
    const method = view.getUint16(cursor + 10, true);
    const expectedCrc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const cdName = decoder.decode(zip.subarray(cursor + 46, cursor + 46 + nameLen));
    cursor += 46 + nameLen + extraLen + commentLen;

    // Validate matching Local File Header
    assert.equal(
      view.getUint32(localOffset, true),
      0x04034b50,
      `Invalid Local File Header signature for ${cdName}`
    );
    const lfMethod = view.getUint16(localOffset + 8, true);
    const lfCrc = view.getUint32(localOffset + 14, true);
    const lfCompressedSize = view.getUint32(localOffset + 18, true);
    const lfUncompressedSize = view.getUint32(localOffset + 22, true);
    const lfNameLen = view.getUint16(localOffset + 26, true);
    const lfExtraLen = view.getUint16(localOffset + 28, true);
    const lfName = decoder.decode(
      zip.subarray(localOffset + 30, localOffset + 30 + lfNameLen)
    );

    assert.equal(lfName, cdName);
    assert.equal(lfMethod, method);
    assert.equal(lfCrc, expectedCrc);
    assert.equal(lfCompressedSize, compressedSize);
    assert.equal(lfUncompressedSize, uncompressedSize);

    const payloadStart = localOffset + 30 + lfNameLen + lfExtraLen;
    const payload = zip.subarray(payloadStart, payloadStart + compressedSize);
    let rawBytes: Uint8Array;
    if (method === 0) {
      rawBytes = payload;
    } else if (method === 8) {
      rawBytes = new Uint8Array(inflateRawSync(payload));
    } else {
      assert.fail(`Unsupported compression method ${method} for ${cdName}`);
    }

    assert.equal(rawBytes.byteLength, uncompressedSize, `Size mismatch for ${cdName}`);
    assert.equal(crc32(rawBytes), expectedCrc, `CRC-32 mismatch for ${cdName}`);

    entries.set(cdName, decoder.decode(rawBytes));
  }

  assert.equal(cursor, cdOffset + cdSize, "Central directory end mismatch");
  return entries;
}

describe("xlsx-export helpers", () => {
  test("colIndexToLetters converts 0-based indices accurately", () => {
    assert.equal(colIndexToLetters(0), "A");
    assert.equal(colIndexToLetters(25), "Z");
    assert.equal(colIndexToLetters(26), "AA");
    assert.equal(colIndexToLetters(51), "AZ");
    assert.equal(colIndexToLetters(52), "BA");
    assert.equal(colIndexToLetters(701), "ZZ");
    assert.equal(colIndexToLetters(702), "AAA");
  });

  test("sanitizeSheetName removes forbidden chars, trims quotes, limits to 31 chars, and falls back", () => {
    assert.equal(sanitizeSheetName("clientes"), "clientes");
    assert.equal(sanitizeSheetName("a\\b/c?d*e[f]g:h"), "abcdefgh");
    assert.equal(sanitizeSheetName("  'ventas'  "), "ventas");
    assert.equal(sanitizeSheetName("[]:*?\\/''"), "Resultados");
    assert.equal(sanitizeSheetName(""), "Resultados");
    assert.equal(sanitizeSheetName(undefined), "Resultados");
    assert.equal(sanitizeSheetName("a".repeat(40)), "a".repeat(31));
    assert.equal(sanitizeSheetName("'" + "b".repeat(30) + "'extra"), "b".repeat(30));
  });

  test("escapeXmlText strips control chars, truncates to 32,767 chars before escaping, and escapes entities", () => {
    assert.equal(escapeXmlText(`a&b<c>d"e'f`), "a&amp;b&lt;c&gt;d&quot;e&apos;f");

    const withControls = `hi\u0000\u0008\u000B\u000C\u001F\uFFFE\uFFFF\t\n\rthere`;
    assert.equal(escapeXmlText(withControls), "hi\t\n\rthere");

    const longRaw = "&".repeat(40000);
    const escaped = escapeXmlText(longRaw);
    assert.equal(escaped, "&amp;".repeat(32767));
  });

  test("parseSafeExcelNumber handles numeric types, precision limits, and non-numeric types", () => {
    assert.equal(parseSafeExcelNumber("123.45", "decimal"), 123.45);
    assert.equal(parseSafeExcelNumber("-42", "int4"), -42);
    assert.equal(parseSafeExcelNumber("0", "numeric(10,2)"), 0);
    assert.equal(parseSafeExcelNumber("900719925474099", "bigint"), 900719925474099);
    // 16 digits exceeds Excel 15-digit precision -> preserved as text (null)
    assert.equal(parseSafeExcelNumber("9007199254740993", "bigint"), null);
    assert.equal(parseSafeExcelNumber("00123", "varchar"), null);
    assert.equal(parseSafeExcelNumber("00123", "int4"), null);
    assert.equal(parseSafeExcelNumber("123", "int4[]"), null);
    assert.equal(parseSafeExcelNumber("123", "interval"), null);
  });
});

describe("buildXlsx", () => {
  test("contains all 6 required OOXML parts with valid styles fills order", async () => {
    const result: QueryResult = {
      columns: [
        { name: "id", type: "int4" },
        { name: "nombre", type: "text" },
        { name: "activo", type: "bool" },
        { name: "nota", type: "text" },
        { name: "meta", type: "jsonb" },
      ],
      rows: [
        {
          id: 1,
          nombre: "  Ana & Co <1>  ",
          activo: true,
          nota: null,
          meta: { vip: true },
        },
        {
          id: 2,
          nombre: "Bob",
          activo: false,
          nota: undefined,
          meta: [1, 2],
        },
      ],
      rowCount: 2,
      durationMs: 1,
      limitApplied: false,
      effectiveLimit: 2,
    };

    const bytes = await buildXlsx(result, { sheetName: "usuarios:2026" });
    const entries = readZipEntries(bytes);

    const expectedFiles = [
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
    ];
    for (const file of expectedFiles) {
      assert.ok(entries.has(file), `Missing OOXML entry ${file}`);
    }

    const workbook = entries.get("xl/workbook.xml")!;
    assert.ok(workbook.includes('name="usuarios2026"'), workbook);

    const styles = entries.get("xl/styles.xml")!;
    const noneIdx = styles.indexOf('patternType="none"');
    const grayIdx = styles.indexOf('patternType="gray125"');
    const customIdx = styles.indexOf('rgb="FFF2F4F7"');
    assert.ok(noneIdx !== -1 && grayIdx !== -1 && customIdx !== -1, styles);
    assert.ok(noneIdx < grayIdx && grayIdx < customIdx, styles);

    const sheet = entries.get("xl/worksheets/sheet1.xml")!;
    assert.ok(sheet.includes('<dimension ref="A1:E3"/>'), sheet);
    assert.ok(sheet.includes('state="frozen"'), sheet);
    assert.ok(sheet.includes('<autoFilter ref="A1:E3"/>'), sheet);
    assert.ok(sheet.includes('<c r="A2" t="n"><v>1</v></c>'), sheet);
    assert.ok(
      sheet.includes(
        '<c r="B2" t="inlineStr"><is><t xml:space="preserve">  Ana &amp; Co &lt;1&gt;  </t></is></c>'
      ),
      sheet
    );
    assert.ok(sheet.includes('<c r="C2" t="b"><v>1</v></c>'), sheet);
    assert.ok(sheet.includes('<c r="C3" t="b"><v>0</v></c>'), sheet);
    assert.ok(!sheet.includes('r="D2"'), "null cell should be omitted");
    assert.ok(!sheet.includes('r="D3"'), "undefined cell should be omitted");
    assert.ok(
      sheet.includes('<c r="E2" t="inlineStr"><is><t>{&quot;vip&quot;:true}</t></is></c>'),
      sheet
    );
  });

  test("preserves distinct values for duplicate column names via columnKey", async () => {
    const result: QueryResult = {
      columns: [
        { name: "name", type: "varchar" },
        { name: "name", key: "name_2", type: "varchar" },
      ],
      rows: [{ name: "Banco Uno", name_2: "Cuenta A" }],
      rowCount: 1,
      durationMs: 0,
      limitApplied: false,
      effectiveLimit: 1,
    };

    const entries = readZipEntries(await buildXlsx(result));
    const sheet = entries.get("xl/worksheets/sheet1.xml")!;

    assert.ok(
      sheet.includes('<c r="A1" t="inlineStr" s="1"><is><t>name</t></is></c>'),
      sheet
    );
    assert.ok(
      sheet.includes('<c r="B1" t="inlineStr" s="1"><is><t>name</t></is></c>'),
      sheet
    );
    assert.ok(
      sheet.includes('<c r="A2" t="inlineStr"><is><t>Banco Uno</t></is></c>'),
      sheet
    );
    assert.ok(
      sheet.includes('<c r="B2" t="inlineStr"><is><t>Cuenta A</t></is></c>'),
      sheet
    );
  });

  test("handles numeric strings vs precision-sensitive strings properly", async () => {
    const result: QueryResult = {
      columns: [
        { name: "monto", type: "decimal(10,2)" },
        { name: "big_id", type: "bigint" },
        { name: "codigo", type: "varchar" },
      ],
      rows: [
        {
          monto: "123.45",
          big_id: "9007199254740993",
          codigo: "00123",
        },
      ],
      rowCount: 1,
      durationMs: 0,
      limitApplied: false,
      effectiveLimit: 1,
    };

    const entries = readZipEntries(await buildXlsx(result));
    const sheet = entries.get("xl/worksheets/sheet1.xml")!;

    assert.ok(sheet.includes('<c r="A2" t="n"><v>123.45</v></c>'), sheet);
    assert.ok(
      sheet.includes('<c r="B2" t="inlineStr"><is><t>9007199254740993</t></is></c>'),
      sheet
    );
    assert.ok(
      sheet.includes('<c r="C2" t="inlineStr"><is><t>00123</t></is></c>'),
      sheet
    );
  });

  test("handles empty rows (headers present, no autoFilter)", async () => {
    const result: QueryResult = {
      columns: [
        { name: "id", type: "int4" },
        { name: "email", type: "text" },
      ],
      rows: [],
      rowCount: 0,
      durationMs: 0,
      limitApplied: false,
      effectiveLimit: 100,
    };

    const entries = readZipEntries(await buildXlsx(result));
    const sheet = entries.get("xl/worksheets/sheet1.xml")!;

    assert.ok(sheet.includes('<dimension ref="A1:B1"/>'), sheet);
    assert.ok(sheet.includes('<c r="A1" t="inlineStr" s="1">'), sheet);
    assert.ok(sheet.includes('<c r="B1" t="inlineStr" s="1">'), sheet);
    assert.ok(!sheet.includes("<autoFilter"), sheet);
  });
});
