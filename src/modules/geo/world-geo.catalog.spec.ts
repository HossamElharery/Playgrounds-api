import {
  catalogCityId,
  catalogStateId,
  cityView,
  stateView,
  worldCities,
  worldCountries,
  worldCountry,
  worldStates,
} from './world-geo.catalog';

describe('world geo catalog', () => {
  it('provides every country with its currency, calling code and Arabic name', async () => {
    const countries = await worldCountries();
    expect(countries.length).toBeGreaterThanOrEqual(249);
    expect(
      countries.every(
        (country) => country.currency && country.phoneCallingCode,
      ),
    ).toBe(true);
    expect(countries.find((country) => country.code === 'LY')).toMatchObject({
      nameAr: 'ليبيا',
      currency: 'LYD',
      phoneCallingCode: '+218',
      timezone: 'Africa/Tripoli',
    });
  });

  it('provides Libyan administrative regions and their cities with stable ids', async () => {
    const libya = await worldCountry('LY');
    const states = await worldStates('LY');
    const benghazi = states.find((state) => state.name === 'Benghazi');
    expect(libya?.currency).toBe('LYD');
    expect(states.length).toBeGreaterThanOrEqual(20);
    expect(benghazi).toBeDefined();
    expect(stateView(benghazi!).id).toBe(catalogStateId(benghazi!.id));

    const cities = await worldCities('LY', benghazi!);
    expect(cities.length).toBeGreaterThan(0);
    expect(cityView(cities[0], catalogStateId(benghazi!.id)).id).toBe(
      catalogCityId(cities[0].id),
    );
  });
});
