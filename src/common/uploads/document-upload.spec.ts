import { DOCUMENT_UPLOAD_OPTIONS } from './document-upload';

const run = (mimetype: string) =>
  new Promise<{ err: Error | null; ok?: boolean }>((resolve) => {
    DOCUMENT_UPLOAD_OPTIONS.fileFilter!(null as never, { mimetype } as never, (err, ok) => resolve({ err, ok }));
  });

describe('verification document uploads', () => {
  it.each(['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])('accepts %s', async (type) => {
    expect(await run(type)).toEqual({ err: null, ok: true });
  });
  it('rejects other types with a clear message', async () => {
    const result = await run('image/gif');
    expect(result.ok).toBe(false);
    expect(result.err?.message).toMatch(/Documents must be/);
  });
  it('keeps the 1 MB ceiling', () => {
    expect(DOCUMENT_UPLOAD_OPTIONS.limits?.fileSize).toBe(1024 * 1024);
  });
});
