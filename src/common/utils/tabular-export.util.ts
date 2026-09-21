import { strToU8, zipSync } from 'fflate';

/** A cell is text, a number (kept numeric so Excel can sum it) or empty. */
export type Cell = string | number | null | undefined;

export interface ExportSheet {
  name: string;
  columns: { header: string; width?: number }[];
  rows: Cell[][];
}

/** Characters XML 1.0 does not allow (control characters and the two non-characters). */
const XML_ILLEGAL = new RegExp('[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]', 'g');
const BOM = String.fromCharCode(0xfeff);

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Strips characters XML 1.0 forbids and escapes the rest. */
function xml(text: string): string {
  return text
    .replace(XML_ILLEGAL, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 0 -> A, 25 -> Z, 26 -> AA */
function colName(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Excel sheet names: at most 31 chars, none of []:*?/\ and unique (case-insensitive). */
export function sheetNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.map((raw, i) => {
    const base = raw.replace(/[\[\]:*?/\\]/g, ' ').trim().slice(0, 28) || `Sheet${i + 1}`;
    let name = base;
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${base.slice(0, 26)} ${n}`;
    seen.add(name.toLowerCase());
    return name;
  });
}

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

/**
 * A small, dependency-free .xlsx writer: one worksheet per sheet, a bold frozen header row,
 * column widths, numbers kept numeric, and `rtl` to open right-to-left for Arabic. Strings
 * are inline (never formulas), so a cell that starts with "=" cannot execute in Excel.
 */
export function buildXlsx(sheets: ExportSheet[], opts: { rtl?: boolean } = {}): Uint8Array {
  const names = sheetNames(sheets.map((s) => s.name));
  const files: Record<string, Uint8Array> = {};

  const overrides = sheets
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join('');
  files['[Content_Types].xml'] = strToU8(
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides}</Types>`,
  );
  files['_rels/.rels'] = strToU8(
    `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  files['xl/workbook.xml'] = strToU8(
    `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>${names
      .map((n, i) => `<sheet name="${xml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets></workbook>`,
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">${sheets
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join('')}<Relationship Id="rId${sheets.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/></Relationships>`,
  );
  files['xl/styles.xml'] = strToU8(
    `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8F1EC"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  );

  sheets.forEach((sheet, si) => {
    const cols = sheet.columns
      .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 16}" customWidth="1"/>`)
      .join('');
    const head = sheet.columns
      .map((c, i) => `<c r="${colName(i)}1" s="1" t="inlineStr"><is><t xml:space="preserve">${xml(c.header)}</t></is></c>`)
      .join('');
    const body = sheet.rows
      .map((row, ri) => {
        const r = ri + 2;
        const cells = row
          .map((v, ci) => {
            const ref = `${colName(ci)}${r}`;
            if (v === null || v === undefined || v === '') return '';
            if (typeof v === 'number') {
              return Number.isFinite(v) ? `<c r="${ref}" s="${Number.isInteger(v) ? 0 : 2}"><v>${v}</v></c>` : '';
            }
            return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
          })
          .join('');
        return `<row r="${r}">${cells}</row>`;
      })
      .join('');
    files[`xl/worksheets/sheet${si + 1}.xml`] = strToU8(
      `${XML_HEAD}<worksheet xmlns="${NS_MAIN}"><sheetViews><sheetView workbookViewId="0"${opts.rtl ? ' rightToLeft="1"' : ''}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData><row r="1">${head}</row>${body}</sheetData></worksheet>`,
    );
  });
  return zipSync(files, { level: 6 });
}

/** One CSV cell. Text that could be read as a formula gets a leading quote; numbers stay numeric. */
export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** UTF-8 with BOM (Excel opens Arabic correctly) and CRLF line ends. */
export function buildCsv(sheet: ExportSheet): string {
  const lines = [sheet.columns.map((c) => csvCell(c.header)).join(',')];
  for (const row of sheet.rows) lines.push(row.map(csvCell).join(','));
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/** Every sheet as its own CSV inside a zip. */
export function buildCsvZip(sheets: ExportSheet[]): Uint8Array {
  const names = sheetNames(sheets.map((s) => s.name));
  const files: Record<string, Uint8Array> = {};
  sheets.forEach((s, i) => {
    files[`${String(i + 1).padStart(2, '0')}-${names[i].replace(/\s+/g, '_')}.csv`] = strToU8(buildCsv(s));
  });
  return zipSync(files, { level: 6 });
}
