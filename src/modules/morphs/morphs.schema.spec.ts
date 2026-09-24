import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Guest sweep and the orphan-guest cleanup hard-delete User rows; a morph
 * relation without a cascade would make those deletes fail. The real-database
 * check (migrate deploy + DELETE on Postgres) is part of the release evidence;
 * this guards the schema against regressions.
 */
describe('Lobby Morphs schema', () => {
  const schema = readFileSync(
    join(__dirname, '../../../prisma/schema.prisma'),
    'utf8',
  );

  const model = (name: string) => {
    const match = schema.match(
      new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`),
    );
    if (!match) throw new Error(`model ${name} missing`);
    return match[1];
  };

  it.each(['UserMorph', 'UserMorphProfile', 'MorphRoll'])(
    '%s cascades with its User',
    (name) => {
      expect(model(name)).toMatch(
        /user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)/,
      );
    },
  );

  it('keeps ownership rows unique per user and morph, and roll keys unique per user', () => {
    expect(model('UserMorph')).toContain('@@unique([userId, morphId])');
    expect(model('MorphRoll')).toContain('@@unique([userId, clientRollId])');
  });
});
