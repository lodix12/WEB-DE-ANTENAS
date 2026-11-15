import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPERATOR_ORDER, type AntenasDataset } from '../types/antena';
import {
  buildCsvExportContent,
  buildCustomJsonExportPayload,
  buildGeoJsonExportCollection,
  normalizeSearchText,
  parseCoordinateInput,
} from '../utils/export';
import {
  buildDerivedAntenasStructures,
  filterAntenas,
  fuseVodafoneAntennasInDataset,
  importAntenasJsonDataset,
  parseCustomAntenasJson,
  useFilteredAntenas,
} from './useAntenasData';

function createSampleCustomDataset(): AntenasDataset {
  return {
    updatedAt: '2026-11-15T04:00:00Z',
    sourceUrl: 'https://geoportal.minetur.gob.es/VCTEL/vcne.do',
    total: 3,
    crawlStats: {
      requestsCount: 2,
      durationSeconds: 2.4,
      gridBoxesVisited: 2,
      subdividedBoxes: 0,
      zoomParam: 7,
      delaySeconds: 1.0,
    },
    operators: {
      movistar: {
        key: 'movistar',
        name: 'Movistar (Telefónica)',
        count: 2,
        legalEntities: ['TELEFONICA MOVILES ESPAÑA, S.A.U.'],
      },
      orange: {
        key: 'orange',
        name: 'Orange (MasOrange)',
        count: 1,
        legalEntities: ['ORANGE ESPAGNE, S.A.U.'],
      },
      vodafone: {
        key: 'vodafone',
        name: 'Vodafone España',
        count: 0,
        legalEntities: [],
      },
      masmovil: {
        key: 'masmovil',
        name: 'Yoigo / Grupo MásMóvil',
        count: 0,
        legalEntities: [],
      },
      digi: {
        key: 'digi',
        name: 'DIGI Spain',
        count: 0,
        legalEntities: [],
      },
      otros: {
        key: 'otros',
        name: 'Otros Operadores',
        count: 0,
        legalEntities: [],
      },
    },
    provinces: [
      {
        provincia: 'MADRID',
        count: 2,
        byOperator: { movistar: 1, orange: 1 },
      },
      {
        provincia: 'ÁLAVA',
        count: 1,
        byOperator: { movistar: 1 },
      },
    ],
    antenas: [
      {
        id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800001',
        gid: '2800001',
        op: 'movistar',
        opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
        lat: 40.4168,
        lon: -3.7038,
        dir: 'GRAN VIA 28',
        mun: 'MADRID',
        prov: 'MADRID',
      },
      {
        id: 'ORANGE ESPAGNE, S.A.U. - 2800002',
        gid: '2800002',
        op: 'orange',
        opRaw: 'ORANGE ESPAGNE, S.A.U.',
        lat: 40.48,
        lon: -3.36,
        dir: 'PLAZA CERVANTES 1',
        mun: 'ALCALÁ DE HENARES',
        prov: 'MADRID',
      },
      {
        id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 0100001',
        gid: '0100001',
        op: 'movistar',
        opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
        lat: 42.8467,
        lon: -2.6716,
        dir: 'CALLE DATO 5',
        mun: 'VITORIA-GASTEIZ',
        prov: 'ÁLAVA',
      },
    ],
  };
}

describe('normalizeSearchText y parseCoordinateInput', () => {
  it('elimina tildes y convierte a minúsculas', () => {
    expect(normalizeSearchText('Alcalá de Guadaíra (Málaga)')).toBe(
      'alcala de guadaira (malaga)',
    );
  });

  it('detecta coordenadas WGS84 válidas en distintos formatos', () => {
    expect(parseCoordinateInput('40.4168, -3.7038')).toEqual({
      lat: 40.4168,
      lon: -3.7038,
    });
    expect(parseCoordinateInput('28.1235 -15.4363')).toEqual({
      lat: 28.1235,
      lon: -15.4363,
    });
    expect(parseCoordinateInput('40,4168; -3,7038')).toEqual({
      lat: 40.4168,
      lon: -3.7038,
    });
  });

  it('rechaza búsquedas de texto o valores fuera de rango WGS84', () => {
    expect(parseCoordinateInput('Madrid Centro 28001')).toBeNull();
    expect(parseCoordinateInput('3600449')).toBeNull();
    expect(parseCoordinateInput('95.123, -3.7038')).toBeNull();
  });
});

describe('parseCustomAntenasJson e importAntenasJsonDataset', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('valida y devuelve intacto un dataset con el esquema JSON propio AntenasDataset', () => {
    const sample = createSampleCustomDataset();
    const parsed = parseCustomAntenasJson(sample);
    expect(parsed).toEqual(sample);
    expect(parsed.antenas).toHaveLength(3);
    expect(parsed.antenas[0].gid).toBe('2800001');
  });

  it('rechaza explícitamente una FeatureCollection GeoJSON exigiendo el JSON propio de RadioMapa', () => {
    const rawGeoJson = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-3.7038, 40.4168] },
          properties: {
            Gis_ID: '2800001',
            Operador: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
          },
        },
      ],
    };

    expect(() => parseCustomAntenasJson(rawGeoJson)).toThrow(
      /Formato GeoJSON.*JSON propio/i,
    );
  });

  it('rechaza entidades GeoJSON infiltradas dentro del array antenas', () => {
    const sample = createSampleCustomDataset();
    const corrupted = {
      ...sample,
      antenas: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-3.7038, 40.4168] },
          properties: {},
        },
      ],
    };

    expect(() => parseCustomAntenasJson(corrupted)).toThrow(
      /GeoJSON.*JSON propio/i,
    );
  });

  it('importAntenasJsonDataset solicita data/antenas.json y rechaza respuestas GeoJSON', async () => {
    const sample = createSampleCustomDataset();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify(sample), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ type: 'FeatureCollection', features: [] }),
          { status: 200, headers: { 'Content-Type': 'application/geo+json' } },
        ),
      );

    const loaded = await importAntenasJsonDataset();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toMatch(/data\/antenas\.json$/);
    expect(loaded.total).toBe(3);

    await expect(importAntenasJsonDataset()).rejects.toThrow(
      /Formato GeoJSON.*JSON propio/i,
    );
  });
});

describe('buildDerivedAntenasStructures y exportación en JSON propio', () => {
  it('construye índices rápidos por provincia, municipio, operador y Gis_ID', () => {
    const sample = createSampleCustomDataset();

    const derived = buildDerivedAntenasStructures(sample);
    expect(derived.totalUniqueMunicipalities).toBe(3);
    expect(derived.operatorCounts.movistar).toBe(2);
    expect(derived.operatorCounts.orange).toBe(1);
    expect(derived.byGid.get('2800002')?.mun).toBe('ALCALÁ DE HENARES');
    expect(derived.provincesByAlpha[0].provincia).toBe('ÁLAVA');
    expect(derived.municipalitiesByProvince.get('MADRID')).toHaveLength(2);
    expect(derived.searchIndex[1]).toContain('alcala de henares');
  });

  it('genera payload de exportación en esquema JSON propio con y sin radarPoint', () => {
    const sample = createSampleCustomDataset();

    const withoutRadar = buildCustomJsonExportPayload(sample.antenas);
    expect(withoutRadar.source).toBe('RadioMapa España');
    expect(withoutRadar.total).toBe(3);
    expect(withoutRadar.radarPoint).toBeUndefined();
    expect(withoutRadar.antenas[0].fichaMinetur).toContain('detalleEstacion.do');
    expect(withoutRadar.antenas[0].distanciaMetros).toBeUndefined();

    const withRadar = buildCustomJsonExportPayload(sample.antenas, {
      lat: 40.4168,
      lon: -3.7038,
      radiusKm: 5,
    });
    expect(withRadar.radarPoint).toEqual({
      lat: 40.4168,
      lon: -3.7038,
      radiusKm: 5,
    });
    expect(withRadar.antenas[0].distanciaMetros).toBe(0);
    expect(typeof withRadar.antenas[1].acimutGrados).toBe('number');
    expect(withRadar.antenas[1].rumboCardinal).toBeTruthy();
  });

  it('acepta mergedGids opcional en parseCustomAntenasJson y rechaza tipos inválidos', () => {
    const sample = createSampleCustomDataset();
    sample.antenas[0] = {
      ...sample.antenas[0],
      mergedGids: ['2800001', '02800001'],
    };

    const parsed = parseCustomAntenasJson(sample);
    expect(parsed.antenas[0].mergedGids).toEqual(['2800001', '02800001']);

    const invalid = {
      ...sample,
      antenas: [{ ...sample.antenas[0], mergedGids: [12345] }],
    };
    expect(() => parseCustomAntenasJson(invalid)).toThrow(/mergedGids/i);
  });

  it('fusiona antenas de Vodafone a < 35 m en 1 sola antena, actualiza estadísticas e indexa mergedGids', () => {
    const base = createSampleCustomDataset();
    // Añadimos 3 declaraciones duplicadas de Vodafone en Madrid a < 35 m (~0 m y ~27.8 m)
    // y una Movistar co-ubicada a ~2 m que debe mantenerse intacta.
    const unfusedDataset: AntenasDataset = {
      ...base,
      total: 6,
      operators: {
        ...base.operators,
        vodafone: {
          key: 'vodafone',
          name: 'Vodafone España',
          count: 3,
          legalEntities: ['VODAFONE ESPAÑA, S.A.', 'VODAFONE ESPAÑA, S.A.U.'],
        },
      },
      provinces: [
        {
          provincia: 'MADRID',
          count: 5,
          byOperator: { movistar: 1, orange: 1, vodafone: 3 },
        },
        {
          provincia: 'ÁLAVA',
          count: 1,
          byOperator: { movistar: 1 },
        },
      ],
      antenas: [
        ...base.antenas,
        {
          id: 'VODAFONE ESPAÑA, S.A. - 00144693',
          gid: '00144693',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.',
          lat: 40.416802,
          lon: -3.703802,
          dir: 'GRAN VIA 28',
          mun: 'MADRID',
          prov: 'MADRID',
        },
        {
          id: 'VODAFONE ESPAÑA, S.A. - 0144693',
          gid: '0144693',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.',
          lat: 40.417052, // ~27.8 m (< 35 m)
          lon: -3.703802,
          dir: 'GRAN VIA 28',
          mun: 'MADRID',
          prov: 'MADRID',
        },
        {
          id: 'VODAFONE ESPAÑA, S.A.U. - 144693',
          gid: '144693',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          lat: 40.416802,
          lon: -3.703802,
          dir: '',
          mun: 'MADRID',
          prov: 'MADRID',
        },
      ],
    };

    const derived = buildDerivedAntenasStructures(unfusedDataset);

    // 3 Vodafone fusionadas en 1 sola antena -> total = 3 (base) + 1 (Vodafone) = 4
    expect(derived.dataset.total).toBe(4);
    expect(derived.dataset.antenas).toHaveLength(4);
    expect(derived.operatorCounts.vodafone).toBe(1);
    expect(derived.operatorCounts.movistar).toBe(2);
    expect(derived.operatorCounts.orange).toBe(1);
    expect(derived.dataset.operators.vodafone.count).toBe(1);
    expect(derived.dataset.crawlStats.vodafoneFusedDuplicates).toBe(2);

    const madridSummary = derived.provincesByCount.find(
      (p) => p.provincia === 'MADRID',
    );
    expect(madridSummary?.count).toBe(3);
    expect(madridSummary?.byOperator.vodafone).toBe(1);
    expect(madridSummary?.byOperator.movistar).toBe(1);
    expect(madridSummary?.byOperator.orange).toBe(1);

    // Búsqueda O(1) en byGid y searchIndex por cualquiera de los GIDs integrados
    const canonicalVoda = derived.byGid.get('144693');
    expect(canonicalVoda).toBeDefined();
    expect(canonicalVoda?.gid).toBe('144693');
    expect(canonicalVoda?.dir).toBe('GRAN VIA 28');
    expect(canonicalVoda?.mergedGids).toEqual(['144693', '0144693', '00144693']);
    expect(derived.byGid.get('0144693')).toBe(canonicalVoda);
    expect(derived.byGid.get('00144693')).toBe(canonicalVoda);

    const vodaIdx = derived.dataset.antenas.findIndex(
      (a) => a.op === 'vodafone',
    );
    expect(derived.searchIndex[vodaIdx]).toContain('144693');
    expect(derived.searchIndex[vodaIdx]).toContain('0144693');
    expect(derived.searchIndex[vodaIdx]).toContain('00144693');

    // Idempotencia: un dataset ya fusionado no realiza fusiones adicionales
    const secondPass = fuseVodafoneAntennasInDataset(derived.dataset);
    expect(secondPass).toBe(derived.dataset);
  });

  it('mantiene separadas antenas de Vodafone situadas a >= 35 m', () => {
    const base = createSampleCustomDataset();
    const separateVodafone: AntenasDataset = {
      ...base,
      total: 5,
      antenas: [
        ...base.antenas,
        {
          id: 'VODAFONE ESPAÑA, S.A.U. - 281001',
          gid: '281001',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          lat: 40.4168,
          lon: -3.7038,
          dir: 'SOL 1',
          mun: 'MADRID',
          prov: 'MADRID',
        },
        {
          id: 'VODAFONE ESPAÑA, S.A.U. - 281002',
          gid: '281002',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          lat: 40.417145, // ~38.4 m (>= 35 m)
          lon: -3.7038,
          dir: 'SOL 3',
          mun: 'MADRID',
          prov: 'MADRID',
        },
      ],
    };

    const derived = buildDerivedAntenasStructures(separateVodafone);
    expect(derived.operatorCounts.vodafone).toBe(2);
    expect(derived.dataset.antenas).toHaveLength(5);
  });

  it('nunca fusiona antenas de Telefónica (movistar) entre sí a < 35 m (incluso a 0 m o 20 m)', () => {
    const base = createSampleCustomDataset();
    const telefonicaCloseDataset: AntenasDataset = {
      ...base,
      total: 7,
      operators: {
        ...base.operators,
        movistar: {
          ...base.operators.movistar,
          count: 4,
        },
        vodafone: {
          ...base.operators.vodafone,
          count: 2,
          legalEntities: ['VODAFONE ESPAÑA, S.A.U.'],
        },
      },
      provinces: [
        {
          provincia: 'MADRID',
          count: 6,
          byOperator: { movistar: 3, orange: 1, vodafone: 2 },
        },
        {
          provincia: 'ÁLAVA',
          count: 1,
          byOperator: { movistar: 1 },
        },
      ],
      antenas: [
        ...base.antenas,
        // Segunda antena de Telefónica a 0 m exactos de 2800001 (40.4168, -3.7038)
        {
          id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800098',
          gid: '2800098',
          op: 'movistar',
          opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
          lat: 40.4168,
          lon: -3.7038,
          dir: 'GRAN VIA 28 BIS',
          mun: 'MADRID',
          prov: 'MADRID',
        },
        // Tercera antena de Telefónica a ~20 m (< 35 m) de 2800001
        {
          id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800099',
          gid: '2800099',
          op: 'movistar',
          opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
          lat: 40.41698, // ~20.0 m
          lon: -3.7038,
          dir: 'GRAN VIA 30',
          mun: 'MADRID',
          prov: 'MADRID',
        },
        // Par de Vodafone a ~22 m (< 35 m) para forzar reconstrucción de conteos
        {
          id: 'VODAFONE ESPAÑA, S.A.U. - 285001',
          gid: '285001',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          lat: 40.4168,
          lon: -3.7038,
          dir: 'GRAN VIA 28',
          mun: 'MADRID',
          prov: 'MADRID',
        },
        {
          id: 'VODAFONE ESPAÑA, S.A.U. - 0285001',
          gid: '0285001',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          lat: 40.417, // ~22.2 m
          lon: -3.7038,
          dir: 'GRAN VIA 28',
          mun: 'MADRID',
          prov: 'MADRID',
        },
      ],
    };

    const fusedOnly = fuseVodafoneAntennasInDataset(telefonicaCloseDataset);
    expect(fusedOnly.operators.movistar.count).toBe(4);
    expect(fusedOnly.operators.vodafone.count).toBe(1);
    expect(fusedOnly.total).toBe(6);

    const derived = buildDerivedAntenasStructures(telefonicaCloseDataset);
    expect(derived.operatorCounts.movistar).toBe(4);
    expect(derived.operatorCounts.vodafone).toBe(1);
    expect(derived.dataset.antenas.filter((a) => a.op === 'movistar')).toHaveLength(4);
    expect(derived.byGid.get('2800001')).not.toBe(derived.byGid.get('2800098'));
    expect(derived.byGid.get('2800001')).not.toBe(derived.byGid.get('2800099'));
    for (const ant of derived.dataset.antenas.filter((a) => a.op === 'movistar')) {
      expect(ant.mergedGids).toBeUndefined();
    }
    const madrid = derived.provincesByCount.find((p) => p.provincia === 'MADRID');
    expect(madrid?.byOperator.movistar).toBe(3);
    expect(madrid?.byOperator.vodafone).toBe(1);
  });
});

describe('bandas y frecuencias (MHz): validación, unión Vodafone < 35 m, filtrado y exportación', () => {
  it('valida bandas y frecuencias opcionales en parseCustomAntenasJson y rechaza valores inválidos', () => {
    const sample = createSampleCustomDataset();
    sample.antenas[0] = {
      ...sample.antenas[0],
      bandas: ['800 MHz', '1800 MHz', '3500 MHz'],
      frecuencias: [
        '801.00 - 811.00',
        '1825.00 - 1845.00',
        '3600.00 - 3700.00',
      ],
    };
    sample.antenas[1] = {
      ...sample.antenas[1],
      bandas: [],
      frecuencias: [],
    };
    // sample.antenas[2] mantiene bandas/frecuencias undefined (pendiente incremental)

    const parsed = parseCustomAntenasJson(sample);
    expect(parsed.antenas[0].bandas).toEqual([
      '800 MHz',
      '1800 MHz',
      '3500 MHz',
    ]);
    expect(parsed.antenas[1].bandas).toEqual([]);
    expect(parsed.antenas[2].bandas).toBeUndefined();

    expect(() =>
      parseCustomAntenasJson({
        ...sample,
        antenas: [{ ...sample.antenas[0], bandas: [3500] }],
      }),
    ).toThrow(/bandas/i);

    expect(() =>
      parseCustomAntenasJson({
        ...sample,
        antenas: [{ ...sample.antenas[0], frecuencias: ['935.10 - 949.90', null] }],
      }),
    ).toThrow(/frecuencias/i);
  });

  it('realiza la unión ordenada sin duplicados de bandas y frecuencias al fusionar Vodafone < 35 m', () => {
    const base = createSampleCustomDataset();
    const datasetWithBands: AntenasDataset = {
      ...base,
      total: 5,
      antenas: [
        {
          ...base.antenas[0],
          bandas: ['900 MHz', '3500 MHz'],
          frecuencias: ['935.10 - 949.90', '3600.00 - 3700.00'],
        },
        {
          ...base.antenas[1],
          bandas: [],
          frecuencias: [],
        },
        // base.antenas[2] sin bandas (undefined)
        base.antenas[2],
        // 2 registros de Vodafone a ~18 m (< 35 m) con bandas solapadas y desordenadas
        {
          id: 'VODAFONE ESPAÑA, S.A.U. - 289001',
          gid: '289001',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          lat: 40.4168,
          lon: -3.7038,
          dir: 'GRAN VIA 28',
          mun: 'MADRID',
          prov: 'MADRID',
          bandas: ['2100 MHz', '800 MHz'],
          frecuencias: ['2155.00 - 2170.00', '791.00 - 801.00'],
        },
        {
          id: 'VODAFONE ESPAÑA, S.A.U. - 0289001',
          gid: '0289001',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          lat: 40.41696, // ~17.8 m
          lon: -3.7038,
          dir: 'GRAN VIA 28',
          mun: 'MADRID',
          prov: 'MADRID',
          bandas: ['3500 MHz', '700 MHz', '800 MHz'],
          frecuencias: [
            '3400.00 - 3490.00',
            '791.00 - 801.00',
            '758.00 - 768.00',
          ],
        },
      ],
    };

    const derived = buildDerivedAntenasStructures(datasetWithBands);
    const fusedVoda = derived.byGid.get('289001');
    expect(fusedVoda).toBeDefined();
    expect(fusedVoda?.bandas).toEqual([
      '700 MHz',
      '800 MHz',
      '2100 MHz',
      '3500 MHz',
    ]);
    expect(fusedVoda?.frecuencias).toEqual([
      '758.00 - 768.00',
      '791.00 - 801.00',
      '2155.00 - 2170.00',
      '3400.00 - 3490.00',
    ]);

    // 3 de las 4 antenas resultantes tienen Array.isArray(ant.bandas) (incluyendo [])
    expect(derived.bandsPopulatedCount).toBe(3);

    // availableBands ordenado estrictamente por valor numérico en MHz
    expect(derived.availableBands).toEqual([
      { band: '700 MHz', count: 1 },
      { band: '800 MHz', count: 1 },
      { band: '900 MHz', count: 1 },
      { band: '2100 MHz', count: 1 },
      { band: '3500 MHz', count: 2 },
    ]);

    // Búsqueda textual instantánea por banda o rango exacto en MHz
    expect(
      filterAntenas({
        derived,
        searchQuery: '935.10',
        selectedProvince: '',
        selectedMunicipality: '',
        activeOperators: [...OPERATOR_ORDER],
      }).map((a) => a.gid),
    ).toEqual(['2800001']);

    expect(
      filterAntenas({
        derived,
        searchQuery: '700 MHz',
        selectedProvince: '',
        selectedMunicipality: '',
        activeOperators: [...OPERATOR_ORDER],
      }).map((a) => a.gid),
    ).toEqual(['289001']);

    // Filtrado dedicado por selectedBand (y a través del hook useFilteredAntenas)
    expect(
      filterAntenas({
        derived,
        searchQuery: '',
        selectedProvince: '',
        selectedMunicipality: '',
        activeOperators: [...OPERATOR_ORDER],
        selectedBand: '3500 MHz',
      }).map((a) => a.gid),
    ).toEqual(['2800001', '289001']);

    function HookProbe({ band }: { band: string }) {
      const items = useFilteredAntenas({
        derived,
        searchQuery: '',
        selectedProvince: '',
        selectedMunicipality: '',
        activeOperators: [...OPERATOR_ORDER],
        selectedBand: band,
      });
      return createElement('span', null, items.map((i) => i.gid).join(','));
    }

    expect(
      renderToStaticMarkup(createElement(HookProbe, { band: '2100 MHz' })),
    ).toBe('<span>289001</span>');
  });

  it('incluye bandas y frecuencias en exportaciones JSON, CSV y GeoJSON', () => {
    const sample = createSampleCustomDataset();
    sample.antenas[0] = {
      ...sample.antenas[0],
      bandas: ['700 MHz', '3500 MHz'],
      frecuencias: ['758.00 - 768.00', '3600.00 - 3700.00'],
    };

    const jsonExport = buildCustomJsonExportPayload(sample.antenas);
    expect(jsonExport.antenas[0].bandas).toEqual(['700 MHz', '3500 MHz']);
    expect(jsonExport.antenas[0].frecuencias).toEqual([
      '758.00 - 768.00',
      '3600.00 - 3700.00',
    ]);
    expect(jsonExport.antenas[1].bandas).toEqual([]);
    expect(jsonExport.antenas[1].frecuencias).toEqual([]);

    const csv = buildCsvExportContent(sample.antenas);
    const csvLines = csv.split('\n');
    expect(csvLines[0]).toContain('Bandas_MHz,Frecuencias_MHz');
    expect(csvLines[1]).toContain('"700 MHz; 3500 MHz"');
    expect(csvLines[1]).toContain('"758.00 - 768.00; 3600.00 - 3700.00"');

    const geojson = buildGeoJsonExportCollection(sample.antenas);
    expect(geojson.features[0]?.properties?.bandas).toEqual([
      '700 MHz',
      '3500 MHz',
    ]);
    expect(geojson.features[0]?.properties?.frecuencias).toEqual([
      '758.00 - 768.00',
      '3600.00 - 3700.00',
    ]);
  });
});



