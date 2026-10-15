import { buildAreaRollup, normalizePlaceName, type CatalogDistrict } from './area-catalog.util';

const d = (id: string, slug: string | null, nameAr: string, lat: number | null = null, lng: number | null = null, governorateId = 'gov-cairo'): CatalogDistrict =>
  ({ id, slug, nameAr, nameEn: nameAr, governorateId, lat, lng });

describe('area rollup', () => {
  const nasr = d('dist-nasr-city', 'nasr-city', 'مدينة نصر', 30.0511, 31.3656);
  const helio = d('dist-heliopolis', 'heliopolis', 'مصر الجديدة', 30.091, 31.322);
  const newCairo = d('dist-new-cairo', 'new-cairo', 'القاهرة الجديدة', 30.03, 31.47);

  it('normalizes spacing, hamza and qism ordinals', () => {
    expect(normalizePlaceName('قسم ثان مدينة نصر')).toBe(normalizePlaceName('مدينة نصر'));
    expect(normalizePlaceName('قسم مصرالجديدة')).toBe(normalizePlaceName('مصر الجديدة'));
    expect(normalizePlaceName('قسم أول القاهرة الجديدة')).toBe(normalizePlaceName('القاهرة الجديدة'));
  });

  it('folds census sub-areas into the named area of their qism', () => {
    const rollup = buildAreaRollup([
      nasr, helio, newCairo,
      d('dist-cod-1', 'cod-1', 'الاستاد — قسم ثان مدينة نصر', 30.07, 31.33),
      d('dist-cod-2', 'cod-2', 'الكوربة — قسم مصرالجديدة'),
      d('dist-cod-3', 'cod-3', 'التجمع — قسم ثالث القاهرة الجديدة'),
    ]);
    expect(rollup.get('dist-cod-1')).toBe('dist-nasr-city');
    expect(rollup.get('dist-cod-2')).toBe('dist-heliopolis');
    expect(rollup.get('dist-cod-3')).toBe('dist-new-cairo');
    expect(rollup.get('dist-nasr-city')).toBe('dist-nasr-city');
  });

  it('falls back to a close named area, and leaves far ones governorate-only', () => {
    const rollup = buildAreaRollup([
      nasr,
      d('dist-cod-near', 'cod-near', 'حي ما — قسم غير معروف', 30.055, 31.37),
      d('dist-cod-far', 'cod-far', 'حي بعيد — قسم المرج', 30.15, 31.34),
      d('dist-cod-other-gov', 'cod-x', 'حي — قسم ثان مدينة نصر', 30.05, 31.36, 'gov-giza'),
    ]);
    expect(rollup.get('dist-cod-near')).toBe('dist-nasr-city');
    expect(rollup.has('dist-cod-far')).toBe(false);
    expect(rollup.has('dist-cod-other-gov')).toBe(false);
  });
});
