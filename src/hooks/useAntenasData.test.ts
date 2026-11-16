import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPERATOR_ORDER,
  type AntenasDataset,
  type NovedadesDataset,
  type ScanStatusPayload,
} from '../types/antena';
import {
  buildCsvExportContent,
  buildCustomJsonExportPayload,
  buildGeoJsonExportCollection,
  normalizeSearchText,
  parseCoordinateInput,
} from '../utils/export';
import { MapaView } from '../views/MapaView';
import { NovedadesView } from '../views/NovedadesView';
import { WorkspaceProvider } from './WorkspaceProvider';
import {
  buildDerivedAntenasStructures,
  filterAntenas,
  fuseVodafoneAntennasInDataset,
  importAntenasJsonDataset,
  parseCustomAntenasJson,
  useFilteredAntenas,
} from './useAntenasData';
import {
  NOVEDADES_PAGE_SIZE_OPTIONS,
  buildPaginationTokens,
  classifyFrequencyBandMhz,
  filterNovedades,
  formatScanDateTimeDmyHms,
  getOperatorRowBackground,
  importNovedadesJsonDataset,
  isValidNovedadesPageSize,
  paginateNovedades,
  parseCustomNovedadesJson,
} from './useNovedadesData';
import {
  computeInterpolatedScanMetrics,
  formatScanPercentEs,
  parseScanStatusPayload,
} from './useScanProgress';

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

describe('concesiones, bandsScannedAt e índice exacto byId', () => {
  it('valida concesiones y bandsScannedAt opcionales en parseCustomAntenasJson y rechaza formatos inválidos', () => {
    const sample = createSampleCustomDataset();
    sample.antenas[0] = {
      ...sample.antenas[0],
      concesiones: [
        { ref: 'M M -2205199', freq: '3460.00 - 3600.00' },
        { ref: 'M M -1100234', freq: '935.10 - 949.90' },
      ],
      bandsScannedAt: '2026-11-15T17:04:27Z',
    };

    const parsed = parseCustomAntenasJson(sample);
    expect(parsed.antenas[0].concesiones).toEqual([
      { ref: 'M M -2205199', freq: '3460.00 - 3600.00' },
      { ref: 'M M -1100234', freq: '935.10 - 949.90' },
    ]);
    expect(parsed.antenas[0].bandsScannedAt).toBe('2026-11-15T17:04:27Z');

    expect(() =>
      parseCustomAntenasJson({
        ...sample,
        antenas: [
          { ...sample.antenas[0], concesiones: [{ ref: 123, freq: '800' }] },
        ],
      }),
    ).toThrow(/concesiones/i);

    expect(() =>
      parseCustomAntenasJson({
        ...sample,
        antenas: [{ ...sample.antenas[0], bandsScannedAt: 1700000000 }],
      }),
    ).toThrow(/bandsScannedAt/i);
  });

  it('une concesiones sin duplicados (ref|freq), conserva el último bandsScannedAt en Vodafone < 35 m y expone byId O(1)', () => {
    const base = createSampleCustomDataset();
    const sharedTowerDataset: AntenasDataset = {
      ...base,
      total: 6,
      antenas: [
        ...base.antenas,
        // Dos operadores distintos que comparten código numérico Gis_ID en emplazamiento compartido
        {
          id: 'DIGI SPAIN TELECOM, S.L.U. - 2800001',
          gid: '2800001',
          op: 'digi',
          opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
          lat: 40.416805,
          lon: -3.703805,
          dir: 'GRAN VIA 28',
          mun: 'MADRID',
          prov: 'MADRID',
          concesiones: [{ ref: 'DG-9901', freq: '3400.00 - 3420.00' }],
          bandsScannedAt: '2026-11-15T17:05:10Z',
        },
        // Dos Vodafone a ~15 m (< 35 m) con concesiones solapadas y distintas marcas bandsScannedAt
        {
          id: 'VODAFONE ESPAÑA, S.A.U. - 287700',
          gid: '287700',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          lat: 40.42,
          lon: -3.71,
          dir: 'PRINCESA 10',
          mun: 'MADRID',
          prov: 'MADRID',
          concesiones: [
            { ref: 'VF-3500-A', freq: '3710.00 - 3800.00' },
            { ref: 'VF-800-A', freq: '791.00 - 801.00' },
          ],
          bandsScannedAt: '2026-11-14T17:00:05Z',
        },
        {
          id: 'VODAFONE ESPAÑA, S.A.U. - 0287700',
          gid: '0287700',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          lat: 40.42012, // ~13.3 m
          lon: -3.71,
          dir: 'PRINCESA 10',
          mun: 'MADRID',
          prov: 'MADRID',
          concesiones: [
            { ref: 'VF-800-A', freq: '791.00 - 801.00' },
            { ref: 'VF-700-B', freq: '758.00 - 768.00' },
          ],
          bandsScannedAt: '2026-11-15T17:04:59Z',
        },
      ],
    };

    const derived = buildDerivedAntenasStructures(sharedTowerDataset);

    // O(1) byId distingue con precisión operadores con idéntico Gis_ID ("2800001")
    const movistarShared = derived.byId.get(
      'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800001',
    );
    const digiShared = derived.byId.get(
      'DIGI SPAIN TELECOM, S.L.U. - 2800001',
    );
    expect(movistarShared?.op).toBe('movistar');
    expect(digiShared?.op).toBe('digi');
    expect(movistarShared).not.toBe(digiShared);

    // Unión ordenada y deduplicada de concesiones + último bandsScannedAt en Vodafone < 35 m
    const fusedVoda = derived.byGid.get('287700');
    expect(fusedVoda?.concesiones).toEqual([
      { ref: 'VF-700-B', freq: '758.00 - 768.00' },
      { ref: 'VF-800-A', freq: '791.00 - 801.00' },
      { ref: 'VF-3500-A', freq: '3710.00 - 3800.00' },
    ]);
    expect(fusedVoda?.bandsScannedAt).toBe('2026-11-15T17:04:59Z');

    // Búsqueda por código de concesión en el buscador del mapa
    expect(
      filterAntenas({
        derived,
        searchQuery: 'DG-9901',
        selectedProvince: '',
        selectedMunicipality: '',
        activeOperators: [...OPERATOR_ORDER],
      }).map((a) => a.id),
    ).toEqual(['DIGI SPAIN TELECOM, S.L.U. - 2800001']);
  });
});

describe('Novedades: parseCustomNovedadesJson, formatScanDateTimeDmyHms, filtrado y tabla única', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createSampleNovedadesDataset(): NovedadesDataset {
    return {
      updatedAt: '2026-11-15T17:04:27Z',
      scanId: 'daily-2026-11-15',
      previousScanAt: '2026-11-14T17:01:12Z',
      isBaselineScan: false,
      total: 2,
      antenasNuevas: 1,
      frecuenciasNuevas: 1,
      novedades: [
        {
          id: 'antena::DIGI SPAIN TELECOM, S.L.U. - 2809991',
          tipo: 'antena',
          op: 'digi',
          opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
          codigo: '2809991',
          antennaId: 'DIGI SPAIN TELECOM, S.L.U. - 2809991',
          codigoBanda: '',
          frecuencia: '',
          ubicacion: 'ALCALÁ DE HENARES',
          prov: 'MADRID',
          scannedAt: '2026-11-15T17:04:11Z',
          fecha: '15/11/2026 18:04:11',
        },
        {
          id: 'freq::TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800001::M M -2205199::3460.00 - 3600.00 MHz',
          tipo: 'frecuencia',
          op: 'movistar',
          opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
          codigo: '2800001',
          antennaId: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800001',
          codigoBanda: 'M M -2205199',
          frecuencia: '3460.00 - 3600.00 MHz',
          ubicacion: 'MADRID',
          prov: 'MADRID',
          scannedAt: '2026-11-15T17:04:27Z',
          fecha: '15/11/2026 18:04:27',
        },
      ],
    };
  }

  it('formatea fechas exactas en DD/MM/YYYY HH:MM:SS (Europe/Madrid) en invierno CET, verano CEST y medianoche', () => {
    // Respeta directamente preformattedFecha si ya cumple DD/MM/YYYY HH:MM:SS
    expect(
      formatScanDateTimeDmyHms(
        '2026-11-15T17:04:27Z',
        '15/11/2026 18:04:27',
      ),
    ).toBe('15/11/2026 18:04:27');

    // Invierno CET (UTC+1)
    expect(formatScanDateTimeDmyHms('2026-11-15T17:04:27Z')).toBe(
      '15/11/2026 18:04:27',
    );

    // Verano CEST (UTC+2)
    expect(formatScanDateTimeDmyHms('2026-07-15T16:04:05Z')).toBe(
      '15/07/2026 18:04:05',
    );

    // Medianoche en Madrid (00:05:09, nunca 24:05:09)
    expect(formatScanDateTimeDmyHms('2026-11-15T23:05:09Z')).toBe(
      '16/11/2026 00:05:09',
    );
  });

  it('valida el esquema NovedadesDataset (incluyendo escaneo baseline) y rechaza GeoJSON', async () => {
    const baseline: NovedadesDataset = {
      updatedAt: '2026-11-15T22:25:00Z',
      scanId: 'baseline-init',
      previousScanAt: null,
      isBaselineScan: true,
      total: 0,
      antenasNuevas: 0,
      frecuenciasNuevas: 0,
      novedades: [],
    };
    expect(parseCustomNovedadesJson(baseline)).toEqual(baseline);

    const sample = createSampleNovedadesDataset();
    expect(parseCustomNovedadesJson(sample)).toEqual(sample);

    expect(() =>
      parseCustomNovedadesJson({ type: 'FeatureCollection', features: [] }),
    ).toThrow(/GeoJSON/i);

    expect(() =>
      parseCustomNovedadesJson({
        ...sample,
        novedades: [{ ...sample.novedades[0], tipo: 'desconocido' }],
      }),
    ).toThrow(/NovedadRecord/i);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(sample), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const loaded = await importNovedadesJsonDataset();
    expect(String(fetchSpy.mock.calls[0]?.[0])).toMatch(
      /data\/novedades\.json$/,
    );
    expect(loaded.total).toBe(2);
  });

  it('calcula el color de fondo de cada fila con 50% de transparencia exacta según la operadora', () => {
    expect(getOperatorRowBackground('movistar')).toBe('rgba(0, 102, 204, 0.5)');
    expect(getOperatorRowBackground('orange')).toBe('rgba(234, 88, 12, 0.5)');
    expect(getOperatorRowBackground('vodafone')).toBe('rgba(220, 38, 38, 0.5)');
    expect(getOperatorRowBackground('masmovil')).toBe(
      'rgba(13, 148, 136, 0.5)',
    );
    expect(getOperatorRowBackground('digi')).toBe('rgba(124, 58, 237, 0.5)');
    expect(getOperatorRowBackground('otros')).toBe('rgba(100, 116, 139, 0.5)');
  });

  it('filtra novedades por tipo, operadora, banda, ubicación, fecha y búsqueda instantánea sin tildes', () => {
    const { novedades } = createSampleNovedadesDataset();

    expect(classifyFrequencyBandMhz('3460.00 - 3600.00 MHz')).toBe('3500 MHz');
    expect(classifyFrequencyBandMhz('935.10 - 949.90 MHz')).toBe('900 MHz');
    expect(classifyFrequencyBandMhz('758.00 - 768.00 MHz')).toBe('700 MHz');

    expect(
      filterNovedades({
        novedades,
        tipoFilter: 'antena',
        operatorFilter: 'all',
        searchQuery: '',
      }).map((r) => r.codigo),
    ).toEqual(['2809991']);

    expect(
      filterNovedades({
        novedades,
        tipoFilter: 'all',
        operatorFilter: 'digi',
        searchQuery: '',
      }).map((r) => r.codigo),
    ).toEqual(['2809991']);

    expect(
      filterNovedades({
        novedades,
        tipoFilter: 'all',
        operatorFilter: 'movistar',
        searchQuery: '2205199',
      }).map((r) => r.codigo),
    ).toEqual(['2800001']);

    expect(
      filterNovedades({
        novedades,
        tipoFilter: 'all',
        operatorFilter: 'all',
        bandFilter: '3500 MHz',
        searchQuery: '',
      }).map((r) => r.codigo),
    ).toEqual(['2800001']);

    expect(
      filterNovedades({
        novedades,
        tipoFilter: 'all',
        operatorFilter: 'all',
        locationFilter: 'ALCALÁ DE HENARES',
        searchQuery: '',
      }).map((r) => r.codigo),
    ).toEqual(['2809991']);

    expect(
      filterNovedades({
        novedades,
        tipoFilter: 'all',
        operatorFilter: 'all',
        dateFilter: '15/11/2026',
        searchQuery: '',
      }).map((r) => r.codigo),
    ).toEqual(['2809991', '2800001']);

    expect(
      filterNovedades({
        novedades,
        tipoFilter: 'all',
        operatorFilter: 'all',
        searchQuery: 'alcala de henares',
      }).map((r) => r.codigo),
    ).toEqual(['2809991']);

    expect(
      filterNovedades({
        novedades,
        tipoFilter: 'frecuencia',
        operatorFilter: 'all',
        searchQuery: '3460.00 - 3600.00 MHz',
      }).map((r) => r.codigo),
    ).toEqual(['2800001']);
  });

  it('renderiza 1 única tabla #novedades-table con las 6 columnas, filtros (incluida Operadora) y fondo 50% transparente por operadora', async () => {
    async function renderNovedadesWithDataset(
      dataset: NovedadesDataset,
      scanStatus: ScanStatusPayload | null = null,
    ) {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      queryClient.setQueryData(['novedades-dataset'], dataset);
      queryClient.setQueryData(['antenas-dataset'], createSampleCustomDataset());
      queryClient.setQueryData(['scan-status'], scanStatus);

      const testRoot = createRootRoute({ component: Outlet });
      const testMap = createRoute({
        getParentRoute: () => testRoot,
        path: '/',
        component: () => createElement('div', null, 'Mapa'),
      });
      const testNov = createRoute({
        getParentRoute: () => testRoot,
        path: '/novedades',
        component: NovedadesView,
      });
      const testRouter = createRouter({
        routeTree: testRoot.addChildren([testMap, testNov]),
        history: createMemoryHistory({ initialEntries: ['/novedades'] }),
      });
      await testRouter.load();

      return renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(RouterProvider, { router: testRouter }),
        ),
      );
    }

    const baselineHtml = await renderNovedadesWithDataset({
      updatedAt: '2026-11-15T22:25:00Z',
      scanId: 'baseline-init',
      previousScanAt: null,
      isBaselineScan: true,
      total: 0,
      antenasNuevas: 0,
      frecuenciasNuevas: 0,
      novedades: [],
    });

    expect(baselineHtml.match(/<table\b/g)).toHaveLength(1);
    const baselineHeaders = Array.from(
      baselineHtml.matchAll(/<th\b[^>]*>(.*?)<\/th>/g),
      (m) => m[1],
    );
    expect(baselineHeaders).toEqual([
      'Novedad',
      'Código',
      'Código Banda',
      'Frecuencia',
      'Ubicación',
      'Fecha',
    ]);
    // "Total novedades" ha sido sustituido por #novedades-scan-monitor,
    // mientras que "Antenas nuevas" y "Frecuencias nuevas" se conservan intactas:
    expect(baselineHtml).not.toContain('Total novedades');
    expect(baselineHtml).toContain('id="novedades-scan-monitor"');
    expect(baselineHtml).toContain('Escaneo en vivo');
    expect(baselineHtml).toContain(
      '<span class="metric-label">Antenas nuevas</span>',
    );
    expect(baselineHtml).toContain(
      '<span class="metric-label">Frecuencias nuevas</span>',
    );
    expect(baselineHtml).toContain('id="novedades-operator-filter"');
    expect(baselineHtml).toContain('id="novedades-op-chip-digi"');
    expect(baselineHtml).toContain('id="novedades-band-filter"');
    expect(baselineHtml).toContain('id="novedades-location-filter"');
    expect(baselineHtml).toContain('18:00 h');

    const populatedHtml = await renderNovedadesWithDataset(
      createSampleNovedadesDataset(),
    );
    expect(populatedHtml.match(/<table\b/g)).toHaveLength(1);
    expect(populatedHtml).toContain('rgba(124, 58, 237, 0.5)');
    expect(populatedHtml).toContain('rgba(0, 102, 204, 0.5)');
    expect(populatedHtml).toContain('id="novedades-date-filter"');
    expect(populatedHtml).toContain('Antena nueva');
    expect(populatedHtml).toContain('DIGI Spain');
    expect(populatedHtml).toContain('Frecuencia nueva');
    expect(populatedHtml).toContain('Movistar (Telefónica)');
    expect(populatedHtml).toContain('2809991');
    expect(populatedHtml).toContain('M M -2205199');
    expect(populatedHtml).toContain('3460.00 - 3600.00 MHz');
    expect(populatedHtml).toContain('ALCALÁ DE HENARES');
    expect(populatedHtml).toContain('15/11/2026 18:04:27');
    expect(populatedHtml).toMatch(/href="\/\?gid=.*2800001.*id=TELEFONICA/);

    // Escaneo forzado activo (workflow_dispatch) mostrando porcentaje en vivo
    const nowIso = new Date().toISOString();
    const forcedScanHtml = await renderNovedadesWithDataset(
      createSampleNovedadesDataset(),
      {
        schemaVersion: 1,
        state: 'running',
        scanId: 'forced-run-1',
        trigger: 'workflow_dispatch',
        recordNovedades: false,
        part: '2/4',
        phase: 'frecuencias',
        startedAt: nowIso,
        updatedAt: nowIso,
        censusBoxesVisited: 239,
        estimatedCensusBoxes: 239,
        discoveredAntennas: 62230,
        scannedAntennas: 21631,
        totalAntennas: 62230,
        percent: 34.76,
      },
    );
    expect(forcedScanHtml).not.toContain('Total novedades');
    expect(forcedScanHtml).toContain('Forzado');
    expect(forcedScanHtml).toMatch(/34,76\s*%/);
    expect(forcedScanHtml).toContain('Parte 2/4');
    expect(forcedScanHtml).toContain(
      '<span class="metric-label">Antenas nuevas</span>',
    );
    expect(forcedScanHtml).toContain(
      '<span class="metric-label">Frecuencias nuevas</span>',
    );

    // Escaneo diario 18:00 activo (schedule) mostrando porcentaje en vivo
    const dailyScanHtml = await renderNovedadesWithDataset(
      createSampleNovedadesDataset(),
      {
        schemaVersion: 1,
        state: 'running',
        scanId: 'daily-run-2',
        trigger: 'schedule',
        recordNovedades: true,
        part: '3/4',
        phase: 'frecuencias',
        startedAt: nowIso,
        updatedAt: nowIso,
        censusBoxesVisited: 239,
        estimatedCensusBoxes: 239,
        discoveredAntennas: 62230,
        scannedAntennas: 42391,
        totalAntennas: 62230,
        percent: 68.12,
      },
    );
    expect(dailyScanHtml).toContain('Diario · 18:00');
    expect(dailyScanHtml).toMatch(/68,12\s*%/);
    expect(dailyScanHtml).toContain('Parte 3/4');

    // Controles de paginación: selector exacto 10, 25, 50 y 100 + selector de página concreta
    expect(baselineHtml).toContain('id="novedades-pagination-bar"');
    const pageSizeSelectMatch = baselineHtml.match(
      /<select[^>]*id="novedades-page-size-select"[^>]*>([\s\S]*?)<\/select>/,
    );
    expect(pageSizeSelectMatch).not.toBeNull();
    const pageSizeOptions = Array.from(
      (pageSizeSelectMatch?.[1] ?? '').matchAll(
        /<option[^>]*value="(\d+)"[^>]*>(\d+)<\/option>/g,
      ),
      (m) => Number(m[1]),
    );
    expect(pageSizeOptions).toEqual([10, 25, 50, 100]);
    expect(baselineHtml).toContain('id="novedades-page-input"');
    expect(baselineHtml).toContain('id="novedades-page-jump-btn"');

    // Dataset multipágina (65 filas -> 3 páginas con el tamaño por defecto de 25 filas/página)
    const baseSample = createSampleNovedadesDataset();
    const sixtyFiveRows = Array.from({ length: 65 }, (_, idx) => {
      const code = String(2810000 + idx);
      return {
        ...baseSample.novedades[idx % 2],
        id: `nov-row-${idx + 1}`,
        codigo: code,
        antennaId: `DIGI SPAIN TELECOM, S.L.U. - ${code}`,
      };
    });
    const multiPageHtml = await renderNovedadesWithDataset({
      ...baseSample,
      total: 65,
      antenasNuevas: 33,
      frecuenciasNuevas: 32,
      novedades: sixtyFiveRows,
    });
    expect(multiPageHtml.match(/class="novedades-row"/g)).toHaveLength(25);
    expect(multiPageHtml).toContain('1–25');
    expect(multiPageHtml).toContain('aria-label="Ir a la página 1"');
    expect(multiPageHtml).toContain('aria-label="Ir a la página 2"');
    expect(multiPageHtml).toContain('aria-label="Ir a la página 3"');
    expect(multiPageHtml).toContain('aria-current="page"');
    expect(multiPageHtml).toContain(
      'aria-label="Seleccionar página concreta (1 a 3)"',
    );
  });

  it('pagina correctamente con opciones 10, 25, 50 y 100 filas y construye numeración de páginas concretas', () => {
    expect(NOVEDADES_PAGE_SIZE_OPTIONS).toEqual([10, 25, 50, 100]);
    expect(isValidNovedadesPageSize(10)).toBe(true);
    expect(isValidNovedadesPageSize(25)).toBe(true);
    expect(isValidNovedadesPageSize(50)).toBe(true);
    expect(isValidNovedadesPageSize(100)).toBe(true);
    expect(isValidNovedadesPageSize(20)).toBe(false);
    expect(isValidNovedadesPageSize(300)).toBe(false);

    // Dataset vacío (0 filas)
    const emptySlice = paginateNovedades([], 1, 25);
    expect(emptySlice).toEqual({
      items: [],
      currentPage: 1,
      pageSize: 25,
      totalItems: 0,
      totalPages: 1,
      startRow: 0,
      endRow: 0,
    });

    // Dataset con 137 filas probado con 10, 25, 50 y 100 filas/página y salto a página concreta
    const rows = Array.from({ length: 137 }, (_, i) => i + 1);

    const p10Page9 = paginateNovedades(rows, 9, 10);
    expect(p10Page9.totalPages).toBe(14);
    expect(p10Page9.currentPage).toBe(9);
    expect(p10Page9.startRow).toBe(81);
    expect(p10Page9.endRow).toBe(90);
    expect(p10Page9.items).toEqual([81, 82, 83, 84, 85, 86, 87, 88, 89, 90]);

    const p25Last = paginateNovedades(rows, 999, 25);
    expect(p25Last.totalPages).toBe(6);
    expect(p25Last.currentPage).toBe(6);
    expect(p25Last.startRow).toBe(126);
    expect(p25Last.endRow).toBe(137);
    expect(p25Last.items).toHaveLength(12);

    const p50FirstClamp = paginateNovedades(rows, 0, 50);
    expect(p50FirstClamp.totalPages).toBe(3);
    expect(p50FirstClamp.currentPage).toBe(1);
    expect(p50FirstClamp.startRow).toBe(1);
    expect(p50FirstClamp.endRow).toBe(50);

    const p100Page2 = paginateNovedades(rows, 2, 100);
    expect(p100Page2.totalPages).toBe(2);
    expect(p100Page2.currentPage).toBe(2);
    expect(p100Page2.startRow).toBe(101);
    expect(p100Page2.endRow).toBe(137);
    expect(p100Page2.items).toHaveLength(37);

    // Tokens de paginación estables (sin salto de anchura cuando totalPages > 7)
    expect(buildPaginationTokens(1, 1)).toEqual([1]);
    expect(buildPaginationTokens(3, 6)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(buildPaginationTokens(2, 14)).toEqual([
      1,
      2,
      3,
      4,
      5,
      'ellipsis-end',
      14,
    ]);
    expect(buildPaginationTokens(8, 14)).toEqual([
      1,
      'ellipsis-start',
      7,
      8,
      9,
      'ellipsis-end',
      14,
    ]);
    expect(buildPaginationTokens(13, 14)).toEqual([
      1,
      'ellipsis-start',
      10,
      11,
      12,
      13,
      14,
    ]);
  });

  it('parsea scan-status.json (directo y Base64 Contents API) e interpola avance en tiempo real', () => {
    const rawPayload: ScanStatusPayload = {
      schemaVersion: 1,
      state: 'running',
      scanId: 'run-999',
      trigger: 'schedule',
      recordNovedades: true,
      part: '1/4',
      phase: 'frecuencias',
      startedAt: '2026-11-15T17:00:00Z',
      updatedAt: '2026-11-15T17:10:00Z',
      censusBoxesVisited: 239,
      estimatedCensusBoxes: 239,
      discoveredAntennas: 62230,
      scannedAntennas: 500,
      totalAntennas: 62230,
      percent: 0.8,
    };

    expect(parseScanStatusPayload(rawPayload)).toEqual(rawPayload);

    const b64 = btoa(JSON.stringify(rawPayload));
    expect(
      parseScanStatusPayload({
        content: `${b64.slice(0, 20)}\n${b64.slice(20)}`,
        encoding: 'base64',
      }),
    ).toEqual(rawPayload);

    expect(formatScanPercentEs(34.76)).toMatch(/^34,76\s%$/);

    // 20 segundos después del último latido -> interpola ~18 antenas más de forma monótona
    const t0 = Date.parse('2026-11-15T17:10:00Z');
    const m20 = computeInterpolatedScanMetrics(rawPayload, t0 + 20_000, 62230);
    expect(m20.isScanning).toBe(true);
    expect(m20.scannedAntennas).toBe(518);
    expect(m20.percent).toBeGreaterThanOrEqual(0.83);
  });

  it('renderiza en MapaView un único control de medición (#map-toggle-radar-btn) sin botón flotante duplicado (#mobile-radar-mode-btn)', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['antenas-dataset'], createSampleCustomDataset());

    const testRoot = createRootRoute({ component: Outlet });
    const testMap = createRoute({
      getParentRoute: () => testRoot,
      path: '/',
      validateSearch: (s: Record<string, unknown>) => ({
        gid: typeof s.gid === 'string' ? s.gid : undefined,
        id: typeof s.id === 'string' ? s.id : undefined,
      }),
      component: MapaView,
    });
    const testRouter = createRouter({
      routeTree: testRoot.addChildren([testMap]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    await testRouter.load();

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          WorkspaceProvider,
          null,
          createElement(RouterProvider, { router: testRouter }),
        ),
      ),
    );

    expect(html).not.toContain('mobile-radar-mode-btn');
    expect(html).toContain('id="mobile-open-filters-btn"');
    expect(html).toContain('id="map-locate-gps-btn"');
    expect(html).toContain('id="map-toggle-radar-btn"');
    expect(html).toContain('id="map-style-switcher-btn"');
    expect(html.match(/id="map-toggle-radar-btn"/g)).toHaveLength(1);
  });
});

