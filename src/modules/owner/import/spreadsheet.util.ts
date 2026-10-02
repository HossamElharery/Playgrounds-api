import { strFromU8, unzipSync } from 'fflate';

/**
 * Reads the two things an owner actually has: an Excel workbook (.xlsx) or a CSV. Both come back
 * as plain rows of text; deciding what a column MEANS is the mapper's job, so this stays dumb and
 * predictable. No formulas are evaluated and nothing is executed.
 */
export interface SheetTable {
  sheetName: string | null;
  /** Every non-empty row, cells as the text the owner would see (numbers keep their raw value). */
  rows: string[][];
}

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;
const MAX_COLS = 60;

export class SpreadsheetError extends Error {
  constructor(
    readonly code: 'EMPTY' | 'UNSUPPORTED' | 'CORRUPT' | 'TOO_BIG',
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------------------
// Excel (.xlsx)
// ---------------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? '';
  });
}

/** "C12" → 2 (zero-based column). */
export function columnIndex(ref: string): number {
  const letters = /^[A-Za-z]+/.exec(ref)?.[0].toUpperCase() ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Joins every `<t>` run of a string item (rich text is split into runs). */
function textOf(xmlFragment: string): string {
  const parts: string[] = [];
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xmlFragment))) parts.push(decodeXml(m[1]));
  return parts.join('');
}

function sharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const out: string[] = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(textOf(m[1]));
  return out;
}

/** Path of the first worksheet, following workbook.xml → its relationship. */
function firstSheet(files: Record<string, Uint8Array>): { path: string; name: string | null } {
  const wb = files['xl/workbook.xml'] ? strFromU8(files['xl/workbook.xml']) : '';
  const sheetTag = /<sheet\b[^>]*>/.exec(wb)?.[0] ?? '';
  const name = /\bname="([^"]*)"/.exec(sheetTag)?.[1];
  const rid = /\br:id="([^"]*)"/.exec(sheetTag)?.[1];
  const rels = files['xl/_rels/workbook.xml.rels'] ? strFromU8(files['xl/_rels/workbook.xml.rels']) : '';
  if (rid) {
    const re = /<Relationship\b[^>]*>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rels))) {
      if (new RegExp(`\\bId="${rid}"`).test(m[0])) {
        const target = /\bTarget="([^"]*)"/.exec(m[0])?.[1];
        if (target) {
          const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
          if (files[path]) return { path, name: name ? decodeXml(name) : null };
        }
      }
    }
  }
  const fallback = Object.keys(files).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()[0];
  return { path: fallback, name: name ? decodeXml(name) : null };
}

export function readXlsx(bytes: Uint8Array): SheetTable {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      // Only the parts we read, so a hostile zip full of junk costs nothing.
      filter: (f) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(f.name) && f.originalSize < 40 * 1024 * 1024,
    });
  } catch {
    throw new SpreadsheetError('CORRUPT', 'This file could not be opened as an Excel workbook');
  }
  const sheet = firstSheet(files);
  if (!sheet.path || !files[sheet.path]) throw new SpreadsheetError('CORRUPT', 'The workbook has no sheet');
  const strings = sharedStrings(files['xl/sharedStrings.xml'] ? strFromU8(files['xl/sharedStrings.xml']) : undefined);
  const xml = strFromU8(files[sheet.path]);

  const rows: string[][] = [];
  const rowRe = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(xml))) {
    const body = rm[1] ?? '';
    const cells: string[] = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(body))) {
      const attrs = cm[1];
      const inner = cm[2] ?? '';
      const ref = /\br="([A-Za-z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]*)"/.exec(attrs)?.[1];
      const idx = ref ? columnIndex(ref) : cells.length;
      if (idx >= MAX_COLS) continue;
      let value = '';
      if (type === 's') {
        const i = Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]);
        value = Number.isInteger(i) ? (strings[i] ?? '') : '';
      } else if (type === 'inlineStr') {
        value = textOf(inner);
      } else if (type === 'b') {
        value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] === '1' ? 'TRUE' : 'FALSE';
      } else if (type === 'e') {
        value = '';
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        value = v === undefined ? '' : decodeXml(v);
      }
      while (cells.length < idx) cells.push('');
      cells[idx] = value;
    }
    if (cells.some((c) => c.trim() !== '')) rows.push(cells);
    if (rows.length > MAX_IMPORT_ROWS + 1) break;
  }
  if (!rows.length) throw new SpreadsheetError('EMPTY', 'The file has no rows');
  return { sheetName: sheet.name, rows: squareUp(rows) };
}

// ---------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------

/** RFC-4180 style: quoted fields, doubled quotes, newlines inside quotes; delimiter auto-detected. */
export function readCsv(text: string): SheetTable {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].reduce(
    (best, d) => (firstLine.split(d).length > firstLine.split(best).length ? d : best),
    ',',
  );
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i += 1;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row.slice(0, MAX_COLS));
      row = [];
      if (rows.length > MAX_IMPORT_ROWS + 1) break;
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row.slice(0, MAX_COLS));
  if (!rows.length) throw new SpreadsheetError('EMPTY', 'The file has no rows');
  return { sheetName: null, rows: squareUp(rows) };
}

/** Every row the same width, so a ragged export cannot shift a column. */
function squareUp(rows: string[][]): string[][] {
  const width = Math.min(MAX_COLS, rows.reduce((w, r) => Math.max(w, r.length), 0));
  return rows.map((r) => Array.from({ length: width }, (_, i) => (r[i] ?? '').toString()));
}

/** Detects the format from the bytes themselves (a renamed file is still read correctly). */
export function readSpreadsheet(bytes: Uint8Array, fileName?: string): SheetTable {
  if (bytes.byteLength > MAX_IMPORT_BYTES) throw new SpreadsheetError('TOO_BIG', 'The file is bigger than 5 MB');
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip) return readXlsx(bytes);
  if (/\.xls$/i.test(fileName ?? '') || (bytes[0] === 0xd0 && bytes[1] === 0xcf)) {
    throw new SpreadsheetError('UNSUPPORTED', 'Old .xls files are not supported — save as .xlsx or .csv');
  }
  return readCsv(decodeText(bytes));
}

/** UTF-8 when it is valid; otherwise the Windows Arabic code page that Excel's plain "CSV" save uses in Egypt. */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('windows-1256').decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
}
