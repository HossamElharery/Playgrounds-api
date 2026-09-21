import { unzipSync, strFromU8 } from 'fflate';
import { buildCsv, buildCsvZip, buildXlsx, csvCell, sheetNames } from './tabular-export.util';

const sheet = {
  name: 'Bookings',
  columns: [{ header: 'Code' }, { header: 'Price' }, { header: 'Note' }],
  rows: [
    ['A1', 12.5, '=HYPERLINK("x")'],
    ['B2', -3, 'a & <b>'],
  ],
};

describe('xlsx writer', () => {
  it('writes a valid package: numbers stay numeric, text is inline (never a formula), RTL is honoured', () => {
    const zip = unzipSync(buildXlsx([sheet], { rtl: true }));
    expect(Object.keys(zip)).toEqual(
      expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/styles.xml']),
    );
    const s1 = strFromU8(zip['xl/worksheets/sheet1.xml']);
    expect(s1).toContain('rightToLeft="1"');
    expect(s1).toContain('<c r="B2" s="2"><v>12.5</v></c>');
    expect(s1).toContain('<c r="B3" s="0"><v>-3</v></c>');
    expect(s1).toContain('=HYPERLINK(&quot;x&quot;)');
    expect(s1).not.toContain('<f>');
    expect(s1).toContain('a &amp; &lt;b&gt;');
  });

  it('strips characters XML forbids and keeps sheet names legal and unique', () => {
    const zip = unzipSync(buildXlsx([{ ...sheet, rows: [[`x${String.fromCharCode(1)}y`, 1, '']] }]));
    expect(strFromU8(zip['xl/worksheets/sheet1.xml'])).toContain('>xy<');
    expect(sheetNames(['A/B:C', 'a/b:c', 'x'.repeat(40)])).toEqual(['A B C', 'a b c 2', 'x'.repeat(28)]);
  });
});

describe('csv', () => {
  it('quotes text, guards formulas, keeps numbers numeric (negatives are not formulas)', () => {
    expect(csvCell('=1+1')).toBe(`"'=1+1"`);
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
  });

  it('has a BOM (Arabic opens correctly in Excel) and CRLF, and zips one file per sheet', () => {
    const out = buildCsv({ name: 'x', columns: [{ header: 'الكود' }], rows: [['أ']] });
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out).toContain('\r\n');
    const zip = buildCsvZip([{ name: 'x', columns: [{ header: 'h' }], rows: [] }]);
    expect(Object.keys(unzipSync(zip))).toEqual(['01-x.csv']);
  });
});
