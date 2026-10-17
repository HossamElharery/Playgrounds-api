import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enrichArticleImages } from './blog-images';
const sharp: typeof import('sharp').default = require('sharp');

describe('enrichArticleImages', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'blog-img-'));
    await mkdir(join(root, 'partner-photos'), { recursive: true });
    const png = await sharp({
      create: { width: 120, height: 90, channels: 3, background: '#fff' },
    })
      .png()
      .toBuffer();
    await writeFile(join(root, 'partner-photos', 'abc-1.png'), png);
  });

  it('adds size, alt and lazy loading to an upload image', async () => {
    const out = await enrichArticleImages(
      '<p>x</p><img src="https://api.matchena.com/uploads/partner-photos/abc-1.png">',
      'Title "q"',
      root,
    );
    expect(out).toContain('width="120"');
    expect(out).toContain('height="90"');
    expect(out).toContain('alt="Title &quot;q&quot;"');
    expect(out).toContain('loading="lazy"');
  });

  it('keeps existing attributes, including an empty decorative alt', async () => {
    const tag =
      '<img alt="" width="10" height="5" loading="eager" decoding="sync" src="/uploads/partner-photos/abc-1.png">';
    expect(await enrichArticleImages(tag, 'Title', root)).toBe(tag);
  });

  it('leaves external or missing images without a size', async () => {
    const out = await enrichArticleImages(
      '<img src="https://x.test/a.png">',
      'T',
      root,
    );
    expect(out).not.toContain('width=');
    expect(out).toContain('alt="T"');
  });
});
