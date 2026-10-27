import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3StorageProvider } from './s3-storage.provider';

describe('S3StorageProvider files', () => {
  const config = { get: (key: string, fallback?: string) => ({ S3_BUCKET: 'b', AWS_REGION: 'eu-west-1' })[key] ?? fallback };
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 's3-spec-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('streams an object to disk piece by piece', async () => {
    const provider = new S3StorageProvider(config as never);
    async function* body() {
      yield Buffer.from('ab');
      yield Buffer.from('cd');
    }
    jest.spyOn((provider as unknown as { client: { send: () => unknown } }).client, 'send').mockResolvedValue({ Body: body() } as never);
    const target = join(dir, 'out.mp4');
    await provider.readObjectToFile('posts/x.mp4', target);
    expect(readFileSync(target, 'utf8')).toBe('abcd');
  });

  it('uploads a file as a stream with its length', async () => {
    const provider = new S3StorageProvider(config as never);
    const send = jest
      .spyOn((provider as unknown as { client: { send: (c: unknown) => unknown } }).client, 'send')
      .mockResolvedValue({} as never);
    const source = join(dir, 'in.mp4');
    writeFileSync(source, 'video');
    const result = await provider.uploadFile(source, 'video.mp4', 'video/mp4', 'posts/videos');
    expect(result.key).toMatch(/^posts\/videos\/.+\.mp4$/);
    const input = (send.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(input).toMatchObject({ Bucket: 'b', ContentLength: 5, ContentType: 'video/mp4' });
    (input.Body as { destroy: () => void }).destroy();
  });
});
