import { unitNounKindOf, unitWords } from './unit-noun.util';

describe('unitWords — what a venue calls what it rents out', () => {
  it('a PlayStation lounge rents stations, never courts', () => {
    const w = unitWords(['gaming-station', 'gaming-station']);
    expect(w.kind).toBe('station');
    expect(w.ar.which).toBe('أي جهاز');
    expect(w.en.many).toBe('stations');
  });

  it('a billiards and ping-pong club rents tables', () => {
    expect(unitWords(['table-game', 'table-game']).ar.one).toBe('ترابيزة');
  });

  it('padel, tennis, squash, basketball and football are courts', () => {
    expect(unitWords(['racket-court', 'field-sport']).kind).toBe('court');
    expect(unitWords([null, undefined]).ar.one).toBe('ملعب');
  });

  it('a venue that mixes kinds says "unit" instead of picking one', () => {
    const w = unitWords(['gaming-station', 'table-game']);
    expect(w.kind).toBe('unit');
    expect(w.ar.which).toBe('أي وحدة');
  });

  it('no units yet falls back to the plainest word', () => {
    expect(unitWords([]).kind).toBe('court');
    expect(unitNounKindOf('table-game')).toBe('table');
  });
});
