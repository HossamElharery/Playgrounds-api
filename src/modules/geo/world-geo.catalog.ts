import type {
  ICity,
  ICountry,
  ICountryMeta,
  IState,
} from '@countrystatecity/countries';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

// The dependency deliberately exports its versioned data files. Reading them
// directly avoids dynamic JSON imports, which are unavailable in Jest's VM.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const DATA_ROOT = dirname(
  require.resolve('@countrystatecity/countries/data/countries.json'),
);
let countryDirectories: Map<string, string> | undefined;
const stateDirectories = new Map<string, Map<string, string>>();

function readJson<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(join(DATA_ROOT, ...parts), 'utf8')) as T;
}

function countryDirectory(code: string): string | null {
  countryDirectories ??= new Map(
    readdirSync(DATA_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => [entry.name.split('-').at(-1)!, entry.name]),
  );
  return countryDirectories.get(code) ?? null;
}

function stateDirectory(countryCode: string, stateCode: string): string | null {
  const countryDir = countryDirectory(countryCode);
  if (!countryDir) return null;
  let directories = stateDirectories.get(countryCode);
  if (!directories) {
    directories = new Map(
      readdirSync(join(DATA_ROOT, countryDir), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => [entry.name.split('-').at(-1)!, entry.name]),
    );
    stateDirectories.set(countryCode, directories);
  }
  return directories.get(stateCode) ?? null;
}

async function getCountries(): Promise<ICountry[]> {
  return readJson('countries.json');
}

async function getCountryByCode(code: string): Promise<ICountryMeta | null> {
  const dir = countryDirectory(code);
  return dir ? readJson(dir, 'meta.json') : null;
}

async function getStatesOfCountry(code: string): Promise<IState[]> {
  const dir = countryDirectory(code);
  return dir ? readJson(dir, 'states.json') : [];
}

async function getCitiesOfState(
  code: string,
  stateCode: string | null,
): Promise<ICity[]> {
  const countryDir = countryDirectory(code);
  if (!countryDir) return [];
  if (stateCode == null) {
    const path = join(DATA_ROOT, countryDir, 'cities.json');
    return existsSync(path) ? readJson(countryDir, 'cities.json') : [];
  }
  const stateDir = stateDirectory(code, stateCode);
  return stateDir ? readJson(countryDir, stateDir, 'cities.json') : [];
}

async function getAllCitiesOfCountry(code: string): Promise<ICity[]> {
  const states = await getStatesOfCountry(code);
  const cities = await getCitiesOfState(code, null);
  for (const state of states)
    cities.push(...(await getCitiesOfState(code, state.iso2)));
  return cities;
}

const ARABIC_LOCALE_COUNTRIES = new Set([
  'AE',
  'BH',
  'DJ',
  'DZ',
  'EG',
  'EH',
  'IQ',
  'JO',
  'KM',
  'KW',
  'LB',
  'LY',
  'MA',
  'MR',
  'OM',
  'PS',
  'QA',
  'SA',
  'SD',
  'SO',
  'SY',
  'TD',
  'TN',
  'YE',
]);

const FRIDAY_SATURDAY_WEEKENDS = new Set([
  'AE',
  'BH',
  'BD',
  'DZ',
  'EG',
  'IQ',
  'IL',
  'JO',
  'KW',
  'LY',
  'MV',
  'OM',
  'PS',
  'QA',
  'SA',
  'SD',
  'SY',
  'YE',
]);

export const catalogStateId = (id: number) => `csc-state-${id}`;
export const catalogCityId = (id: number) => `csc-city-${id}`;
export const catalogCountryStateId = (code: string) =>
  `csc-state-country-${code}`;
export const catalogFallbackCityId = (stateId: string) => `csc-area-${stateId}`;

export function catalogNameAr(
  item:
    | Pick<ICountryMeta, 'name' | 'native' | 'translations'>
    | Pick<IState | ICity, 'name' | 'native' | 'translations'>,
): string {
  return item.translations?.ar?.trim() || item.native?.trim() || item.name;
}

export function catalogCountryView(
  country: ICountry,
  meta?: ICountryMeta | null,
) {
  const timezone = meta?.timezones?.[0]?.zoneName || 'UTC';
  return {
    code: country.iso2,
    nameEn: country.name,
    nameAr: meta ? catalogNameAr(meta) : country.native || country.name,
    currency: country.currency,
    phoneCallingCode: `+${country.phonecode.replace(/^\+/, '')}`,
    timezone,
    locale: ARABIC_LOCALE_COUNTRIES.has(country.iso2) ? 'ar' : 'en',
    weekendDays: FRIDAY_SATURDAY_WEEKENDS.has(country.iso2) ? [5, 6] : [6, 0],
    paymentMethods: ['card', 'cash'],
    lat: Number.isFinite(Number(country.latitude))
      ? Number(country.latitude)
      : null,
    lng: Number.isFinite(Number(country.longitude))
      ? Number(country.longitude)
      : null,
  };
}

export async function worldCountries() {
  const countries = await getCountries();
  return Promise.all(
    countries.map(async (country) =>
      catalogCountryView(country, await getCountryByCode(country.iso2)),
    ),
  );
}

export async function worldCountry(code: string) {
  const meta = await getCountryByCode(code);
  return meta ? catalogCountryView(meta, meta) : null;
}

export async function worldStates(code: string) {
  const states = await getStatesOfCountry(code);
  if (states.length) return states;
  const country = await getCountryByCode(code);
  if (!country) return [];
  return [
    {
      id: -country.id,
      name: country.name,
      country_id: country.id,
      country_code: country.iso2,
      fips_code: null,
      iso2: '',
      iso3166_2: null,
      type: 'country',
      latitude: country.latitude,
      longitude: country.longitude,
      native: country.native,
      timezone: country.timezones[0]?.zoneName ?? null,
      translations: country.translations,
    } satisfies IState,
  ];
}

export function stateView(state: IState) {
  const synthetic = state.id < 0;
  return {
    id: synthetic
      ? catalogCountryStateId(state.country_code)
      : catalogStateId(state.id),
    slug: synthetic
      ? `country-${state.country_code.toLowerCase()}`
      : `csc-${state.id}`,
    nameEn: state.name,
    nameAr: catalogNameAr(state),
    countryCode: state.country_code,
    lat: state.latitude == null ? null : Number(state.latitude),
    lng: state.longitude == null ? null : Number(state.longitude),
  };
}

export async function worldCities(code: string, state: IState) {
  return state.id < 0
    ? getAllCitiesOfCountry(code)
    : getCitiesOfState(code, state.iso2 || null);
}

export function cityView(city: ICity, governorateId: string) {
  return {
    id: catalogCityId(city.id),
    slug: `csc-${city.id}`,
    nameEn: city.name,
    nameAr: catalogNameAr(city),
    lat: Number.isFinite(Number(city.latitude)) ? Number(city.latitude) : null,
    lng: Number.isFinite(Number(city.longitude))
      ? Number(city.longitude)
      : null,
    polygon: null,
    governorateId,
  };
}

export function fallbackCityView(state: IState, governorateId: string) {
  return {
    id: catalogFallbackCityId(governorateId),
    slug: 'other-area',
    nameEn: 'Other / unlisted area',
    nameAr: 'منطقة أخرى / غير مدرجة',
    lat: state.latitude == null ? null : Number(state.latitude),
    lng: state.longitude == null ? null : Number(state.longitude),
    polygon: null,
    governorateId,
  };
}

export async function findWorldState(code: string, id: string) {
  return (
    (await worldStates(code)).find((state) => stateView(state).id === id) ??
    null
  );
}

export async function findWorldCity(code: string, state: IState, id: string) {
  if (id === catalogFallbackCityId(stateView(state).id)) return null;
  return (
    (await worldCities(code, state)).find(
      (city) => catalogCityId(city.id) === id,
    ) ?? null
  );
}

export function isCatalogLocationId(id: string | null | undefined) {
  return (
    !!id &&
    (id.startsWith('csc-state-') ||
      id.startsWith('csc-city-') ||
      id.startsWith('csc-area-'))
  );
}
