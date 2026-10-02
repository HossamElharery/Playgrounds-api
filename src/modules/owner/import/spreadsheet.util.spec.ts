import { buildXlsx } from '../../../common/utils/tabular-export.util';
import { decodeText, readCsv, readSpreadsheet, readXlsx, columnIndex, SpreadsheetError } from './spreadsheet.util';

describe('readXlsx', () => {
  it('reads back what our own writer produced (Arabic text, numbers, ragged rows)', () => {
    const bytes = buildXlsx(
      [
        {
          name: 'الحجوزات',
          columns: [{ header: 'التاريخ' }, { header: 'الاسم' }, { header: 'السعر' }],
          rows: [
            ['2026-10-05', 'أحمد "الكابتن" & شركاه', 300],
            ['2026-10-06', '=cmd', 150.5],
            [null, 'بدون تاريخ', null],
          ],
        },
      ],
      { rtl: true },
    );
    const t = readXlsx(bytes);
    expect(t.sheetName).toBe('الحجوزات');
    expect(t.rows[0]).toEqual(['التاريخ', 'الاسم', 'السعر']);
    expect(t.rows[1]).toEqual(['2026-10-05', 'أحمد "الكابتن" & شركاه', '300']);
    // A formula-looking cell stays inert text.
    expect(t.rows[2][1]).toBe('=cmd');
    expect(t.rows[2][2]).toBe('150.5');
    expect(t.rows[3]).toEqual(['', 'بدون تاريخ', '']);
  });

  it('is detected from the bytes even when the file is named .csv', () => {
    const bytes = buildXlsx([{ name: 'S', columns: [{ header: 'a' }], rows: [['x']] }]);
    expect(readSpreadsheet(bytes, 'renamed.csv').rows).toEqual([['a'], ['x']]);
  });

  it('refuses a corrupt workbook, an empty file and an old .xls', () => {
    expect(() => readXlsx(new Uint8Array([0x50, 0x4b, 1, 2, 3]))).toThrow(SpreadsheetError);
    expect(() => readCsv('   \n  \n')).toThrow(SpreadsheetError);
    expect(() => readSpreadsheet(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), 'old.xls')).toThrow(/xlsx/);
  });

  it('column letters become indexes', () => {
    expect([columnIndex('A1'), columnIndex('C12'), columnIndex('AA3')]).toEqual([0, 2, 26]);
  });
});

describe('readCsv', () => {
  it('handles quotes, doubled quotes, newlines in a cell and a BOM', () => {
    const t = readCsv('﻿اسم,ملاحظات\r\n"أحمد, الكبير","قال ""تمام""\nوخلاص"\r\nمحمد,');
    expect(t.rows).toEqual([
      ['اسم', 'ملاحظات'],
      ['أحمد, الكبير', 'قال "تمام"\nوخلاص'],
      ['محمد', ''],
    ]);
  });

  it('detects semicolons and tabs (Excel in Arabic locales)', () => {
    expect(readCsv('a;b;c\n1;2;3').rows[1]).toEqual(['1', '2', '3']);
    expect(readCsv('a\tb\n1\t2').rows[1]).toEqual(['1', '2']);
  });

  it('reads the Windows Arabic code page Excel uses for a plain "CSV" save', () => {
    // "اسم,سعر" in windows-1256
    const bytes = new Uint8Array([0xc7, 0xd3, 0xe3, 0x2c, 0xd3, 0xda, 0xd1]);
    expect(decodeText(bytes)).toBe('اسم,سعر');
    expect(readSpreadsheet(bytes, 'x.csv').rows[0]).toEqual(['اسم', 'سعر']);
  });
});
