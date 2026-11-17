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
import * as AntenasMapModule from '../components/map/AntenasMap';
import antenasMapRawSource from '../components/map/AntenasMap.tsx?raw';
import { MapOverlays } from '../components/map/MapOverlays';
import mapOverlaysRawSource from '../components/map/MapOverlays.tsx?raw';
import { AppHeader } from '../components/ui/AppHeader';
import { FilterPanel } from '../components/ui/FilterPanel';
import { NotFoundView, RootLayout } from '../components/ui/RootLayout';
import { StationDetailDrawer } from '../components/ui/StationDetailDrawer';
import {
  OPERATOR_META,
  OPERATOR_ORDER,
  type AntennaRecord,
  type AntenasDataset,
  type LiveScanDeltaChunk,
  type NovedadRecord,
  type NovedadesDataset,
  type OperatorKey,
  type ScanStatusPayload,
} from '../types/antena';
import {
  buildCsvExportContent,
  buildCustomJsonExportPayload,
  buildGeoJsonExportCollection,
  normalizeSearchText,
  parseCoordinateInput,
} from '../utils/export';
import {
  MULTI_OPERATOR_SITE_MAX_DISTANCE_METERS,
  groupColocatedAntennasForMap,
} from '../utils/geo';
import { EstadisticasView } from '../views/EstadisticasView';
import { MapaView } from '../views/MapaView';
import { NovedadesView } from '../views/NovedadesView';
import { WorkspaceProvider } from './WorkspaceProvider';
import {
  buildDerivedAntenasStructures,
  compareFrequencyRanges,
  filterAntenas,
  fuseVodafoneAntennasInDataset,
  getCanonicalSpanishProvince,
  getComunidadAutonomaByProvince,
  importAntenasJsonDataset,
  matchesAntennaBandsFilter,
  mergeLiveDeltaIntoAntenasDataset,
  normalizeAntennaBandsList,
  normalizeCommercialBandLabel,
  parseCustomAntenasJson,
  useFilteredAntenas,
} from './useAntenasData';
import {
  NOVEDADES_PAGE_SIZE_OPTIONS,
  NOVEDADES_SPANISH_COMUNIDADES,
  buildPaginationTokens,
  classifyFrequencyBandMhz,
  computeLatestScanNovedadesCounts,
  filterNovedades,
  formatScanDateTimeDmyHms,
  getNovedadAntennaGroupKey,
  getNovedadScanBatchKey,
  getNovedadesOperatorLabel,
  getNovedadesProvincesForComunidad,
  getOperatorRowBackground,
  importNovedadesJsonDataset,
  isLatestScanNovedad,
  isValidNovedadesPageSize,
  mergeLiveDeltaIntoNovedadesDataset,
  orderNovedadesGroupedByNewAntenna,
  paginateNovedades,
  parseCustomNovedadesJson,
  resolveNovedadComunidad,
  resolveNovedadProvince,
  splitFrequencyRangeLines,
  splitScanDateTimeLines,
} from './useNovedadesData';
import {
  accumulateLiveDeltaChunks,
  clearStoredScanDispatchToken,
  computeInterpolatedScanMetrics,
  fetchLiveScanStatus,
  formatScanPercentEs,
  getStoredScanDispatchToken,
  parseLiveScanDeltaChunk,
  parseScanStatusPayload,
  resetScanProgressInternalCacheForTests,
  setStoredScanDispatchToken,
  shouldIgnoreScheduleWorkflowRun,
  triggerForcedAntennasScan,
  type LiveScanMergedDelta,
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
    expect(baselineHtml).not.toContain('id="novedades-operator-filter"');
    expect(baselineHtml).not.toContain('id="novedades-location-filter"');
    expect(baselineHtml).toContain('id="novedades-op-chip-digi"');
    expect(baselineHtml).toContain('id="novedades-band-filter"');
    expect(baselineHtml).toContain('id="novedades-date-filter"');
    expect(baselineHtml).toContain('id="novedades-ccaa-filter"');
    expect(baselineHtml).toContain('id="novedades-province-filter"');
    expect(baselineHtml).toContain('18:00 h');

    const populatedHtml = await renderNovedadesWithDataset(
      createSampleNovedadesDataset(),
    );
    expect(populatedHtml.match(/<table\b/g)).toHaveLength(1);
    expect(populatedHtml).toContain('rgba(124, 58, 237, 0.5)');
    expect(populatedHtml).toContain('rgba(0, 102, 204, 0.5)');
    expect(populatedHtml).toContain('id="novedades-date-filter"');
    expect(populatedHtml).toContain('<span>Antena</span>');
    expect(populatedHtml).toContain(
      '<span class="novedades-operator-name">DIGI</span>',
    );
    expect(populatedHtml).toContain('<span>Frecuencia</span>');
    expect(populatedHtml).toContain(
      '<span class="novedades-operator-name">Telefonica</span>',
    );
    expect(populatedHtml).not.toContain('novedades-row-op-dot');
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
    queryClient.setQueryData(['scan-status'], null);

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

describe('Iconos planos sin bordes ni separadores blancos (createMultiOperatorSprite y capas WebGL)', () => {
  interface RecordedArcCall {
    x: number;
    y: number;
    radius: number;
    startAngle: number;
    endAngle: number;
  }

  class PolyfillImageData {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray<ArrayBuffer>;
    readonly colorSpace = 'srgb' as const;

    constructor(
      dataOrWidth: Uint8ClampedArray<ArrayBuffer> | number,
      widthOrHeight: number,
      maybeHeight?: number,
    ) {
      if (typeof dataOrWidth === 'number') {
        this.width = dataOrWidth;
        this.height = widthOrHeight;
        this.data = new Uint8ClampedArray(this.width * this.height * 4);
      } else {
        this.data = dataOrWidth;
        this.width = widthOrHeight;
        this.height = maybeHeight ?? 0;
      }
    }
  }

  function parseHexRgb(color: string): [number, number, number] {
    const cleaned = color.trim().replace(/^#/, '');
    if (cleaned.length === 6) {
      return [
        Number.parseInt(cleaned.slice(0, 2), 16),
        Number.parseInt(cleaned.slice(2, 4), 16),
        Number.parseInt(cleaned.slice(4, 6), 16),
      ];
    }
    return [0, 0, 0];
  }

  function extractCreateMultiOperatorSpriteSource(source: string): string {
    const marker = 'function createMultiOperatorSprite';
    const fnStart = source.indexOf(marker);
    if (fnStart < 0) {
      throw new Error(
        'No se encontró createMultiOperatorSprite en src/components/map/AntenasMap.tsx',
      );
    }
    const openBrace = source.indexOf('{', fnStart);
    let depth = 0;
    for (let i = openBrace; i < source.length; i++) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return source.slice(fnStart, i + 1);
        }
      }
    }
    throw new Error('Bloque createMultiOperatorSprite sin cierre balanceado');
  }

  it('createMultiOperatorSprite(["movistar", "vodafone", "digi"]) dibuja sectores planos sólidos sin borde blanco, sin separadores blancos, sin sombra ni núcleo central', () => {
    const antenasMapSource = antenasMapRawSource;
    const spriteFnSource =
      extractCreateMultiOperatorSpriteSource(antenasMapSource);

    // Verificación estructural del código fuente de AntenasMap.tsx:
    // ni createMultiOperatorSprite ni las capas de puntos/clústeres aplican trazos blancos exteriores
    expect(spriteFnSource).not.toMatch(/#ffffff|#fff\b/i);
    expect(spriteFnSource).not.toContain('.stroke(');
    expect(spriteFnSource).not.toContain('strokeStyle');
    expect(spriteFnSource).not.toContain('shadowBlur');
    expect(antenasMapSource).not.toContain('LAYER_CLUSTERS_HALO');
    expect(antenasMapSource).toMatch(
      /id:\s*LAYER_UNCLUSTERED[\s\S]*?'circle-stroke-width':\s*0/,
    );
    expect(antenasMapSource).toMatch(
      /id:\s*LAYER_CLUSTERS[\s\S]*?'circle-stroke-width':\s*0/,
    );

    // Mock instrumentado de CanvasRenderingContext2D con rasterizador real sobre Uint8ClampedArray
    const fillStylesAssigned: string[] = [];
    const strokeStylesAssigned: string[] = [];
    const shadowBlursAssigned: number[] = [];
    const arcCalls: RecordedArcCall[] = [];
    let strokeCallCount = 0;
    let fillCallCount = 0;
    let lineToCallCount = 0;

    let canvasWidth = 64;
    let canvasHeight = 64;
    let pixelBuffer = new Uint8ClampedArray(canvasWidth * canvasHeight * 4);
    let currentFillStyle = '#000000';
    let currentStrokeStyle = '#000000';
    let currentShadowBlur = 0;
    let currentMoveToCenter = false;
    let currentArc: RecordedArcCall | null = null;

    const mockCtx = {
      get fillStyle(): string {
        return currentFillStyle;
      },
      set fillStyle(val: string) {
        currentFillStyle = String(val);
        fillStylesAssigned.push(currentFillStyle);
      },
      get strokeStyle(): string {
        return currentStrokeStyle;
      },
      set strokeStyle(val: string) {
        currentStrokeStyle = String(val);
        strokeStylesAssigned.push(currentStrokeStyle);
      },
      get shadowBlur(): number {
        return currentShadowBlur;
      },
      set shadowBlur(val: number) {
        currentShadowBlur = Number(val);
        shadowBlursAssigned.push(currentShadowBlur);
      },
      lineWidth: 1,
      lineCap: 'butt',
      save(): void {},
      restore(): void {},
      beginPath(): void {
        currentMoveToCenter = false;
        currentArc = null;
      },
      closePath(): void {},
      moveTo(x: number, y: number): void {
        if (
          Math.abs(x - canvasWidth / 2) < 0.01 &&
          Math.abs(y - canvasHeight / 2) < 0.01
        ) {
          currentMoveToCenter = true;
        }
      },
      lineTo(): void {
        lineToCallCount += 1;
      },
      arc(
        x: number,
        y: number,
        radius: number,
        startAngle: number,
        endAngle: number,
      ): void {
        const rec: RecordedArcCall = { x, y, radius, startAngle, endAngle };
        arcCalls.push(rec);
        currentArc = rec;
      },
      stroke(): void {
        strokeCallCount += 1;
      },
      fill(): void {
        fillCallCount += 1;
        if (!currentArc) return;
        const [rCol, gCol, bCol] = parseHexRgb(currentFillStyle);
        const span = currentArc.endAngle - currentArc.startAngle;
        const isFullCircle =
          !currentMoveToCenter && span >= Math.PI * 2 - 1e-6;
        const twoPi = Math.PI * 2;

        for (let py = 0; py < canvasHeight; py++) {
          for (let px = 0; px < canvasWidth; px++) {
            const dx = px + 0.5 - currentArc.x;
            const dy = py + 0.5 - currentArc.y;
            if (Math.hypot(dx, dy) > currentArc.radius) continue;

            let inside = isFullCircle;
            if (!inside) {
              const rawAngle = Math.atan2(dy, dx);
              const rel =
                (((rawAngle - currentArc.startAngle) % twoPi) + twoPi) % twoPi;
              inside = rel <= span + 1e-9;
            }
            if (inside) {
              const offset = (py * canvasWidth + px) * 4;
              pixelBuffer[offset] = rCol;
              pixelBuffer[offset + 1] = gCol;
              pixelBuffer[offset + 2] = bCol;
              pixelBuffer[offset + 3] = 255;
            }
          }
        }
      },
      getImageData(
        _sx: number,
        _sy: number,
        sw: number,
        sh: number,
      ): ImageData {
        return new PolyfillImageData(
          new Uint8ClampedArray(pixelBuffer),
          sw,
          sh,
        ) as unknown as ImageData;
      },
    };

    const mockDocument = {
      createElement(tag: string) {
        if (tag !== 'canvas') {
          throw new Error(`Elemento inesperado en test de sprite: ${tag}`);
        }
        return {
          get width(): number {
            return canvasWidth;
          },
          set width(w: number) {
            canvasWidth = w;
            pixelBuffer = new Uint8ClampedArray(canvasWidth * canvasHeight * 4);
          },
          get height(): number {
            return canvasHeight;
          },
          set height(h: number) {
            canvasHeight = h;
            pixelBuffer = new Uint8ClampedArray(canvasWidth * canvasHeight * 4);
          },
          getContext(kind: string) {
            return kind === '2d' ? mockCtx : null;
          },
        };
      },
    };

    const maybeExported = (
      AntenasMapModule as Record<string, unknown>
    ).createMultiOperatorSprite;

    let spriteImage: ImageData;
    if (typeof maybeExported === 'function') {
      const prevDoc = globalThis.document;
      const prevImgData = globalThis.ImageData;
      Object.defineProperty(globalThis, 'document', {
        value: mockDocument,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, 'ImageData', {
        value: PolyfillImageData,
        configurable: true,
        writable: true,
      });
      try {
        spriteImage = (
          maybeExported as (ops: OperatorKey[]) => ImageData
        )(['movistar', 'vodafone', 'digi']);
      } finally {
        Object.defineProperty(globalThis, 'document', {
          value: prevDoc,
          configurable: true,
          writable: true,
        });
        Object.defineProperty(globalThis, 'ImageData', {
          value: prevImgData,
          configurable: true,
          writable: true,
        });
      }
    } else {
      const strippedJs = spriteFnSource
        .replace(/:\s*OperatorKey\[\]/g, '')
        .replace(/\):\s*ImageData\s*\{/, ') {')
        .replace(/:\s*boolean/g, '');
      const buildSpriteFn = globalThis.Function(
        'document',
        'ImageData',
        'OPERATOR_META',
        'Math',
        `${strippedJs}\nreturn createMultiOperatorSprite;`,
      ) as (
        doc: typeof mockDocument,
        imgCtor: typeof PolyfillImageData,
        opMeta: typeof OPERATOR_META,
        mathObj: Math,
      ) => (ops: OperatorKey[]) => ImageData;
      const compiledFn = buildSpriteFn(
        mockDocument,
        PolyfillImageData,
        OPERATOR_META,
        Math,
      );
      spriteImage = compiledFn(['movistar', 'vodafone', 'digi']);
    }

    expect(spriteImage.width).toBe(64);
    expect(spriteImage.height).toBe(64);

    // Cero trazos exteriores, cero líneas radiales separadoras, cero sombras, cero blanco (#FFFFFF)
    expect(strokeCallCount).toBe(0);
    expect(lineToCallCount).toBe(0);
    expect(strokeStylesAssigned).toEqual([]);
    expect(shadowBlursAssigned.every((v) => v <= 0)).toBe(true);
    for (const style of fillStylesAssigned) {
      expect(style.toUpperCase()).not.toBe('#FFFFFF');
      expect(style.toUpperCase()).not.toBe('#FFF');
      expect(style.toLowerCase()).not.toBe('white');
    }

    // Todos los rellenos usan únicamente los colores planos oficiales de los 3 operadores
    const allowedOperatorColors = new Set<string>([
      OPERATOR_META.movistar.color,
      OPERATOR_META.vodafone.color,
      OPERATOR_META.digi.color,
    ]);
    expect(fillCallCount).toBeGreaterThanOrEqual(4);
    for (const style of fillStylesAssigned) {
      expect(allowedOperatorColors.has(style)).toBe(true);
    }

    // Ningún arco pequeño de punto/núcleo central (todos los arcos usan el radio exterior completo 27)
    expect(arcCalls.length).toBeGreaterThanOrEqual(4);
    for (const call of arcCalls) {
      expect(call.radius).toBe(27);
    }

    // Verificación pixel a pixel en el ImageData resultante: cero píxeles blancos y sectores exactos
    const rgba = spriteImage.data;
    let opaquePixels = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      const a = rgba[i + 3];
      if (a > 0) {
        opaquePixels += 1;
        const isWhite =
          rgba[i] === 255 && rgba[i + 1] === 255 && rgba[i + 2] === 255;
        expect(isWhite).toBe(false);
      }
    }
    expect(opaquePixels).toBeGreaterThan(2000);

    const readPixelHex = (px: number, py: number): string => {
      const idx = (py * 64 + px) * 4;
      const hex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
      return `#${hex(rgba[idx])}${hex(rgba[idx + 1])}${hex(rgba[idx + 2])}`;
    };

    // Sector superior derecho (-30°): Movistar (#0066CC)
    expect(readPixelHex(44, 25)).toBe(OPERATOR_META.movistar.color);
    // Sector inferior (+90°): Vodafone (#DC2626)
    expect(readPixelHex(32, 46)).toBe(OPERATOR_META.vodafone.color);
    // Sector superior izquierdo (+210°): DIGI (#7C3AED)
    expect(readPixelHex(20, 25)).toBe(OPERATOR_META.digi.color);
    // Centro exacto (32, 32): sin núcleo blanco (#FFFFFF) ni punto oscuro (#0F172A)
    expect(readPixelHex(32, 32)).not.toBe('#FFFFFF');
    expect(readPixelHex(32, 32)).not.toBe('#0F172A');
    expect(allowedOperatorColors.has(readPixelHex(32, 32))).toBe(true);
  });
});

describe('Filtro territorial de 2 desplegables (Comunidad Autónoma + Provincia) y eliminación de presets', () => {
  it('mapea con exactitud las 19 Comunidades y Ciudades Autónomas españolas incluyendo variantes cooficiales y sin tildes', () => {
    // Variantes explícitas requeridas (cooficiales, insulares, ciudades autónomas y con/sin tilde)
    expect(getComunidadAutonomaByProvince('A CORUÑA')).toBe('Galicia');
    expect(getComunidadAutonomaByProvince('LA CORUÑA')).toBe('Galicia');
    expect(getComunidadAutonomaByProvince('OURENSE')).toBe('Galicia');
    expect(getComunidadAutonomaByProvince('ORENSE')).toBe('Galicia');
    expect(getComunidadAutonomaByProvince('LUGO')).toBe('Galicia');
    expect(getComunidadAutonomaByProvince('PONTEVEDRA')).toBe('Galicia');
    expect(getComunidadAutonomaByProvince('ILLES BALEARS')).toBe(
      'Illes Balears',
    );
    expect(getComunidadAutonomaByProvince('ISLAS BALEARES')).toBe(
      'Illes Balears',
    );
    expect(getComunidadAutonomaByProvince('BIZKAIA')).toBe('País Vasco');
    expect(getComunidadAutonomaByProvince('GIPUZKOA')).toBe('País Vasco');
    expect(getComunidadAutonomaByProvince('ÁLAVA')).toBe('País Vasco');
    expect(getComunidadAutonomaByProvince('ARABA/ÁLAVA')).toBe('País Vasco');
    expect(getComunidadAutonomaByProvince('LAS PALMAS')).toBe('Canarias');
    expect(getComunidadAutonomaByProvince('SANTA CRUZ DE TENERIFE')).toBe(
      'Canarias',
    );
    expect(getComunidadAutonomaByProvince('CEUTA')).toBe('Ceuta');
    expect(getComunidadAutonomaByProvince('MELILLA')).toBe('Melilla');

    // Cobertura completa de las 19 Comunidades / Ciudades Autónomas oficiales de España
    const representativeProvinces: ReadonlyArray<
      readonly [prov: string, expectedCcaa: string]
    > = [
      ['SEVILLA', 'Andalucía'],
      ['ZARAGOZA', 'Aragón'],
      ['ASTURIAS', 'Principado de Asturias'],
      ['ILLES BALEARS', 'Illes Balears'],
      ['LAS PALMAS', 'Canarias'],
      ['CANTABRIA', 'Cantabria'],
      ['TOLEDO', 'Castilla-La Mancha'],
      ['VALLADOLID', 'Castilla y León'],
      ['BARCELONA', 'Cataluña'],
      ['VALÈNCIA', 'Comunidad Valenciana'],
      ['CÁCERES', 'Extremadura'],
      ['A CORUÑA', 'Galicia'],
      ['MADRID', 'Comunidad de Madrid'],
      ['MURCIA', 'Región de Murcia'],
      ['NAVARRA', 'Comunidad Foral de Navarra'],
      ['BIZKAIA', 'País Vasco'],
      ['LA RIOJA', 'La Rioja'],
      ['CEUTA', 'Ceuta'],
      ['MELILLA', 'Melilla'],
    ];

    const resolvedComunidades = new Set<string>();
    for (const [prov, expectedCcaa] of representativeProvinces) {
      const ccaa = getComunidadAutonomaByProvince(prov);
      expect(ccaa).toBe(expectedCcaa);
      // También funciona en minúsculas y sin tildes
      expect(getComunidadAutonomaByProvince(normalizeSearchText(prov))).toBe(
        expectedCcaa,
      );
      resolvedComunidades.add(ccaa);
    }
    expect(resolvedComunidades.size).toBe(19);
    expect(getComunidadAutonomaByProvince('')).toBe('');
    expect(getComunidadAutonomaByProvince('SIN PROVINCIA')).toBe('');
  });

  it('puebla comunidadesByAlpha, provincesByComunidad y comunidadCentroids y filtra por selectedComunidad y selectedProvince', () => {
    const base = createSampleCustomDataset();
    const multiCcaaDataset: AntenasDataset = {
      ...base,
      total: 7,
      provinces: [
        { provincia: 'MADRID', count: 2, byOperator: { movistar: 1, orange: 1 } },
        { provincia: 'ÁLAVA', count: 1, byOperator: { movistar: 1 } },
        { provincia: 'A CORUÑA', count: 1, byOperator: { movistar: 1 } },
        { provincia: 'LUGO', count: 1, byOperator: { orange: 1 } },
        { provincia: 'OURENSE', count: 1, byOperator: { digi: 1 } },
        { provincia: 'PONTEVEDRA', count: 1, byOperator: { masmovil: 1 } },
      ],
      antenas: [
        ...base.antenas,
        {
          id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 1500001',
          gid: '1500001',
          op: 'movistar',
          opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
          lat: 43.3623,
          lon: -8.4115,
          dir: 'CANTÓN GRANDE 1',
          mun: 'A CORUÑA',
          prov: 'A CORUÑA',
        },
        {
          id: 'ORANGE ESPAGNE, S.A.U. - 2700001',
          gid: '2700001',
          op: 'orange',
          opRaw: 'ORANGE ESPAGNE, S.A.U.',
          lat: 43.0097,
          lon: -7.5568,
          dir: 'PRAZA MAIOR 1',
          mun: 'LUGO',
          prov: 'LUGO',
        },
        {
          id: 'DIGI SPAIN TELECOM, S.L.U. - 3200001',
          gid: '3200001',
          op: 'digi',
          opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
          lat: 42.3358,
          lon: -7.8639,
          dir: 'RÚA DO PASEO 10',
          mun: 'OURENSE',
          prov: 'OURENSE',
        },
        {
          id: 'XFERA MOVILES, S.A.U. - 3600001',
          gid: '3600001',
          op: 'masmovil',
          opRaw: 'XFERA MOVILES, S.A.U.',
          lat: 42.2406,
          lon: -8.7207,
          dir: 'PORTA DO SOL 5',
          mun: 'VIGO',
          prov: 'PONTEVEDRA',
        },
      ],
    };

    const derived = buildDerivedAntenasStructures(multiCcaaDataset);

    expect(derived.comunidadesByAlpha.map((c) => c.comunidad)).toEqual([
      'Comunidad de Madrid',
      'Galicia',
      'País Vasco',
    ]);

    const galiciaSummary = derived.comunidadesByAlpha.find(
      (c) => c.comunidad === 'Galicia',
    );
    expect(galiciaSummary?.count).toBe(4);
    expect(
      derived.provincesByComunidad.get('Galicia')?.map((p) => p.provincia),
    ).toEqual(['A CORUÑA', 'LUGO', 'OURENSE', 'PONTEVEDRA']);

    const galiciaCentroid = derived.comunidadCentroids.get('Galicia');
    expect(galiciaCentroid).toBeDefined();
    expect(galiciaCentroid?.lat).toBeCloseTo(
      (43.3623 + 43.0097 + 42.3358 + 42.2406) / 4,
      4,
    );
    expect(galiciaCentroid?.lon).toBeCloseTo(
      (-8.4115 - 7.5568 - 7.8639 - 8.7207) / 4,
      4,
    );

    // Filtrado exclusivo por Comunidad Autónoma ('Galicia') -> devuelve las 4 provincias gallegas
    expect(
      filterAntenas({
        derived,
        searchQuery: '',
        selectedComunidad: 'Galicia',
        selectedProvince: '',
        activeOperators: [...OPERATOR_ORDER],
      }).map((a) => a.gid),
    ).toEqual(['1500001', '2700001', '3200001', '3600001']);

    // Combinado selectedComunidad + selectedProvince
    expect(
      filterAntenas({
        derived,
        searchQuery: '',
        selectedComunidad: 'Galicia',
        selectedProvince: 'OURENSE',
        activeOperators: [...OPERATOR_ORDER],
      }).map((a) => a.gid),
    ).toEqual(['3200001']);

    // Provincia ajena a la Comunidad Autónoma seleccionada -> vacío
    expect(
      filterAntenas({
        derived,
        searchQuery: '',
        selectedComunidad: 'Galicia',
        selectedProvince: 'MADRID',
        activeOperators: [...OPERATOR_ORDER],
      }),
    ).toEqual([]);
  });

  it('renderiza en SSR #map-ccaa-select y #map-province-select sin #map-municipality-select ni botones .region-presets-row / preset-chip', async () => {
    const sample = createSampleCustomDataset();
    const derived = buildDerivedAntenasStructures(sample);

    const filterPanelHtml = renderToStaticMarkup(
      createElement(FilterPanel, {
        derived,
        filteredAntenas: derived.dataset.antenas,
        collapsed: false,
        mobileOpen: false,
        onCollapseDesktop: () => {},
        onCloseMobile: () => {},
        searchQuery: '',
        onSearchChange: () => {},
        selectedComunidad: 'País Vasco',
        onComunidadChange: () => {},
        selectedProvince: '',
        onProvinceChange: () => {},
        selectedBands: [],
        onToggleBand: () => {},
        onClearBands: () => {},
        exclusiveBands: false,
        onExclusiveBandsChange: () => {},
        activeOperators: [...OPERATOR_ORDER],
        onToggleOperator: () => {},
        onSelectAllOperators: () => {},
        onClearAllOperators: () => {},
        hasActiveFilters: true,
        onResetFilters: () => {},
        onFlyTo: () => {},
      }),
    );

    expect(filterPanelHtml).toContain('id="map-ccaa-select"');
    expect(filterPanelHtml).toContain('id="map-province-select"');
    expect(filterPanelHtml).toContain('Todas en País Vasco (1)');
    expect(filterPanelHtml).not.toContain('map-municipality-select');
    expect(filterPanelHtml).not.toContain('region-presets-row');
    expect(filterPanelHtml).not.toContain('preset-chip');

    // Verificación completa también sobre MapaView montado con Router y WorkspaceProvider
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['antenas-dataset'], sample);
    queryClient.setQueryData(['scan-status'], null);

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

    const mapaViewHtml = renderToStaticMarkup(
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

    expect(mapaViewHtml).toContain('id="map-search-input"');
    expect(mapaViewHtml).toContain('id="map-ccaa-select"');
    expect(mapaViewHtml).toContain('id="map-province-select"');
    expect(mapaViewHtml).not.toContain('map-municipality-select');
    expect(mapaViewHtml).not.toContain('region-presets-row');
    expect(mapaViewHtml).not.toContain('preset-chip');
  });
});

describe('Filtro multifrecuencia ilimitado y casilla "Exclusivamente"', () => {
  function createMultiBandTestDataset(): AntenasDataset {
    const base = createSampleCustomDataset();
    return {
      ...base,
      total: 6,
      antenas: [
        {
          ...base.antenas[0],
          gid: '2801001',
          id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2801001',
          bandas: ['3500 MHz'],
        },
        {
          ...base.antenas[1],
          gid: '2801002',
          id: 'ORANGE ESPAGNE, S.A.U. - 2801002',
          bandas: ['900 MHz', '3500 MHz'],
        },
        {
          ...base.antenas[2],
          gid: '0101003',
          id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 0101003',
          // Mismas 3 bandas exactas pero en distinto orden
          bandas: ['3500 MHz', '800 MHz', '1800 MHz'],
        },
        {
          id: 'DIGI SPAIN TELECOM, S.L.U. - 2801004',
          gid: '2801004',
          op: 'digi',
          opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
          lat: 40.43,
          lon: -3.69,
          dir: 'CASTELLANA 100',
          mun: 'MADRID',
          prov: 'MADRID',
          // Subconjunto ("ni menos")
          bandas: ['800 MHz', '1800 MHz'],
        },
        {
          id: 'XFERA MOVILES, S.A.U. - 2801005',
          gid: '2801005',
          op: 'masmovil',
          opRaw: 'XFERA MOVILES, S.A.U.',
          lat: 40.44,
          lon: -3.68,
          dir: 'CASTELLANA 200',
          mun: 'MADRID',
          prov: 'MADRID',
          // Superconjunto ("ni más")
          bandas: ['700 MHz', '800 MHz', '1800 MHz', '3500 MHz'],
        },
        {
          id: 'VODAFONE ESPAÑA, S.A.U. - 2801006',
          gid: '2801006',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          lat: 40.45,
          lon: -3.67,
          dir: 'ALCALÁ 300',
          mun: 'MADRID',
          prov: 'MADRID',
          bandas: undefined,
        },
      ],
    };
  }

  it('modo unión/OR por defecto (exclusiveBands: false): admite 3+ bandas simultáneas y devuelve antenas con al menos 1 de ellas', () => {
    const selected = ['700 MHz', '2100 MHz', '3500 MHz'];

    expect(
      matchesAntennaBandsFilter(['800 MHz', '900 MHz', '3500 MHz'], selected, false),
    ).toBe(true);
    expect(
      matchesAntennaBandsFilter(['700 MHz', '900 MHz'], selected, false),
    ).toBe(true);
    expect(
      matchesAntennaBandsFilter(['800 MHz', '900 MHz', '1800 MHz'], selected, false),
    ).toBe(false);
    expect(matchesAntennaBandsFilter([], selected, false)).toBe(false);
    expect(matchesAntennaBandsFilter(undefined, selected, false)).toBe(false);

    const derived = buildDerivedAntenasStructures(createMultiBandTestDataset());
    expect(
      filterAntenas({
        derived,
        searchQuery: '',
        selectedComunidad: '',
        selectedProvince: '',
        activeOperators: [...OPERATOR_ORDER],
        selectedBands: selected,
        exclusiveBands: false,
      }).map((a) => a.gid),
    ).toEqual(['2801001', '2801002', '0101003', '2801005']);
  });

  it('modo "Exclusivamente" (exclusiveBands: true) con 1 frecuencia rechaza antenas con bandas adicionales, vacías o undefined', () => {
    expect(matchesAntennaBandsFilter(['3500 MHz'], ['3500 MHz'], true)).toBe(
      true,
    );
    expect(
      matchesAntennaBandsFilter(['900 MHz', '3500 MHz'], ['3500 MHz'], true),
    ).toBe(false);
    expect(matchesAntennaBandsFilter([], ['3500 MHz'], true)).toBe(false);
    expect(matchesAntennaBandsFilter(undefined, ['3500 MHz'], true)).toBe(
      false,
    );

    const derived = buildDerivedAntenasStructures(createMultiBandTestDataset());
    expect(
      filterAntenas({
        derived,
        searchQuery: '',
        selectedComunidad: '',
        selectedProvince: '',
        activeOperators: [...OPERATOR_ORDER],
        selectedBands: ['3500 MHz'],
        exclusiveBands: true,
      }).map((a) => a.gid),
    ).toEqual(['2801001']);
  });

  it('modo "Exclusivamente" (exclusiveBands: true) con múltiples frecuencias exige igualdad exacta de conjunto ("ni más ni menos") sin importar el orden', () => {
    const targetThree = ['800 MHz', '1800 MHz', '3500 MHz'];

    // Igualdad exacta de conjunto independientemente del orden
    expect(
      matchesAntennaBandsFilter(
        ['3500 MHz', '800 MHz', '1800 MHz'],
        targetThree,
        true,
      ),
    ).toBe(true);
    // Subconjunto ("ni menos") -> rechazado
    expect(
      matchesAntennaBandsFilter(['800 MHz', '1800 MHz'], targetThree, true),
    ).toBe(false);
    // Superconjunto ("ni más") -> rechazado
    expect(
      matchesAntennaBandsFilter(
        ['700 MHz', '800 MHz', '1800 MHz', '3500 MHz'],
        targetThree,
        true,
      ),
    ).toBe(false);
    // Selección de 4 frecuencias exactas sin límite superior artificial
    expect(
      matchesAntennaBandsFilter(
        ['3500 MHz', '700 MHz', '1800 MHz', '800 MHz'],
        ['700 MHz', '800 MHz', '1800 MHz', '3500 MHz'],
        true,
      ),
    ).toBe(true);

    const derived = buildDerivedAntenasStructures(createMultiBandTestDataset());
    expect(
      filterAntenas({
        derived,
        searchQuery: '',
        selectedComunidad: '',
        selectedProvince: '',
        activeOperators: [...OPERATOR_ORDER],
        selectedBands: targetThree,
        exclusiveBands: true,
      }).map((a) => a.gid),
    ).toEqual(['0101003']);
  });

  it('renderiza en FilterPanel SSR las píldoras multifrecuencia activas simultáneamente y el checkbox #filter-bands-exclusive-checkbox ("Exclusivamente")', () => {
    const derived = buildDerivedAntenasStructures(createMultiBandTestDataset());

    const html = renderToStaticMarkup(
      createElement(FilterPanel, {
        derived,
        filteredAntenas: [derived.dataset.antenas[2]],
        collapsed: false,
        mobileOpen: false,
        onCollapseDesktop: () => {},
        onCloseMobile: () => {},
        searchQuery: '',
        onSearchChange: () => {},
        selectedComunidad: '',
        onComunidadChange: () => {},
        selectedProvince: '',
        onProvinceChange: () => {},
        selectedBands: ['800 MHz', '1800 MHz', '3500 MHz'],
        onToggleBand: () => {},
        onClearBands: () => {},
        exclusiveBands: true,
        onExclusiveBandsChange: () => {},
        activeOperators: [...OPERATOR_ORDER],
        onToggleOperator: () => {},
        onSelectAllOperators: () => {},
        onClearAllOperators: () => {},
        hasActiveFilters: true,
        onResetFilters: () => {},
        onFlyTo: () => {},
      }),
    );

    expect(html).toContain('id="filter-band-800-mhz"');
    expect(html).toContain('id="filter-band-1800-mhz"');
    expect(html).toContain('id="filter-band-3500-mhz"');
    expect(html.match(/class="band-filter-pill is-active"/g)).toHaveLength(3);
    expect(html).toContain('id="bands-select-all-btn"');
    expect(html).toContain('id="filter-bands-exclusive-checkbox"');
    expect(html).toContain('Exclusivamente');
    expect(html).toContain('ni más ni menos');
    expect(html).toContain('checked=""');
  });
});

describe('Streaming de deltas en tiempo real (parseLiveScanDeltaChunk, accumulateLiveDeltaChunks, mergeLiveDeltaIntoAntenasDataset y mergeLiveDeltaIntoNovedadesDataset)', () => {
  it('parseLiveScanDeltaChunk valida el esquema JSON propio (directo y Base64) y rechaza explícitamente GeoJSON (FeatureCollection / Feature)', () => {
    // Rechaza raíz FeatureCollection y Feature
    expect(() =>
      parseLiveScanDeltaChunk({
        type: 'FeatureCollection',
        features: [],
      }),
    ).toThrow(/GeoJSON/i);

    expect(() =>
      parseLiveScanDeltaChunk({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-3.7038, 40.4168] },
        properties: { Gis_ID: '2800001' },
      }),
    ).toThrow(/GeoJSON/i);

    // Rechaza entidades GeoJSON infiltradas dentro de newAntennas, bandPatches o envoltorio Base64
    expect(() =>
      parseLiveScanDeltaChunk({
        schemaVersion: 2,
        scanId: 'scan-live-1',
        seq: 1,
        chunkIndex: 0,
        isTail: true,
        updatedAt: '2026-11-15T18:01:00Z',
        recordNovedades: true,
        previousScanAt: '2026-11-14T18:00:00Z',
        newAntennas: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-3.7038, 40.4168] },
            properties: {},
          },
        ],
        bandPatches: [],
        novedades: [],
      }),
    ).toThrow(/GeoJSON/i);

    const b64GeoJson = btoa(
      JSON.stringify({ type: 'FeatureCollection', features: [] }),
    );
    expect(() =>
      parseLiveScanDeltaChunk({
        content: b64GeoJson,
        encoding: 'base64',
      }),
    ).toThrow(/GeoJSON/i);

    // Entradas inválidas o no-objeto devuelven null sin lanzar excepción
    expect(parseLiveScanDeltaChunk(null)).toBeNull();
    expect(parseLiveScanDeltaChunk({ scanId: '' })).toBeNull();
    expect(
      parseLiveScanDeltaChunk({ scanId: 'scan-bad', newAntennas: 'invalid' }),
    ).toBeNull();

    // Valida chunk válido tanto directo como envuelto en Base64 de GitHub Contents API
    const validChunk: LiveScanDeltaChunk = {
      schemaVersion: 2,
      scanId: 'daily-2026-11-15',
      seq: 2,
      chunkIndex: 0,
      isTail: false,
      updatedAt: '2026-11-15T18:02:10Z',
      recordNovedades: true,
      previousScanAt: '2026-11-14T18:00:00Z',
      replacesNewAntennas: false,
      newAntennas: [
        {
          id: 'DIGI SPAIN TELECOM, S.L.U. - 2808801',
          gid: '2808801',
          op: 'digi',
          opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
          lat: 40.421,
          lon: -3.701,
          dir: 'FUENCARRAL 45',
          mun: 'MADRID',
          prov: 'MADRID',
        },
      ],
      bandPatches: [
        {
          id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800001',
          gid: '2800001',
          bandas: ['800 MHz', '3500 MHz'],
          frecuencias: ['801.00 - 811.00', '3460.00 - 3600.00'],
          concesiones: [{ ref: 'M M -2205199', freq: '3460.00 - 3600.00' }],
          bandsScannedAt: '2026-11-15T18:02:09Z',
        },
      ],
      novedades: [
        {
          id: 'antena::DIGI SPAIN TELECOM, S.L.U. - 2808801',
          tipo: 'antena',
          op: 'digi',
          opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
          codigo: '2808801',
          antennaId: 'DIGI SPAIN TELECOM, S.L.U. - 2808801',
          codigoBanda: '',
          frecuencia: '',
          ubicacion: 'MADRID',
          prov: 'MADRID',
          scannedAt: '2026-11-15T18:02:05Z',
          fecha: '15/11/2026 19:02:05',
        },
      ],
    };

    expect(parseLiveScanDeltaChunk(validChunk)).toEqual(validChunk);

    const b64Valid = btoa(
      String.fromCharCode(...new TextEncoder().encode(JSON.stringify(validChunk))),
    );
    expect(
      parseLiveScanDeltaChunk({
        content: `${b64Valid.slice(0, 32)}\n${b64Valid.slice(32)}`,
        encoding: 'base64',
      }),
    ).toEqual(validChunk);
  });

  it('accumulateLiveDeltaChunks acumula múltiples chunks + tail, aplica replacesNewAntennas tras la fusión de Vodafone y enriquece bandas al instante', () => {
    // Chunk 0: descubrimiento provisional en fase de censo (con 2 Vodafone aún sin fusionar)
    const chunk0: LiveScanDeltaChunk = {
      schemaVersion: 2,
      scanId: 'scan-stream-100',
      seq: 1,
      chunkIndex: 0,
      isTail: false,
      updatedAt: '2026-11-15T18:01:00Z',
      recordNovedades: true,
      previousScanAt: '2026-11-14T18:00:00Z',
      newAntennas: [
        {
          id: 'VODAFONE ESPAÑA, S.A.U. - 0289900',
          gid: '0289900',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          lat: 40.425,
          lon: -3.695,
          dir: 'SERRANO 50',
          mun: 'MADRID',
          prov: 'MADRID',
        },
        {
          id: 'VODAFONE ESPAÑA, S.A.U. - 289900',
          gid: '289900',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          lat: 40.42508, // ~8.9 m (< 35 m)
          lon: -3.695,
          dir: 'SERRANO 50',
          mun: 'MADRID',
          prov: 'MADRID',
        },
      ],
      bandPatches: [],
      novedades: [
        {
          id: 'antena::VODAFONE ESPAÑA, S.A.U. - 0289900',
          tipo: 'antena',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          codigo: '0289900',
          antennaId: 'VODAFONE ESPAÑA, S.A.U. - 0289900',
          codigoBanda: '',
          frecuencia: '',
          ubicacion: 'MADRID',
          prov: 'MADRID',
          scannedAt: '2026-11-15T18:00:55Z',
          fecha: '15/11/2026 19:00:55',
        },
        {
          id: 'antena::VODAFONE ESPAÑA, S.A.U. - 289900',
          tipo: 'antena',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          codigo: '289900',
          antennaId: 'VODAFONE ESPAÑA, S.A.U. - 289900',
          codigoBanda: '',
          frecuencia: '',
          ubicacion: 'MADRID',
          prov: 'MADRID',
          scannedAt: '2026-11-15T18:00:56Z',
          fecha: '15/11/2026 19:00:56',
        },
      ],
    };

    // Chunk 1: fin del censo con replacesNewAntennas: true (Vodafone ya fusionada en estación canónica + nueva DIGI)
    const chunk1: LiveScanDeltaChunk = {
      schemaVersion: 2,
      scanId: 'scan-stream-100',
      seq: 2,
      chunkIndex: 1,
      isTail: false,
      updatedAt: '2026-11-15T18:02:00Z',
      recordNovedades: true,
      previousScanAt: '2026-11-14T18:00:00Z',
      replacesNewAntennas: true,
      newAntennas: [
        {
          id: 'VODAFONE ESPAÑA, S.A.U. - 289900',
          gid: '289900',
          mergedGids: ['289900', '0289900'],
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          lat: 40.42508,
          lon: -3.695,
          dir: 'SERRANO 50',
          mun: 'MADRID',
          prov: 'MADRID',
        },
        {
          id: 'DIGI SPAIN TELECOM, S.L.U. - 2808801',
          gid: '2808801',
          op: 'digi',
          opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
          lat: 40.421,
          lon: -3.701,
          dir: 'FUENCARRAL 45',
          mun: 'MADRID',
          prov: 'MADRID',
        },
      ],
      bandPatches: [],
      novedades: [
        {
          id: 'antena::VODAFONE ESPAÑA, S.A.U. - 289900',
          tipo: 'antena',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          codigo: '289900',
          antennaId: 'VODAFONE ESPAÑA, S.A.U. - 289900',
          codigoBanda: '',
          frecuencia: '',
          ubicacion: 'MADRID',
          prov: 'MADRID',
          scannedAt: '2026-11-15T18:01:58Z',
          fecha: '15/11/2026 19:01:58',
        },
        {
          id: 'antena::DIGI SPAIN TELECOM, S.L.U. - 2808801',
          tipo: 'antena',
          op: 'digi',
          opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
          codigo: '2808801',
          antennaId: 'DIGI SPAIN TELECOM, S.L.U. - 2808801',
          codigoBanda: '',
          frecuencia: '',
          ubicacion: 'MADRID',
          prov: 'MADRID',
          scannedAt: '2026-11-15T18:01:59Z',
          fecha: '15/11/2026 19:01:59',
        },
      ],
    };

    // Tail: fase de frecuencias con bandPatches sobre antena existente y sobre nuevas antenas + novedad de frecuencia
    const tailChunk: LiveScanDeltaChunk = {
      schemaVersion: 2,
      scanId: 'scan-stream-100',
      seq: 3,
      chunkIndex: 2,
      isTail: true,
      updatedAt: '2026-11-15T18:03:30Z',
      recordNovedades: true,
      previousScanAt: '2026-11-14T18:00:00Z',
      newAntennas: [],
      bandPatches: [
        {
          id: 'DIGI SPAIN TELECOM, S.L.U. - 2808801',
          gid: '2808801',
          bandas: ['700 MHz', '3500 MHz'],
          frecuencias: ['758.00 - 768.00', '3400.00 - 3420.00'],
          concesiones: [{ ref: 'DG-700-1', freq: '758.00 - 768.00' }],
          bandsScannedAt: '2026-11-15T18:03:10Z',
        },
        {
          id: 'VODAFONE ESPAÑA, S.A.U. - 289900',
          gid: '289900',
          mergedGids: ['289900', '0289900'],
          bandas: ['800 MHz', '2100 MHz'],
          frecuencias: ['791.00 - 801.00', '2155.00 - 2170.00'],
          concesiones: [{ ref: 'VF-800-1', freq: '791.00 - 801.00' }],
          bandsScannedAt: '2026-11-15T18:03:20Z',
        },
        {
          id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800001',
          gid: '2800001',
          bandas: ['800 MHz', '2600 MHz', '3500 MHz'],
          frecuencias: [
            '801.00 - 811.00',
            '2620.00 - 2640.00',
            '3460.00 - 3600.00',
          ],
          concesiones: [{ ref: 'M M -2205199', freq: '3460.00 - 3600.00' }],
          bandsScannedAt: '2026-11-15T18:03:29Z',
        },
      ],
      novedades: [
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
          scannedAt: '2026-11-15T18:03:29Z',
          fecha: '15/11/2026 19:03:29',
        },
      ],
    };

    // Un chunk huérfano de otro scanId debe ser ignorado por completo
    const staleOtherScanChunk: LiveScanDeltaChunk = {
      ...tailChunk,
      scanId: 'scan-other-old',
      seq: 99,
    };

    const accumulated = accumulateLiveDeltaChunks(
      [chunk0, chunk1, tailChunk, staleOtherScanChunk],
      'scan-stream-100',
    );

    expect(accumulated.scanId).toBe('scan-stream-100');
    expect(accumulated.deltaSeq).toBe(3);
    expect(accumulated.recordNovedades).toBe(true);
    expect(accumulated.previousScanAt).toBe('2026-11-14T18:00:00Z');
    expect(accumulated.updatedAt).toBe('2026-11-15T18:03:30Z');

    // Las antenas provisionales de chunk0 fueron sustituidas por las canónicas de chunk1 y enriquecidas por tailChunk
    expect(accumulated.newAntennas).toHaveLength(2);
    expect(accumulated.newAntennas.map((a) => a.gid)).toEqual([
      '289900',
      '2808801',
    ]);
    expect(accumulated.newAntennas[0]?.mergedGids).toEqual([
      '289900',
      '0289900',
    ]);
    expect(accumulated.newAntennas[0]?.bandas).toEqual(['800 MHz', '2100 MHz']);
    expect(accumulated.newAntennas[1]?.bandas).toEqual(['700 MHz', '3500 MHz']);

    // Índice de parches por GID incluye tanto gid primario como mergedGids
    expect(accumulated.bandPatchesByGid.get('0289900')?.bandas).toEqual([
      '800 MHz',
      '2100 MHz',
    ]);

    // Novedad provisional 0289900 eliminada tras replacesNewAntennas; ordenadas de más reciente a más antigua
    expect(accumulated.novedades.map((n) => n.codigo)).toEqual([
      '2800001',
      '2808801',
      '289900',
    ]);
  });

  it('mergeLiveDeltaIntoAntenasDataset incorpora antenas nuevas (sin fusionar Movistar < 35 m), actualiza bandas/frecuencias/concesiones al instante y hace no-op sin copia al completarse', () => {
    const base = createSampleCustomDataset();

    const liveChunk: LiveScanDeltaChunk = {
      schemaVersion: 2,
      scanId: 'scan-live-antenas',
      seq: 5,
      chunkIndex: 0,
      isTail: true,
      updatedAt: '2026-11-15T18:10:00Z',
      recordNovedades: true,
      previousScanAt: '2026-11-15T04:00:00Z',
      newAntennas: [
        // Nueva DIGI en Madrid con 700 MHz + 3500 MHz
        {
          id: 'DIGI SPAIN TELECOM, S.L.U. - 2808801',
          gid: '2808801',
          op: 'digi',
          opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
          lat: 40.421,
          lon: -3.701,
          dir: 'FUENCARRAL 45',
          mun: 'MADRID',
          prov: 'MADRID',
          bandas: ['700 MHz', '3500 MHz'],
          frecuencias: ['758.00 - 768.00', '3400.00 - 3420.00'],
          concesiones: [{ ref: 'DG-700-1', freq: '758.00 - 768.00' }],
          bandsScannedAt: '2026-11-15T18:09:40Z',
        },
        // Nueva Movistar a ~8.9 m (< 35 m) de la Movistar existente 2800001 (40.4168, -3.7038):
        // ¡JAMÁS debe fusionarse consigo misma!
        {
          id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800097',
          gid: '2800097',
          op: 'movistar',
          opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
          lat: 40.41688,
          lon: -3.7038,
          dir: 'GRAN VIA 28 DUP',
          mun: 'MADRID',
          prov: 'MADRID',
          bandas: ['1800 MHz'],
          frecuencias: ['1825.00 - 1845.00'],
          concesiones: [{ ref: 'M M -1800097', freq: '1825.00 - 1845.00' }],
          bandsScannedAt: '2026-11-15T18:09:50Z',
        },
        // Par de nuevas Vodafone a ~11 m (< 35 m) entre sí: sí se fusionan en 1 sola antena Vodafone
        {
          id: 'VODAFONE ESPAÑA, S.A.U. - 289900',
          gid: '289900',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          lat: 40.43,
          lon: -3.69,
          dir: 'CASTELLANA 80',
          mun: 'MADRID',
          prov: 'MADRID',
          bandas: ['800 MHz'],
        },
        {
          id: 'VODAFONE ESPAÑA, S.A.U. - 0289900',
          gid: '0289900',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          lat: 40.4301,
          lon: -3.69,
          dir: 'CASTELLANA 80',
          mun: 'MADRID',
          prov: 'MADRID',
          bandas: ['2100 MHz'],
        },
      ],
      bandPatches: [
        // Parche en vivo sobre la antena existente TELEFONICA - 2800001
        {
          id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800001',
          gid: '2800001',
          bandas: ['800 MHz', '2600 MHz', '3500 MHz'],
          frecuencias: [
            '801.00 - 811.00',
            '2620.00 - 2640.00',
            '3460.00 - 3600.00',
          ],
          concesiones: [{ ref: 'M M -2205199', freq: '3460.00 - 3600.00' }],
          bandsScannedAt: '2026-11-15T18:09:59Z',
        },
      ],
      novedades: [],
    };

    const delta = accumulateLiveDeltaChunks([liveChunk], 'scan-live-antenas');
    const mergedDataset = mergeLiveDeltaIntoAntenasDataset(base, delta);

    // 3 base + 1 DIGI + 1 Movistar (< 35 m, NO fusionada) + 1 Vodafone (2 fusionadas) = 6 antenas
    expect(mergedDataset.total).toBe(6);
    expect(mergedDataset.operators.movistar.count).toBe(3);
    expect(mergedDataset.operators.digi.count).toBe(1);
    expect(mergedDataset.operators.vodafone.count).toBe(1);

    const derived = buildDerivedAntenasStructures(mergedDataset);

    // Movistar 2800001 y Movistar 2800097 (< 35 m) se mantienen estrictamente separadas
    const movExisting = derived.byGid.get('2800001');
    const movNewClose = derived.byGid.get('2800097');
    expect(movExisting).toBeDefined();
    expect(movNewClose).toBeDefined();
    expect(movExisting).not.toBe(movNewClose);
    expect(movExisting?.mergedGids).toBeUndefined();
    expect(movNewClose?.mergedGids).toBeUndefined();

    // La antena existente 2800001 refleja de inmediato sus bandas, frecuencias y concesiones
    expect(movExisting?.bandas).toEqual(['800 MHz', '2600 MHz', '3500 MHz']);
    expect(movExisting?.frecuencias).toEqual([
      '801.00 - 811.00',
      '2620.00 - 2640.00',
      '3460.00 - 3600.00',
    ]);
    expect(movExisting?.concesiones).toEqual([
      { ref: 'M M -2205199', freq: '3460.00 - 3600.00' },
    ]);

    // availableBands y filterAntenas reconocen de inmediato las nuevas bandas en vivo
    expect(derived.availableBands.map((b) => b.band)).toEqual([
      '700 MHz',
      '800 MHz',
      '1800 MHz',
      '2100 MHz',
      '2600 MHz',
      '3500 MHz',
    ]);

    expect(
      filterAntenas({
        derived,
        searchQuery: '',
        selectedComunidad: '',
        selectedProvince: '',
        activeOperators: [...OPERATOR_ORDER],
        selectedBands: ['2600 MHz'],
        exclusiveBands: false,
      }).map((a) => a.gid),
    ).toEqual(['2800001']);

    expect(
      filterAntenas({
        derived,
        searchQuery: '',
        selectedComunidad: '',
        selectedProvince: '',
        activeOperators: [...OPERATOR_ORDER],
        selectedBands: ['700 MHz', '3500 MHz'],
        exclusiveBands: true,
      }).map((a) => a.gid),
    ).toEqual(['2808801']);

    // Zero-copy no-op cuando delta es null/undefined o cuando baseDataset.updatedAt >= delta.completedDatasetUpdatedAt
    expect(mergeLiveDeltaIntoAntenasDataset(base, null)).toBe(base);
    expect(mergeLiveDeltaIntoAntenasDataset(base, undefined)).toBe(base);

    const completedStaticDataset: AntenasDataset = {
      ...mergedDataset,
      updatedAt: '2026-11-15T18:25:00Z',
    };
    const deltaCompletedEqual: LiveScanMergedDelta = {
      ...delta,
      completedDatasetUpdatedAt: '2026-11-15T18:25:00Z',
    };
    const deltaCompletedOlder: LiveScanMergedDelta = {
      ...delta,
      completedDatasetUpdatedAt: '2026-11-15T18:20:00Z',
    };

    expect(
      mergeLiveDeltaIntoAntenasDataset(
        completedStaticDataset,
        deltaCompletedEqual,
      ),
    ).toBe(completedStaticDataset);
    expect(
      mergeLiveDeltaIntoAntenasDataset(
        completedStaticDataset,
        deltaCompletedOlder,
      ),
    ).toBe(completedStaticDataset);
  });

  it('mergeLiveDeltaIntoNovedadesDataset incorpora antenas y frecuencias nuevas con recordNovedades === true y deja intacto NovedadesDataset con recordNovedades === false', () => {
    const baseNovedades: NovedadesDataset = {
      updatedAt: '2026-11-14T18:20:00Z',
      scanId: 'daily-2026-11-14',
      previousScanAt: '2026-11-13T18:19:00Z',
      isBaselineScan: false,
      total: 1,
      antenasNuevas: 1,
      frecuenciasNuevas: 0,
      novedades: [
        {
          id: 'antena::ORANGE ESPAGNE, S.A.U. - 2800002',
          tipo: 'antena',
          op: 'orange',
          opRaw: 'ORANGE ESPAGNE, S.A.U.',
          codigo: '2800002',
          antennaId: 'ORANGE ESPAGNE, S.A.U. - 2800002',
          codigoBanda: '',
          frecuencia: '',
          ubicacion: 'ALCALÁ DE HENARES',
          prov: 'MADRID',
          scannedAt: '2026-11-14T18:15:00Z',
          fecha: '14/11/2026 19:15:00',
        },
      ],
    };

    const dailyChunk: LiveScanDeltaChunk = {
      schemaVersion: 2,
      scanId: 'daily-2026-11-15',
      seq: 4,
      chunkIndex: 0,
      isTail: true,
      updatedAt: '2026-11-15T18:06:00Z',
      recordNovedades: true,
      previousScanAt: '2026-11-14T18:20:00Z',
      newAntennas: [],
      bandPatches: [],
      novedades: [
        {
          id: 'antena::DIGI SPAIN TELECOM, S.L.U. - 2808801',
          tipo: 'antena',
          op: 'digi',
          opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
          codigo: '2808801',
          antennaId: 'DIGI SPAIN TELECOM, S.L.U. - 2808801',
          codigoBanda: '',
          frecuencia: '',
          ubicacion: 'MADRID',
          prov: 'MADRID',
          scannedAt: '2026-11-15T18:05:10Z',
          fecha: '15/11/2026 19:05:10',
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
          scannedAt: '2026-11-15T18:05:50Z',
          fecha: '15/11/2026 19:05:50',
        },
        {
          id: 'freq::TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800001::M M -1100800::801.00 - 811.00 MHz',
          tipo: 'frecuencia',
          op: 'movistar',
          opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
          codigo: '2800001',
          antennaId: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800001',
          codigoBanda: 'M M -1100800',
          frecuencia: '801.00 - 811.00 MHz',
          ubicacion: 'MADRID',
          prov: 'MADRID',
          scannedAt: '2026-11-15T18:05:55Z',
          fecha: '15/11/2026 19:05:55',
        },
      ],
    };

    const dailyDelta = accumulateLiveDeltaChunks(
      [dailyChunk],
      'daily-2026-11-15',
    );
    const mergedDaily = mergeLiveDeltaIntoNovedadesDataset(
      baseNovedades,
      dailyDelta,
    );

    expect(mergedDaily.scanId).toBe('daily-2026-11-15');
    expect(mergedDaily.previousScanAt).toBe('2026-11-14T18:20:00Z');
    expect(mergedDaily.isBaselineScan).toBe(false);
    expect(mergedDaily.antenasNuevas).toBe(2);
    expect(mergedDaily.frecuenciasNuevas).toBe(2);
    expect(mergedDaily.total).toBe(4);
    expect(mergedDaily.novedades.map((n) => n.id)).toEqual([
      'antena::DIGI SPAIN TELECOM, S.L.U. - 2808801',
      'freq::TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800001::M M -1100800::801.00 - 811.00 MHz',
      'freq::TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800001::M M -2205199::3460.00 - 3600.00 MHz',
      'antena::ORANGE ESPAGNE, S.A.U. - 2800002',
    ]);

    // Escaneo forzado de línea base (recordNovedades === false): deja NovedadesDataset intacto (misma referencia)
    const forcedBaselineChunk: LiveScanDeltaChunk = {
      ...dailyChunk,
      scanId: 'forced-baseline-2026-11-15',
      recordNovedades: false,
    };
    const forcedDelta = accumulateLiveDeltaChunks(
      [forcedBaselineChunk],
      'forced-baseline-2026-11-15',
    );
    expect(forcedDelta.recordNovedades).toBe(false);
    expect(mergeLiveDeltaIntoNovedadesDataset(baseNovedades, forcedDelta)).toBe(
      baseNovedades,
    );
    expect(mergeLiveDeltaIntoNovedadesDataset(baseNovedades, null)).toBe(
      baseNovedades,
    );

    // Zero-copy no-op cuando el dataset estático ya incluye el escaneo completado
    const completedNov: NovedadesDataset = {
      ...mergedDaily,
      updatedAt: '2026-11-15T18:30:00Z',
    };
    expect(
      mergeLiveDeltaIntoNovedadesDataset(completedNov, {
        ...dailyDelta,
        completedDatasetUpdatedAt: '2026-11-15T18:30:00Z',
      }),
    ).toBe(completedNov);
  });

  it('renderiza en SSR en tiempo real las antenas, frecuencias y novedades en vivo desde la caché de live-scan-delta', async () => {
    const baseAntenas = createSampleCustomDataset();
    const baseNovedades: NovedadesDataset = {
      updatedAt: '2026-11-14T18:20:00Z',
      scanId: 'daily-2026-11-14',
      previousScanAt: null,
      isBaselineScan: true,
      total: 0,
      antenasNuevas: 0,
      frecuenciasNuevas: 0,
      novedades: [],
    };

    const liveScanStatus: ScanStatusPayload = {
      schemaVersion: 2,
      state: 'running',
      scanId: 'live-ssr-77',
      trigger: 'schedule',
      recordNovedades: true,
      part: '1/1',
      phase: 'frecuencias',
      startedAt: '2026-11-15T18:00:00Z',
      updatedAt: '2026-11-15T18:05:00Z',
      censusBoxesVisited: 239,
      estimatedCensusBoxes: 239,
      discoveredAntennas: 4,
      scannedAntennas: 2,
      totalAntennas: 4,
      percent: 50,
      deltaSeq: 2,
      chunkCount: 1,
    };

    const liveDelta = accumulateLiveDeltaChunks(
      [
        {
          schemaVersion: 2,
          scanId: 'live-ssr-77',
          seq: 2,
          chunkIndex: 0,
          isTail: true,
          updatedAt: '2026-11-15T18:05:00Z',
          recordNovedades: true,
          previousScanAt: '2026-11-14T18:20:00Z',
          newAntennas: [
            {
              id: 'DIGI SPAIN TELECOM, S.L.U. - 2809955',
              gid: '2809955',
              op: 'digi',
              opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
              lat: 40.422,
              lon: -3.702,
              dir: 'HORTALEZA 10',
              mun: 'MADRID',
              prov: 'MADRID',
              bandas: ['2600 MHz'],
              frecuencias: ['2620.00 - 2640.00'],
              concesiones: [{ ref: 'DG-2600-SSR', freq: '2620.00 - 2640.00' }],
              bandsScannedAt: '2026-11-15T18:04:55Z',
            },
          ],
          bandPatches: [],
          novedades: [
            {
              id: 'antena::DIGI SPAIN TELECOM, S.L.U. - 2809955',
              tipo: 'antena',
              op: 'digi',
              opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
              codigo: '2809955',
              antennaId: 'DIGI SPAIN TELECOM, S.L.U. - 2809955',
              codigoBanda: '',
              frecuencia: '',
              ubicacion: 'MADRID',
              prov: 'MADRID',
              scannedAt: '2026-11-15T18:04:55Z',
              fecha: '15/11/2026 19:04:55',
            },
          ],
        },
      ],
      'live-ssr-77',
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['antenas-dataset'], baseAntenas);
    queryClient.setQueryData(['novedades-dataset'], baseNovedades);
    queryClient.setQueryData(['scan-status'], liveScanStatus);
    queryClient.setQueryData(
      ['live-scan-delta', 'live-ssr-77', 2, 1, ''],
      liveDelta,
    );

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
    const testNov = createRoute({
      getParentRoute: () => testRoot,
      path: '/novedades',
      component: NovedadesView,
    });

    const mapRouter = createRouter({
      routeTree: testRoot.addChildren([testMap, testNov]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    await mapRouter.load();

    const mapHtml = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          WorkspaceProvider,
          null,
          createElement(RouterProvider, { router: mapRouter }),
        ),
      ),
    );
    // El mapa muestra ya 4 estaciones (3 base + 1 DIGI en vivo) y expone la píldora de 2600 MHz
    expect(mapHtml).toContain('id="filter-band-2600-mhz"');
    expect(mapHtml).toContain('>4<');

    const novRouter = createRouter({
      routeTree: testRoot.addChildren([testMap, testNov]),
      history: createMemoryHistory({ initialEntries: ['/novedades'] }),
    });
    await novRouter.load();

    const novHtml = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(RouterProvider, { router: novRouter }),
      ),
    );
    expect(novHtml).toContain('2809955');
    expect(novHtml).toContain('15/11/2026 19:04:55');
  });
});

describe('Búsqueda por códigos de banda RF (N258, N78, B7, B38, B1, B3, G9, B20, N28) y textos de MapOverlays', () => {
  function createBandCodesDataset(): AntenasDataset {
    const base = createSampleCustomDataset();
    return {
      ...base,
      total: 8,
      antenas: [
        // 1. Solo TDD 2600 (B38: rangos dentro de [2570, 2620]) aunque bandas diga '2600 MHz' -> SOLO B38, NUNCA B7
        {
          id: 'ORANGE ESPAGNE, S.A.U. - MADR0038B',
          gid: 'MADR0038B',
          op: 'orange',
          opRaw: 'ORANGE ESPAGNE, S.A.U.',
          lat: 40.4168,
          lon: -3.7038,
          dir: 'GRAN VIA 10',
          mun: 'MADRID',
          prov: 'MADRID',
          bandas: ['2600 MHz'],
          frecuencias: [
            '2575.00 - 2595.00',
            '2595.00 - 2605.00',
            '2605.00 - 2615.00',
          ],
        },
        // 2. Solo FDD 2600 (B7: 2620-2640 y 2660-2680) -> SOLO B7, NUNCA B38
        {
          id: 'VODAFONE ESPAÑA, S.A.U. - MADR0007B',
          gid: 'MADR0007B',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          lat: 40.42,
          lon: -3.71,
          dir: 'ALCALA 20',
          mun: 'MADRID',
          prov: 'MADRID',
          bandas: ['2600 MHz'],
          frecuencias: ['2620.00 - 2640.00', '2660.00 - 2680.00'],
        },
        // 3. Ambos TDD 2600 (2570-2620) + FDD 2600 (2640-2660) + 3500 (N78) -> B7 + B38 + N78
        {
          id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - MADR0738A',
          gid: 'MADR0738A',
          op: 'movistar',
          opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
          lat: 40.43,
          lon: -3.69,
          dir: 'CASTELLANA 50',
          mun: 'MADRID',
          prov: 'MADRID',
          bandas: ['2600 MHz', '3500 MHz'],
          frecuencias: [
            '2570.00 - 2620.00',
            '2640.00 - 2660.00',
            '3460.00 - 3600.00',
          ],
        },
        // 4. Fallback '2600 MHz' sin rangos 2490..2700 en frecuencias/concesiones -> B7
        {
          id: 'XFERA MOVILES, S.A.U. - MADR2600F',
          gid: 'MADR2600F',
          op: 'masmovil',
          opRaw: 'XFERA MOVILES, S.A.U.',
          lat: 40.44,
          lon: -3.68,
          dir: 'GOYA 12',
          mun: 'MADRID',
          prov: 'MADRID',
          bandas: ['2600 MHz'],
        },
        // 5. mmWave 26 GHz con bug GHz-como-MHz de MINETUR (26.50 - 27.30 y '26 MHz') + N78 -> N258 + N78
        {
          id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - MADR0258M',
          gid: 'MADR0258M',
          op: 'movistar',
          opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
          lat: 40.45,
          lon: -3.67,
          dir: 'AZCA 1',
          mun: 'MADRID',
          prov: 'MADRID',
          bandas: ['26 MHz', '3500 MHz'],
          frecuencias: ['26.50 - 27.30', '3600.00 - 3700.00'],
        },
        // 6. mmWave 26 GHz en MHz reales (24000..29500 en concesiones) + 2100 (B1) + 1800 (B3)
        {
          id: 'DIGI SPAIN TELECOM, S.L.U. - BARC0258D',
          gid: 'BARC0258D',
          op: 'digi',
          opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
          lat: 41.3874,
          lon: 2.1686,
          dir: 'DIAGONAL 100',
          mun: 'BARCELONA',
          prov: 'BARCELONA',
          bandas: ['1800 MHz', '2100 MHz', '26 GHz'],
          frecuencias: ['1825.00 - 1845.00', '2155.00 - 2170.00'],
          concesiones: [{ ref: 'MM-26G-BCN', freq: '26500.00 - 27300.00' }],
        },
        // 7. Estación con GID trampa 'GALR0453B1' que SOLO emite 800 MHz (B20) y 900 MHz (G9) (NO tiene B1)
        {
          id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - GALR0453B1',
          gid: 'GALR0453B1',
          op: 'movistar',
          opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
          lat: 43.3623,
          lon: -8.4115,
          dir: 'MARINA 4',
          mun: 'A CORUÑA',
          prov: 'A CORUÑA',
          bandas: ['800 MHz', '900 MHz'],
          frecuencias: ['801.00 - 811.00', '935.10 - 949.90'],
        },
        // 8. Estación con GID trampa 'B10023' que SOLO emite 700 MHz (N28) (NO tiene B1)
        {
          id: 'ORANGE ESPAGNE, S.A.U. - B10023',
          gid: 'B10023',
          op: 'orange',
          opRaw: 'ORANGE ESPAGNE, S.A.U.',
          lat: 37.3891,
          lon: -5.9845,
          dir: 'SIERPES 8',
          mun: 'SEVILLA',
          prov: 'SEVILLA',
          bandas: ['700 MHz'],
          concesiones: [{ ref: 'OR-700-SVQ', freq: '758.00 - 768.00' }],
        },
      ],
    };
  }

  it('separa estrictamente B38 (2570-2620 TDD) de B7 (resto 2490-2700 y fallback 2600 MHz) en el buscador', () => {
    const derived = buildDerivedAntenasStructures(createBandCodesDataset());
    const search = (q: string) =>
      filterAntenas({
        derived,
        searchQuery: q,
        selectedProvince: '',
        selectedMunicipality: '',
        activeOperators: [...OPERATOR_ORDER],
      }).map((a) => a.gid);

    // B38 devuelve la estación solo-TDD y la mixta TDD+FDD, nunca las solo-FDD ni el fallback
    expect(search('B38')).toEqual(['MADR0038B', 'MADR0738A']);
    expect(search('b38')).toEqual(['MADR0038B', 'MADR0738A']);

    // B7 devuelve la solo-FDD, la mixta TDD+FDD y el fallback '2600 MHz' sin rangos, NUNCA MADR0038B
    expect(search('B7')).toEqual(['MADR0007B', 'MADR0738A', 'MADR2600F']);

    // Consulta combinada B7 + B38 devuelve únicamente la estación que tiene ambos rangos
    expect(search('B7 B38')).toEqual(['MADR0738A']);
  });

  it('indexa N258, N78, B1, B3, G9, B20 y N28 sin falsos positivos por subcadena en GIDs como GALR0453B1 o B10023', () => {
    const derived = buildDerivedAntenasStructures(createBandCodesDataset());
    const search = (q: string) =>
      filterAntenas({
        derived,
        searchQuery: q,
        selectedProvince: '',
        selectedMunicipality: '',
        activeOperators: [...OPERATOR_ORDER],
      }).map((a) => a.gid);

    // N258 reconoce tanto el bug GHz-como-MHz (26.50 - 27.30 / 26 MHz) como 24000..29500 / 26 GHz
    expect(search('N258')).toEqual(['MADR0258M', 'BARC0258D']);
    expect(search('n258')).toEqual(['MADR0258M', 'BARC0258D']);

    // N78 (3500 MHz / 3300..3900)
    expect(search('N78')).toEqual(['MADR0738A', 'MADR0258M']);
    expect(search('N78, N258')).toEqual(['MADR0258M']);

    // B1 coincide SOLO con la estación 2100 MHz (BARC0258D), jamás por subcadena con GALR0453B1 ni B10023
    expect(search('B1')).toEqual(['BARC0258D']);
    expect(search('b1')).toEqual(['BARC0258D']);

    // Pero buscar el GID completo o parcial sigue encontrando GALR0453B1 y B10023 con normalidad
    expect(search('GALR0453B1')).toEqual(['GALR0453B1']);
    expect(search('GALR0453')).toEqual(['GALR0453B1']);
    expect(search('B10023')).toEqual(['B10023']);

    // B3 coincide SOLO con 1800 MHz (BARC0258D), nunca con B38 (MADR0038B / MADR0738A)
    expect(search('B3')).toEqual(['BARC0258D']);

    // G9 (900 MHz), B20 (800 MHz) y N28 (700 MHz)
    expect(search('G9')).toEqual(['GALR0453B1']);
    expect(search('B20')).toEqual(['GALR0453B1']);
    expect(search('N28')).toEqual(['B10023']);

    // Unifica '26 MHz' y '26 GHz' en una única etiqueta comercial '26 GHz' después de '3500 MHz'
    expect(derived.availableBands).toEqual([
      { band: '700 MHz', count: 1 },
      { band: '800 MHz', count: 1 },
      { band: '900 MHz', count: 1 },
      { band: '1800 MHz', count: 1 },
      { band: '2100 MHz', count: 1 },
      { band: '2600 MHz', count: 4 },
      { band: '3500 MHz', count: 2 },
      { band: '26 GHz', count: 2 },
    ]);
    expect(
      matchesAntennaBandsFilter(['2600 MHz'], ['2600 MHz'], true),
    ).toBe(true);
  });

  it('mantiene #map-toggle-bands-btn en la barra superior de MapOverlays y reemplaza #map-show-bands-option por #map-disable-clustering-option ("Eliminar clustering") en el selector de estilos', () => {
    const inactiveHtml = renderToStaticMarkup(
      createElement(MapOverlays, {
        styleId: 'positron',
        onStyleChange: () => {},
        showBandsOnMap: false,
        onToggleShowBandsOnMap: () => {},
        disableClustering: false,
        onToggleDisableClustering: () => {},
        onFlyToRegion: () => {},
      }),
    );
    expect(inactiveHtml).toContain('id="map-toggle-bands-btn"');
    expect(inactiveHtml).toContain('>Mostrar bandas<');
    expect(inactiveHtml).toContain(
      'title="Mostrar directamente los códigos de banda que emite cada antena sin hacer clic"',
    );
    expect(inactiveHtml).not.toContain('map-show-bands-option');

    const activeHtml = renderToStaticMarkup(
      createElement(MapOverlays, {
        styleId: 'positron',
        onStyleChange: () => {},
        showBandsOnMap: true,
        onToggleShowBandsOnMap: () => {},
        disableClustering: true,
        onToggleDisableClustering: () => {},
        onFlyToRegion: () => {},
      }),
    );
    expect(activeHtml).toContain(
      'title="Ocultar las tarjetas de códigos de banda en el mapa"',
    );
    expect(activeHtml).not.toContain('map-show-bands-option');

    // En el desplegable de estilos (.map-style-popover) ya no se duplica "Mostrar bandas en antenas" y en su lugar figura "Eliminar clustering"
    expect(mapOverlaysRawSource).not.toContain('map-show-bands-option');
    expect(mapOverlaysRawSource).not.toContain('Mostrar bandas en antenas');
    expect(mapOverlaysRawSource).toContain('id="map-disable-clustering-option"');
    expect(mapOverlaysRawSource).toContain('Eliminar clustering');
    expect(mapOverlaysRawSource).toContain(
      'Mostrar antenas sin agrupar al hacer zoom out',
    );
  });
});

describe('Unificación integral de 26MHz / 27MHz en 26 GHz en toda la web', () => {
  it('normaliza etiquetas comerciales y listas de bandas deduplicando 26 MHz y 27 MHz en 26 GHz tras 3500 MHz', () => {
    expect(normalizeCommercialBandLabel('26MHz')).toBe('26 GHz');
    expect(normalizeCommercialBandLabel('27MHz')).toBe('26 GHz');
    expect(normalizeCommercialBandLabel('26 MHz')).toBe('26 GHz');
    expect(normalizeCommercialBandLabel('27 MHz')).toBe('26 GHz');
    expect(normalizeCommercialBandLabel('26,5 MHz')).toBe('26 GHz');
    expect(normalizeCommercialBandLabel('26GHz')).toBe('26 GHz');
    expect(normalizeCommercialBandLabel('26 ghz')).toBe('26 GHz');
    expect(normalizeCommercialBandLabel('27 GHz')).toBe('26 GHz');
    expect(normalizeCommercialBandLabel('700mhz')).toBe('700 MHz');
    expect(normalizeCommercialBandLabel('2600 MHz')).toBe('2600 MHz');
    expect(normalizeCommercialBandLabel('3500 MHz')).toBe('3500 MHz');

    expect(
      normalizeAntennaBandsList([
        '27 MHz',
        '3500 MHz',
        '26 MHz',
        '700mhz',
        '26GHz',
      ]),
    ).toEqual(['700 MHz', '3500 MHz', '26 GHz']);
  });

  it('unifica 26 MHz y 27 MHz (en estaciones distintas, en la misma estación, en parseCustomAntenasJson, fusión Vodafone y live-scan-delta) en una sola banda 26 GHz con conteo deduplicado tras 3500 MHz', () => {
    const base = createSampleCustomDataset();
    const rawPayload = {
      ...base,
      total: 5,
      antenas: [
        // 1. Estación con solo 26 MHz
        {
          id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - MMW001',
          gid: 'MMW001',
          op: 'movistar' as const,
          opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
          lat: 40.4168,
          lon: -3.7038,
          dir: 'GRAN VIA 1',
          mun: 'MADRID',
          prov: 'MADRID',
          bandas: ['26 MHz', '3500 MHz'],
          frecuencias: ['25.70 - 26.70', '3500.00 - 3600.00'],
        },
        // 2. Estación con solo 27 MHz
        {
          id: 'ORANGE ESPAGNE, S.A.U. - MMW002',
          gid: 'MMW002',
          op: 'orange' as const,
          opRaw: 'ORANGE ESPAGNE, S.A.U.',
          lat: 41.3874,
          lon: 2.1686,
          dir: 'DIAGONAL 20',
          mun: 'BARCELONA',
          prov: 'BARCELONA',
          bandas: ['27 MHz', '700 MHz'],
          frecuencias: ['26.70 - 27.10', '768.00 - 778.00'],
        },
        // 3. Estación con AMBAS 26 MHz y 27 MHz -> debe contar 1 sola vez en 26 GHz
        {
          id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - MMW003',
          gid: 'MMW003',
          op: 'movistar' as const,
          opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
          lat: 37.3891,
          lon: -5.9845,
          dir: 'SIERPES 10',
          mun: 'SEVILLA',
          prov: 'SEVILLA',
          bandas: ['26 MHz', '27 MHz', '2600 MHz'],
          frecuencias: ['25.70 - 26.70', '26.70 - 27.10', '2620.00 - 2640.00'],
        },
        // 4 y 5. Dos registros Vodafone a < 35 m (uno con 26 MHz y otro con 27 MHz) -> fusionan en 1 estación con ['26 GHz']
        {
          id: 'VODAFONE ESPAÑA, S.A.U. - 0287700',
          gid: '0287700',
          op: 'vodafone' as const,
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          lat: 39.4699,
          lon: -0.3763,
          dir: 'COLON 15',
          mun: 'VALENCIA',
          prov: 'VALENCIA',
          bandas: ['26 MHz'],
          frecuencias: ['25.30 - 25.70'],
        },
        {
          id: 'VODAFONE ESPAÑA, S.A.U. - 287700',
          gid: '287700',
          op: 'vodafone' as const,
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          lat: 39.46995,
          lon: -0.3763,
          dir: 'COLON 15',
          mun: 'VALENCIA',
          prov: 'VALENCIA',
          bandas: ['27 MHz'],
          frecuencias: ['27.10 - 27.50'],
        },
      ],
    };

    const parsed = parseCustomAntenasJson(rawPayload);
    expect(parsed.antenas.find((a) => a.gid === 'MMW003')?.bandas).toEqual([
      '2600 MHz',
      '26 GHz',
    ]);
    expect(parsed.antenas.find((a) => a.gid === '287700')?.bandas).toEqual([
      '26 GHz',
    ]);

    // También probar entradas legacy en memoria sin pasar antes por parseCustomAntenasJson + mergeLiveDeltaIntoAntenasDataset
    const unnormalizedDataset: AntenasDataset = {
      ...base,
      total: 3,
      antenas: [
        {
          id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - MMW001',
          gid: 'MMW001',
          op: 'movistar',
          opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
          lat: 40.4168,
          lon: -3.7038,
          dir: 'GRAN VIA 1',
          mun: 'MADRID',
          prov: 'MADRID',
          bandas: ['26 MHz', '3500 MHz'],
        },
        {
          id: 'ORANGE ESPAGNE, S.A.U. - MMW002',
          gid: 'MMW002',
          op: 'orange',
          opRaw: 'ORANGE ESPAGNE, S.A.U.',
          lat: 41.3874,
          lon: 2.1686,
          dir: 'DIAGONAL 20',
          mun: 'BARCELONA',
          prov: 'BARCELONA',
          bandas: ['27 MHz', '700 MHz'],
        },
        {
          id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - MMW003',
          gid: 'MMW003',
          op: 'movistar',
          opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
          lat: 37.3891,
          lon: -5.9845,
          dir: 'SIERPES 10',
          mun: 'SEVILLA',
          prov: 'SEVILLA',
          bandas: ['26 MHz', '27 MHz', '2600 MHz'],
        },
      ],
    };

    const accumulatedMmwDelta = accumulateLiveDeltaChunks(
      [
        {
          schemaVersion: 2,
          scanId: 'scan-mmw-delta',
          seq: 1,
          chunkIndex: 0,
          isTail: true,
          updatedAt: '2026-11-16T10:00:00Z',
          recordNovedades: true,
          previousScanAt: '2026-11-15T10:00:00Z',
          replacesNewAntennas: false,
          newAntennas: [
            {
              id: 'DIGI SPAIN TELECOM, S.L.U. - MMW004',
              gid: 'MMW004',
              op: 'digi',
              opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
              lat: 43.263,
              lon: -2.935,
              dir: 'GRAN VIA 40',
              mun: 'BILBAO',
              prov: 'BIZKAIA',
              bandas: ['26MHz', '27MHz'],
            },
          ],
          bandPatches: [
            {
              id: 'ORANGE ESPAGNE, S.A.U. - MMW002',
              gid: 'MMW002',
              bandas: ['700 MHz', '26 MHz', '27 MHz'],
              frecuencias: ['768.00 - 778.00', '26.70 - 27.10'],
              concesiones: [{ ref: 'OR-26G-BCN', freq: '26.70 - 27.10' }],
              bandsScannedAt: '2026-11-16T10:00:00Z',
            },
          ],
          novedades: [],
        },
      ],
      'scan-mmw-delta',
    );

    const withLiveDelta = mergeLiveDeltaIntoAntenasDataset(
      unnormalizedDataset,
      accumulatedMmwDelta,
    );

    const derived = buildDerivedAntenasStructures(withLiveDelta);
    expect(derived.availableBands).toEqual([
      { band: '700 MHz', count: 1 },
      { band: '2600 MHz', count: 1 },
      { band: '3500 MHz', count: 1 },
      { band: '26 GHz', count: 4 },
    ]);
    expect(
      derived.dataset.antenas.find((a) => a.gid === 'MMW004')?.bandas,
    ).toEqual(['26 GHz']);
    expect(
      derived.dataset.antenas.find((a) => a.gid === 'MMW002')?.bandas,
    ).toEqual(['700 MHz', '26 GHz']);
  });

  it('matchesAntennaBandsFilter y filterAntenas unifican 26 MHz, 27 MHz, 26GHz y 26 GHz en modo unión y en exclusiveBands = true', () => {
    // Modo unión (exclusiveBands = false)
    expect(matchesAntennaBandsFilter(['26 MHz'], ['26 GHz'], false)).toBe(true);
    expect(matchesAntennaBandsFilter(['27 MHz'], ['26 GHz'], false)).toBe(true);
    expect(matchesAntennaBandsFilter(['26 MHz'], ['26GHz'], false)).toBe(true);
    expect(matchesAntennaBandsFilter(['26 GHz'], ['27MHz'], false)).toBe(true);
    expect(
      matchesAntennaBandsFilter(['26 MHz', '3500 MHz'], ['26 GHz'], false),
    ).toBe(true);
    expect(matchesAntennaBandsFilter(['2600 MHz'], ['26 GHz'], false)).toBe(
      false,
    );

    // Modo exclusivo (exclusiveBands = true): ['26 MHz', '27 MHz'] se deduplica a {'26 GHz'} y coincide exactamente con ['26 GHz'] o ['26GHz']
    expect(
      matchesAntennaBandsFilter(['26 MHz', '27 MHz'], ['26 GHz'], true),
    ).toBe(true);
    expect(
      matchesAntennaBandsFilter(['26 MHz', '27 MHz'], ['26GHz'], true),
    ).toBe(true);
    expect(matchesAntennaBandsFilter(['27 MHz'], ['26 GHz'], true)).toBe(true);
    expect(
      matchesAntennaBandsFilter(['26 MHz', '3500 MHz'], ['26 GHz'], true),
    ).toBe(false);
    expect(
      matchesAntennaBandsFilter(
        ['26 MHz', '27 MHz', '3500 MHz'],
        ['26GHz', '3500 MHz'],
        true,
      ),
    ).toBe(true);

    // También a través de filterAntenas
    const base = createSampleCustomDataset();
    const derived = buildDerivedAntenasStructures({
      ...base,
      total: 3,
      antenas: [
        {
          id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - ONLY26G',
          gid: 'ONLY26G',
          op: 'movistar',
          opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
          lat: 40.41,
          lon: -3.7,
          dir: 'SOL 1',
          mun: 'MADRID',
          prov: 'MADRID',
          bandas: ['26 MHz', '27 MHz'],
        },
        {
          id: 'ORANGE ESPAGNE, S.A.U. - MIX26G',
          gid: 'MIX26G',
          op: 'orange',
          opRaw: 'ORANGE ESPAGNE, S.A.U.',
          lat: 40.42,
          lon: -3.71,
          dir: 'ALCALA 2',
          mun: 'MADRID',
          prov: 'MADRID',
          bandas: ['27 MHz', '3500 MHz'],
        },
        {
          id: 'VODAFONE ESPAÑA, S.A.U. - ONLY2600',
          gid: 'ONLY2600',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          lat: 40.43,
          lon: -3.72,
          dir: 'GOYA 3',
          mun: 'MADRID',
          prov: 'MADRID',
          bandas: ['2600 MHz'],
        },
      ],
    });

    for (const bandQuery of ['26 GHz', '26GHz', '26 MHz', '27 MHz']) {
      expect(
        filterAntenas({
          derived,
          searchQuery: '',
          selectedProvince: '',
          selectedMunicipality: '',
          selectedBands: [bandQuery],
          exclusiveBands: false,
          activeOperators: [...OPERATOR_ORDER],
        }).map((a) => a.gid),
      ).toEqual(['ONLY26G', 'MIX26G']);

      expect(
        filterAntenas({
          derived,
          searchQuery: '',
          selectedProvince: '',
          selectedMunicipality: '',
          selectedBands: [bandQuery],
          exclusiveBands: true,
          activeOperators: [...OPERATOR_ORDER],
        }).map((a) => a.gid),
      ).toEqual(['ONLY26G']);
    }
  });

  it('buscar 26GHz, 26 GHz, 26MHz, 26 MHz, 27MHz y 27 MHz en filterAntenas devuelve todas las estaciones unificadas de 26 GHz sin confundir 2600 MHz', () => {
    const base = createSampleCustomDataset();
    const derived = buildDerivedAntenasStructures({
      ...base,
      total: 4,
      antenas: [
        {
          id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - S26M',
          gid: 'S26M',
          op: 'movistar',
          opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
          lat: 40.41,
          lon: -3.7,
          dir: 'CASTELLANA 1',
          mun: 'MADRID',
          prov: 'MADRID',
          bandas: ['26 MHz'],
          frecuencias: ['25.70 - 26.70'],
        },
        {
          id: 'ORANGE ESPAGNE, S.A.U. - S27M',
          gid: 'S27M',
          op: 'orange',
          opRaw: 'ORANGE ESPAGNE, S.A.U.',
          lat: 40.42,
          lon: -3.71,
          dir: 'CASTELLANA 2',
          mun: 'MADRID',
          prov: 'MADRID',
          bandas: ['27 MHz'],
          frecuencias: ['26.70 - 27.10'],
        },
        {
          id: 'DIGI SPAIN TELECOM, S.L.U. - S26G',
          gid: 'S26G',
          op: 'digi',
          opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
          lat: 40.43,
          lon: -3.72,
          dir: 'CASTELLANA 3',
          mun: 'MADRID',
          prov: 'MADRID',
          bandas: ['26 GHz'],
        },
        {
          id: 'VODAFONE ESPAÑA, S.A.U. - S2600',
          gid: 'S2600',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          lat: 40.44,
          lon: -3.73,
          dir: 'CASTELLANA 4',
          mun: 'MADRID',
          prov: 'MADRID',
          bandas: ['2600 MHz'],
          frecuencias: ['2620.00 - 2640.00'],
        },
      ],
    });

    for (const q of ['26GHz', '26 GHz', '26MHz', '26 MHz', '27MHz', '27 MHz']) {
      expect(
        filterAntenas({
          derived,
          searchQuery: q,
          selectedProvince: '',
          selectedMunicipality: '',
          activeOperators: [...OPERATOR_ORDER],
        }).map((a) => a.gid),
      ).toEqual(['S26M', 'S27M', 'S26G']);
    }
  });

  it('compareFrequencyRanges ordena los rangos milimétricos 25.70 - 26.70 y 26.70 - 27.10 después de 3460.00 - 3600.00', () => {
    expect(compareFrequencyRanges('25.70 - 26.70', '3460.00 - 3600.00')).toBeGreaterThan(0);
    expect(compareFrequencyRanges('3460.00 - 3600.00', '25.70 - 26.70')).toBeLessThan(0);

    const sorted = [
      '26.70 - 27.10',
      '3460.00 - 3600.00',
      '25.70 - 26.70',
      '758.00 - 768.00',
      '2620.00 - 2640.00',
    ].sort(compareFrequencyRanges);

    expect(sorted).toEqual([
      '758.00 - 768.00',
      '2620.00 - 2640.00',
      '3460.00 - 3600.00',
      '25.70 - 26.70',
      '26.70 - 27.10',
    ]);
  });

  it('clasifica rangos 26/27 en Novedades como 26 GHz y actualiza UI en FilterPanel, StationDetailDrawer, EstadisticasView y AntenasMap', async () => {
    expect(classifyFrequencyBandMhz('25.70 - 26.70 MHz')).toBe('26 GHz');
    expect(classifyFrequencyBandMhz('26.70 - 27.10 MHz')).toBe('26 GHz');
    expect(classifyFrequencyBandMhz('25.70 - 26.70 GHz')).toBe('26 GHz');
    expect(classifyFrequencyBandMhz('26 MHz')).toBe('26 GHz');
    expect(classifyFrequencyBandMhz('27 MHz')).toBe('26 GHz');
    expect(classifyFrequencyBandMhz('26 GHz')).toBe('26 GHz');

    const mmwNovItems = filterNovedades({
      novedades: [
        {
          id: 'freq::MMW::1',
          tipo: 'frecuencia',
          op: 'movistar',
          opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
          codigo: '2800258',
          antennaId: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800258',
          codigoBanda: 'MM-26G',
          frecuencia: '25.70 - 26.70 MHz',
          ubicacion: 'MADRID',
          prov: 'MADRID',
          scannedAt: '2026-11-16T10:00:00Z',
          fecha: '16/11/2026 11:00:00',
        },
      ],
      tipoFilter: 'all',
      operatorFilter: 'all',
      bandFilter: '26 GHz',
      searchQuery: '26GHz',
    });
    expect(mmwNovItems).toHaveLength(1);

    // AntenasMap exporta el componente principal y los helpers puros de conteo exacto en clústeres
    expect(AntenasMapModule.AntenasMap).toBeTypeOf('function');
    expect(Object.keys(AntenasMapModule).sort()).toEqual([
      'AntenasMap',
      'buildClusterCircleRadiusExpr',
      'buildClusterCountTextFieldExpr',
      'buildClusterCountTextSizeExpr',
      'buildClusterExactCountExpr',
      'evaluateClusterCountLabel',
    ]);
    expect(antenasMapRawSource).toContain('normalizeAntennaBandsList');

    const base = createSampleCustomDataset();
    const mmwAntenna = {
      id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800258',
      gid: '2800258',
      op: 'movistar' as const,
      opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
      lat: 40.45,
      lon: -3.69,
      dir: 'PASEO DE LA CASTELLANA 100',
      mun: 'MADRID',
      prov: 'MADRID',
      bandas: ['26 MHz', '27 MHz', '3500 MHz'],
      frecuencias: ['25.70 - 26.70', '26.70 - 27.10', '3460.00 - 3600.00'],
      concesiones: [
        { ref: 'MM-26G-1', freq: '25.70 - 26.70' },
        { ref: 'MM-26G-2', freq: '26.70 - 27.10' },
        { ref: 'MM-3500', freq: '3460.00 - 3600.00' },
      ],
    };
    const datasetWithMmw: AntenasDataset = {
      ...base,
      total: base.antenas.length + 1,
      antenas: [...base.antenas, mmwAntenna],
    };
    const derived = buildDerivedAntenasStructures(datasetWithMmw);

    // FilterPanel muestra "Frecuencias" y aria-label "Filtrar por bandas de frecuencia" + chip 26 GHz
    const filterHtml = renderToStaticMarkup(
      createElement(FilterPanel, {
        derived,
        filteredAntenas: derived.dataset.antenas,
        collapsed: false,
        mobileOpen: false,
        onCollapseDesktop: () => {},
        onCloseMobile: () => {},
        searchQuery: '',
        onSearchChange: () => {},
        selectedComunidad: '',
        onComunidadChange: () => {},
        selectedProvince: '',
        onProvinceChange: () => {},
        selectedBands: [],
        onToggleBand: () => {},
        onClearBands: () => {},
        exclusiveBands: false,
        onExclusiveBandsChange: () => {},
        activeOperators: [...OPERATOR_ORDER],
        onToggleOperator: () => {},
        onSelectAllOperators: () => {},
        onClearAllOperators: () => {},
        hasActiveFilters: false,
        onResetFilters: () => {},
        onFlyTo: () => {},
      }),
    );
    expect(filterHtml).toContain('aria-label="Filtrar por bandas de frecuencia"');
    expect(filterHtml).toContain('>Frecuencias<');
    expect(filterHtml).not.toContain('Frecuencias (MHz)');
    expect(filterHtml).toContain('id="filter-band-26-ghz"');

    // StationDetailDrawer muestra "Bandas y Frecuencias Asignadas", chip único "26 GHz", rangos en GHz y bloque en MHz
    const drawerHtml = renderToStaticMarkup(
      createElement(StationDetailDrawer, {
        antenna: mmwAntenna,
        allAntenas: derived.dataset.antenas,
        onClose: () => {},
        onSelectAntenna: () => {},
      }),
    );
    expect(drawerHtml).toContain('aria-label="Bandas y Frecuencias Asignadas"');
    expect(drawerHtml).not.toContain('Bandas y Frecuencias Asignadas (MHz)');
    expect(drawerHtml).toContain('>26 GHz<');
    expect(drawerHtml).not.toContain('>26 MHz<');
    expect(drawerHtml).not.toContain('>27 MHz<');
    expect(drawerHtml).toContain('25.70 - 26.70 GHz');
    expect(drawerHtml).toContain('26.70 - 27.10 GHz');
    expect(drawerHtml).toMatch(/1\.?000 MHz/);
    expect(drawerHtml).toContain('400 MHz');

    // EstadisticasView muestra "Cobertura y Desglose por Banda de Frecuencia", "(700 MHz a 26 GHz)" y el rol mmWave n258
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['antenas-dataset'], datasetWithMmw);
    const statsRoot = createRootRoute({ component: Outlet });
    const statsRoute = createRoute({
      getParentRoute: () => statsRoot,
      path: '/estadisticas',
      component: EstadisticasView,
    });
    const statsRouter = createRouter({
      routeTree: statsRoot.addChildren([statsRoute]),
      history: createMemoryHistory({ initialEntries: ['/estadisticas'] }),
    });
    await statsRouter.load();

    const statsHtml = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          WorkspaceProvider,
          null,
          createElement(RouterProvider, { router: statsRouter }),
        ),
      ),
    );
    expect(statsHtml).toContain('Cobertura y Desglose por Banda de Frecuencia');
    expect(statsHtml).not.toContain(
      'Cobertura y Desglose por Banda de Frecuencia (MHz)',
    );
    expect(statsHtml).toContain('(700 MHz a 26 GHz)');
    expect(statsHtml).toContain(
      '5G NR mmWave (n258 · 26 GHz) · Ultra-alta capacidad milimétrica',
    );
  });
});

describe('Botón flotante "Secciones", cajón deslizable y paneles móviles a pantalla completa (100vw × 100dvh)', () => {
  it('elimina la cabecera superior grande y muestra el botón flotante "Secciones" encima de "Filtros" en MapaView y en rutas secundarias', async () => {
    const sample = createSampleCustomDataset();
    const sampleNovedades: NovedadesDataset = {
      updatedAt: '2026-11-16T06:00:00Z',
      scanId: 'scan-2026-11-16',
      previousScanAt: '2026-11-15T06:00:00Z',
      total: 7,
      antenasNuevas: 4,
      frecuenciasNuevas: 3,
      novedades: [],
    };

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['antenas-dataset'], sample);
    queryClient.setQueryData(['novedades-dataset'], sampleNovedades);
    queryClient.setQueryData(['scan-status'], null);

    const buildAppRouter = (initialPath: string) => {
      const root = createRootRoute({ component: RootLayout });
      const mapR = createRoute({
        getParentRoute: () => root,
        path: '/',
        validateSearch: (s: Record<string, unknown>) => ({
          gid: typeof s.gid === 'string' ? s.gid : undefined,
          id: typeof s.id === 'string' ? s.id : undefined,
        }),
        component: MapaView,
      });
      const novR = createRoute({
        getParentRoute: () => root,
        path: '/novedades',
        component: NovedadesView,
      });
      const statsR = createRoute({
        getParentRoute: () => root,
        path: '/estadisticas',
        component: EstadisticasView,
      });
      return createRouter({
        routeTree: root.addChildren([mapR, novR, statsR]),
        history: createMemoryHistory({ initialEntries: [initialPath] }),
      });
    };

    // 1. En "/" (MapaView): no existe cabecera .app-header, "Secciones" se apila encima de "Filtros"
    const mapRouter = buildAppRouter('/');
    await mapRouter.load();
    const mapHtml = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          WorkspaceProvider,
          null,
          createElement(RouterProvider, { router: mapRouter }),
        ),
      ),
    );

    expect(mapHtml).not.toContain('class="app-header"');
    expect(mapHtml).not.toContain('id="page-open-sections-btn"');
    expect(mapHtml).toContain('id="desktop-open-sections-btn"');
    expect(mapHtml).toContain('id="mobile-open-sections-btn"');
    expect(mapHtml).toContain('id="mobile-open-filters-btn"');
    expect(
      mapHtml.indexOf('id="mobile-open-sections-btn"'),
    ).toBeLessThan(mapHtml.indexOf('id="mobile-open-filters-btn"'));

    // El cajón #sections-drawer contiene las secciones, el selector de modo oscuro/claro y el censo
    expect(mapHtml).toContain('id="sections-drawer"');
    expect(mapHtml).toContain('id="sections-drawer-close-btn"');
    expect(mapHtml).toContain('id="nav-tab-mapa"');
    expect(mapHtml).toContain('id="nav-tab-novedades"');
    expect(mapHtml).toContain('id="nav-tab-estadisticas"');
    expect(mapHtml).toContain('id="theme-toggle-btn"');
    expect(mapHtml).toContain('Modo oscuro');
    expect(mapHtml).toContain('>7<');

    // 2. En "/novedades" y "/estadisticas": aparece el botón flotante compacto #page-open-sections-btn
    const novRouter = buildAppRouter('/novedades');
    await novRouter.load();
    const novHtml = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          WorkspaceProvider,
          null,
          createElement(RouterProvider, { router: novRouter }),
        ),
      ),
    );
    expect(novHtml).not.toContain('class="app-header"');
    expect(novHtml).toContain('id="page-open-sections-btn"');
    expect(novHtml).toContain('>Secciones<');
    expect(novHtml).toContain('id="sections-drawer"');
  });

  it('renderiza FilterPanel con clase is-mobile-open, botón #sidebar-collapse-btn intuitivo y reglas CSS 100vw × 100dvh sin huecos en móvil', async () => {
    const derived = buildDerivedAntenasStructures(createSampleCustomDataset());
    const mobileFilterHtml = renderToStaticMarkup(
      createElement(FilterPanel, {
        derived,
        filteredAntenas: derived.dataset.antenas,
        collapsed: false,
        mobileOpen: true,
        onCollapseDesktop: () => {},
        onCloseMobile: () => {},
        searchQuery: '',
        onSearchChange: () => {},
        selectedComunidad: '',
        onComunidadChange: () => {},
        selectedProvince: '',
        onProvinceChange: () => {},
        selectedBands: [],
        onToggleBand: () => {},
        onClearBands: () => {},
        exclusiveBands: false,
        onExclusiveBandsChange: () => {},
        activeOperators: [...OPERATOR_ORDER],
        onToggleOperator: () => {},
        onSelectAllOperators: () => {},
        onClearAllOperators: () => {},
        hasActiveFilters: false,
        onResetFilters: () => {},
        onFlyTo: () => {},
      }),
    );

    expect(mobileFilterHtml).toContain('is-mobile-open');
    expect(mobileFilterHtml).toContain('id="sidebar-collapse-btn"');
    expect(mobileFilterHtml).toContain('aria-label="Cerrar panel de filtros"');
    expect(mobileFilterHtml).toContain('sidebar-close-icon-mobile');
    expect(mobileFilterHtml).toContain('sidebar-close-icon-desktop');

    // En ruta desconocida (NotFoundView bajo RootLayout) también se muestra el botón flotante #page-open-sections-btn
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['antenas-dataset'], derived.dataset);
    queryClient.setQueryData(['scan-status'], null);
    const nfRoot = createRootRoute({
      component: RootLayout,
      notFoundComponent: NotFoundView,
    });
    const nfMap = createRoute({
      getParentRoute: () => nfRoot,
      path: '/',
      component: MapaView,
    });
    const nfRouter = createRouter({
      routeTree: nfRoot.addChildren([nfMap]),
      history: createMemoryHistory({ initialEntries: ['/ruta-inexistente'] }),
    });
    await nfRouter.load();
    const nfHtml = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          WorkspaceProvider,
          null,
          createElement(RouterProvider, { router: nfRouter }),
        ),
      ),
    );
    expect(nfHtml).toContain('id="page-open-sections-btn"');
    expect(nfHtml).toContain('Ruta no encontrada');

    // Verificación de las reglas CSS de pantalla completa (100vw × 100dvh) sin el antiguo min(92vw, 380px)
    const fsSpecifier = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFileSync: (path: URL, encoding: string) => string;
    };
    const indexCssSource = readFileSync(
      new URL('../styles/index.css', import.meta.url),
      'utf-8',
    );
    expect(indexCssSource).toContain('--header-height: 0px;');
    expect(indexCssSource).not.toContain('min(92vw, 380px)');
    expect(indexCssSource).toContain('width: 100vw;');
    expect(indexCssSource).toContain('height: 100dvh;');
  });

  it('iguala exactamente el radio CSS de las antenas de 1 operadora con el de los iconos multi-operadora en todos los niveles de zoom', async () => {
    const fsSpecifier = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFileSync: (path: URL, encoding: string) => string;
    };
    const mapSource = readFileSync(
      new URL('../components/map/AntenasMap.tsx', import.meta.url),
      'utf-8',
    );

    expect(mapSource).toContain('const MULTI_SPRITE_RADIUS_PX = 27;');
    expect(mapSource).toContain('const MULTI_SPRITE_PIXEL_RATIO = 2;');
    expect(mapSource).toContain(
      'MULTI_SPRITE_RADIUS_PX / MULTI_SPRITE_PIXEL_RATIO',
    );
    expect(mapSource).toContain(
      'Number((MULTI_SPRITE_BASE_CSS_RADIUS * iconScale).toFixed(4))',
    );
    expect(mapSource).toContain("'circle-pitch-scale': 'viewport'");
  });
});

describe('Control circular discreto en esquina inferior de NovedadesView y triggerForcedAntennasScan', () => {
  const origLocalStorageDesc = Object.getOwnPropertyDescriptor(
    globalThis,
    'localStorage',
  );
  const origWindowDesc = Object.getOwnPropertyDescriptor(globalThis, 'window');

  function installMockLocalStorage() {
    const map = new Map<string, string>();
    const storageMock: Storage = {
      get length() {
        return map.size;
      },
      clear() {
        map.clear();
      },
      getItem(key: string) {
        return map.has(key) ? (map.get(key) ?? null) : null;
      },
      key(index: number) {
        return Array.from(map.keys())[index] ?? null;
      },
      removeItem(key: string) {
        map.delete(key);
      },
      setItem(key: string, value: string) {
        map.set(key, String(value));
      },
    };

    Object.defineProperty(globalThis, 'localStorage', {
      value: storageMock,
      configurable: true,
      writable: true,
    });

    if (typeof globalThis.window === 'undefined') {
      Object.defineProperty(globalThis, 'window', {
        value: { localStorage: storageMock },
        configurable: true,
        writable: true,
      });
    }

    return { map, storageMock };
  }

  afterEach(() => {
    clearStoredScanDispatchToken();
    resetScanProgressInternalCacheForTests();
    vi.restoreAllMocks();

    if (origLocalStorageDesc) {
      Object.defineProperty(globalThis, 'localStorage', origLocalStorageDesc);
    } else {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }

    if (origWindowDesc) {
      Object.defineProperty(globalThis, 'window', origWindowDesc);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  });

  it('renderiza #novedades-corner-scan-btn en la esquina inferior derecha sin texto visible ni atributo title', async () => {
    const sample = createSampleCustomDataset();
    const sampleNovedades: NovedadesDataset = {
      updatedAt: '2026-11-16T06:00:00Z',
      scanId: 'scan-2026-11-16',
      previousScanAt: '2026-11-15T06:00:00Z',
      total: 0,
      antenasNuevas: 0,
      frecuenciasNuevas: 0,
      novedades: [],
    };

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['antenas-dataset'], sample);
    queryClient.setQueryData(['novedades-dataset'], sampleNovedades);
    queryClient.setQueryData(['scan-status'], null);

    const buildNovRouter = () => {
      const root = createRootRoute({ component: Outlet });
      const novR = createRoute({
        getParentRoute: () => root,
        path: '/novedades',
        component: NovedadesView,
      });
      return createRouter({
        routeTree: root.addChildren([novR]),
        history: createMemoryHistory({ initialEntries: ['/novedades'] }),
      });
    };

    const router = buildNovRouter();
    await router.load();

    const novHtml = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          WorkspaceProvider,
          null,
          createElement(RouterProvider, { router }),
        ),
      ),
    );

    const paginationIdx = novHtml.indexOf('id="novedades-pagination-bar"');
    const cornerWrapIdx = novHtml.indexOf('class="novedades-corner-wrap"');
    const btnIdIdx = novHtml.indexOf('id="novedades-corner-scan-btn"');
    const mainEndIdx = novHtml.lastIndexOf('</main>');

    expect(paginationIdx).toBeGreaterThan(0);
    expect(cornerWrapIdx).toBeGreaterThan(paginationIdx);
    expect(btnIdIdx).toBeGreaterThan(cornerWrapIdx);
    expect(btnIdIdx).toBeLessThan(mainEndIdx);

    // El popover de token permanece oculto por defecto
    expect(novHtml).not.toContain('id="novedades-corner-key-popover"');

    const btnStart = novHtml.lastIndexOf('<button', btnIdIdx);
    const btnEnd = novHtml.indexOf('</button>', btnIdIdx) + '</button>'.length;
    const btnSegment = novHtml.slice(btnStart, btnEnd);

    expect(btnSegment).toContain('id="novedades-corner-scan-btn"');
    expect(btnSegment).toContain('class="novedades-corner-scan-btn"');
    expect(btnSegment).toContain('aria-label="Control"');
    expect(btnSegment).not.toContain('title=');
    // Sin ningún texto visible dentro del botón (solo icono SVG)
    expect(btnSegment.replace(/<[^>]+>/g, '').trim()).toBe('');
    expect(btnSegment).toContain('<svg');

    // Tampoco existe texto visible en todo el contenedor de esquina inferior
    const cornerWrapStart = novHtml.lastIndexOf('<div', cornerWrapIdx);
    const cornerWrapSegment = novHtml.slice(cornerWrapStart, mainEndIdx);
    expect(cornerWrapSegment.replace(/<[^>]+>/g, '').trim()).toBe('');

    // Cuando hay un escaneo forzado activo, el icono añade clase is-scanning y el monitor muestra "Forzado"
    const forcedRunning: ScanStatusPayload = {
      schemaVersion: 2,
      state: 'running',
      scanId: 'forced-2026-11-16',
      trigger: 'workflow_dispatch',
      recordNovedades: true,
      part: '1/1',
      phase: 'censo',
      startedAt: '2026-11-16T14:30:00Z',
      updatedAt: '2026-11-16T14:30:02Z',
      censusBoxesVisited: 12,
      estimatedCensusBoxes: 239,
      discoveredAntennas: 0,
      scannedAntennas: 0,
      totalAntennas: 62230,
      percent: 0.02,
    };
    queryClient.setQueryData(['scan-status'], forcedRunning);

    const scanningHtml = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          WorkspaceProvider,
          null,
          createElement(RouterProvider, { router }),
        ),
      ),
    );

    const activeBtnIdIdx = scanningHtml.indexOf(
      'id="novedades-corner-scan-btn"',
    );
    const activeBtnStart = scanningHtml.lastIndexOf('<button', activeBtnIdIdx);
    const activeBtnEnd =
      scanningHtml.indexOf('</button>', activeBtnIdIdx) + '</button>'.length;
    const activeBtnSegment = scanningHtml.slice(activeBtnStart, activeBtnEnd);

    expect(activeBtnSegment).toContain(
      'class="novedades-corner-scan-btn is-scanning"',
    );
    expect(activeBtnSegment).not.toContain('title=');
    expect(scanningHtml).toContain('>Forzado<');

    // Verificación de las reglas CSS discretas en index.css
    const fsSpecifier = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFileSync: (path: URL, encoding: string) => string;
    };
    const indexCssSource = readFileSync(
      new URL('../styles/index.css', import.meta.url),
      'utf-8',
    );
    expect(indexCssSource).toContain('.novedades-corner-wrap');
    expect(indexCssSource).toContain('.novedades-corner-scan-btn');
    expect(indexCssSource).toContain('@keyframes novedadesCornerSpin');
    expect(indexCssSource).toContain('.novedades-corner-key-popover');
    expect(indexCssSource).toContain('.novedades-corner-key-input');
    expect(indexCssSource).toContain('.novedades-corner-key-submit');
  });

  it('triggerForcedAntennasScan gestiona already_scanning, needs_token, POST workflow_dispatch (204 + estado optimista en QueryClient) y limpieza de token en 401', async () => {
    const { map: storageMap } = installMockLocalStorage();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    // 1. Si ya hay un escaneo activo (isCurrentlyScanning: true), devuelve already_scanning sin disparar red
    const alreadyRes = await triggerForcedAntennasScan({
      isCurrentlyScanning: true,
    });
    expect(alreadyRes).toEqual({ status: 'already_scanning' });
    expect(fetchSpy).not.toHaveBeenCalled();

    // 2. Sin token guardado ni suministrado, devuelve needs_token sin disparar red
    expect(getStoredScanDispatchToken()).toBe('');
    const needsTokenRes = await triggerForcedAntennasScan();
    expect(needsTokenRes).toEqual({ status: 'needs_token' });
    expect(fetchSpy).not.toHaveBeenCalled();

    // 3. Con token válido: envía POST a dispatches con Authorization Bearer y { ref: 'main' },
    //    guarda el token en localStorage, devuelve { status: 'dispatched', httpStatus: 204 }
    //    y actualiza inmediatamente ['scan-status'] en QueryClient
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const dispatchedRes = await triggerForcedAntennasScan({
      token: 'ghp_valid_token_abc123',
      totalAntennas: 62450,
      queryClient,
    });

    expect(dispatchedRes).toEqual({ status: 'dispatched', httpStatus: 204 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [dispatchUrl, dispatchInit] = fetchSpy.mock.calls[0] ?? [];
    expect(String(dispatchUrl)).toContain(
      '/repos/lodix12/WEB-DE-ANTENAS/actions/workflows/update-and-deploy.yml/dispatches',
    );
    expect(dispatchInit?.method).toBe('POST');
    const sentHeaders = new Headers(dispatchInit?.headers);
    expect(sentHeaders.get('authorization')).toBe(
      'Bearer ghp_valid_token_abc123',
    );
    const sentBody = JSON.parse(String(dispatchInit?.body)) as Record<
      string,
      unknown
    >;
    expect(sentBody.ref).toBe('main');

    // Token persistido en localStorage y accesible para siguientes disparos sin reescribirlo
    expect(getStoredScanDispatchToken()).toBe('ghp_valid_token_abc123');
    expect(Array.from(storageMap.values())).toContain('ghp_valid_token_abc123');

    const optimisticStatus = queryClient.getQueryData<ScanStatusPayload>([
      'scan-status',
    ]);
    expect(optimisticStatus).toBeDefined();
    expect(optimisticStatus).toMatchObject({
      state: 'running',
      trigger: 'workflow_dispatch',
      phase: 'censo',
      recordNovedades: true,
    });
    expect(optimisticStatus?.totalAntennas).toBe(62450);

    // Mientras la ventana optimista sigue activa, evita disparar un segundo job duplicado
    const duplicateGuardRes = await triggerForcedAntennasScan({ queryClient });
    expect(duplicateGuardRes).toEqual({ status: 'already_scanning' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // 4. Ante HTTP 401 (con estado en reposo), limpia el token almacenado inválido y devuelve { status: 'unauthorized', httpStatus: 401 }
    resetScanProgressInternalCacheForTests();
    const idleQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    setStoredScanDispatchToken('ghp_expired_or_invalid_token');
    expect(getStoredScanDispatchToken()).toBe('ghp_expired_or_invalid_token');

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Bad credentials' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const unauthRes = await triggerForcedAntennasScan({
      queryClient: idleQueryClient,
    });
    expect(unauthRes).toEqual({ status: 'unauthorized', httpStatus: 401 });
    expect(getStoredScanDispatchToken()).toBe('');
    expect(storageMap.size).toBe(0);
  });

  it('mantiene ESCANEO EN VIVO sin cortes durante el arranque del runner, envía Bearer en lecturas API (5.000 req/h), filtra runs zombie en cola y bloquea retrocesos de caché CDN', async () => {
    installMockLocalStorage();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const baseNowMs = Date.now();
    const prevStartedIso = new Date(baseNowMs - 45 * 60_000).toISOString();
    const prevUpdatedIso = new Date(baseNowMs - 25 * 60_000).toISOString();
    const zombieQueuedIso = new Date(baseNowMs - 120 * 60_000).toISOString();
    const liveStartedIso = new Date(baseNowMs - 60_000).toISOString();
    const liveUpdatedIso = new Date(baseNowMs - 5_000).toISOString();

    const prevCompletedDoc: ScanStatusPayload = {
      schemaVersion: 2,
      state: 'completed',
      scanId: 'prev-scan-100',
      trigger: 'workflow_dispatch',
      recordNovedades: true,
      part: '1/2',
      phase: 'frecuencias',
      startedAt: prevStartedIso,
      updatedAt: prevUpdatedIso,
      censusBoxesVisited: 239,
      estimatedCensusBoxes: 239,
      discoveredAntennas: 62238,
      scannedAntennas: 62238,
      totalAntennas: 62238,
      percent: 100,
    };

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['scan-status'], prevCompletedDoc);

    // 1. Disparo forzado exitoso
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const disp = await triggerForcedAntennasScan({
      token: 'Bearer github_pat_owner_token_5000',
      totalAntennas: 62238,
      queryClient,
    });
    expect(disp.status).toBe('dispatched');
    // Prefijo accidental "Bearer " eliminado al normalizar
    expect(getStoredScanDispatchToken()).toBe('github_pat_owner_token_5000');

    // 2. Sondeo #1 (T = +4 s): scan-status.json aún contiene prev-scan-100 (completed),
    //    pero /actions/runs muestra el nuevo run 900200 en progreso.
    //    Debe autenticar con Bearer y NO vaciar optimisticDispatchState prematuramente.
    let currentSha = 'sha-old-completed';
    let currentStatusDoc: ScanStatusPayload = prevCompletedDoc;
    const seenAuthHeaders: string[] = [];

    fetchSpy.mockImplementation(async (input, init) => {
      const url = String(input);
      const h = new Headers(init?.headers);
      if (url.includes('api.github.com')) {
        seenAuthHeaders.push(h.get('authorization') ?? '');
      }
      if (url.includes('/git/ref/heads/scan-status')) {
        return new Response(JSON.stringify({ object: { sha: currentSha } }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ETag: `"etag-${currentSha}"`,
            'X-RateLimit-Remaining': '4998',
          },
        });
      }
      if (url.includes(`/${currentSha}/scan-status.json`)) {
        return new Response(JSON.stringify(currentStatusDoc), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/actions/workflows/update-and-deploy.yml/runs')) {
        return new Response(
          JSON.stringify({
            workflow_runs: [
              {
                id: 900200,
                event: 'workflow_dispatch',
                status: 'in_progress',
                conclusion: null,
                created_at: new Date().toISOString(),
                run_started_at: new Date().toISOString(),
              },
              {
                id: 900001,
                event: 'workflow_dispatch',
                status: 'queued',
                conclusion: null,
                created_at: zombieQueuedIso,
              },
            ],
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'X-RateLimit-Remaining': '4997',
            },
          },
        );
      }
      return new Response('Not found', { status: 404 });
    });

    const poll1 = await fetchLiveScanStatus();
    expect(poll1?.state).toBe('running');
    expect(seenAuthHeaders.every((a) => a === 'Bearer github_pat_owner_token_5000')).toBe(
      true,
    );

    // 3. Sondeo #2 (T = +10 s): scan-status.json SIGUE en prev-scan-100 mientras arranca Python,
    //    y /actions/runs está en enfriamiento (< 15 s). NO debe caer a "completed" ("En espera")!
    const poll2 = await fetchLiveScanStatus();
    expect(poll2?.state).toBe('running');
    expect(poll2?.scanId).not.toBe('prev-scan-100');

    // 4. Sondeo #3: Python publica el primer latido real del nuevo escaneo 900200 -> relevo limpio
    currentSha = 'sha-live-900200-1';
    currentStatusDoc = {
      schemaVersion: 2,
      state: 'running',
      scanId: '900200',
      trigger: 'workflow_dispatch',
      recordNovedades: true,
      part: '1/2',
      phase: 'frecuencias',
      startedAt: liveStartedIso,
      updatedAt: liveUpdatedIso,
      censusBoxesVisited: 239,
      estimatedCensusBoxes: 239,
      discoveredAntennas: 62238,
      scannedAntennas: 31119,
      totalAntennas: 62238,
      percent: 50,
      requestsPerSecond: 80,
    };

    const poll3 = await fetchLiveScanStatus();
    expect(poll3).toMatchObject({
      state: 'running',
      scanId: '900200',
      percent: 50,
    });

    // 5. Si por límite de cuota (403 + X-RateLimit-Remaining: 0) cae al respaldo CDN de raw.githubusercontent.com
    //    y Fastly devuelve una copia antigua (prev-scan-100 con updatedAt anterior), NO retrocede a completed!
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/git/ref/heads/scan-status')) {
        return new Response(JSON.stringify({ message: 'rate limit' }), {
          status: 403,
          headers: { 'X-RateLimit-Remaining': '0' },
        });
      }
      if (url.includes('/scan-status/scan-status.json')) {
        // Copia antigua cacheada por CDN (15:34 < 16:05)
        return new Response(JSON.stringify(prevCompletedDoc), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    });

    const poll4 = await fetchLiveScanStatus();
    expect(poll4).toMatchObject({
      state: 'running',
      scanId: '900200',
      percent: 50,
    });

    // 6. En estado reposo, un run zombie atascado en "queued" detrás de un run más nuevo ya "completed" se ignora
    resetScanProgressInternalCacheForTests();
    const freshNowIso = new Date().toISOString();
    fetchSpy.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/git/ref/heads/scan-status')) {
        return new Response(JSON.stringify({ object: { sha: 'sha-done' } }), {
          status: 200,
          headers: { 'X-RateLimit-Remaining': '55' },
        });
      }
      if (url.includes('/sha-done/scan-status.json')) {
        return new Response(JSON.stringify(prevCompletedDoc), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/actions/workflows/update-and-deploy.yml/runs')) {
        return new Response(
          JSON.stringify({
            workflow_runs: [
              {
                id: 900300,
                event: 'workflow_dispatch',
                status: 'completed',
                conclusion: 'success',
                created_at: freshNowIso,
              },
              {
                // Run antiguo atascado en queued antes del completado (como 43894165638)
                id: 900100,
                event: 'workflow_dispatch',
                status: 'queued',
                conclusion: null,
                created_at: freshNowIso,
              },
            ],
          }),
          {
            status: 200,
            headers: { 'X-RateLimit-Remaining': '54' },
          },
        );
      }
      return new Response('Not found', { status: 404 });
    });

    const idlePoll = await fetchLiveScanStatus();
    expect(idlePoll?.state).toBe('completed');
  });

  it('ignora comprobaciones fugaces de schedule antes de las 18:00 o tras completar hoy y no oculta un escaneo activo debajo de un schedule omitido (<60s)', async () => {
    // 16:03 UTC en invierno (17:03 CET) -> siempre se ignora un schedule de invierno previo a las 18:00
    expect(
      shouldIgnoreScheduleWorkflowRun(
        Date.parse('2026-11-16T16:03:10Z'),
        null,
      ),
    ).toBe(true);

    // 17:03 UTC en invierno (18:03 CET) sin escaneo de hoy >= 18:00 -> NO se ignora (es el escaneo diario real)
    const before18Doc: ScanStatusPayload = {
      schemaVersion: 2,
      state: 'completed',
      scanId: 'manual-afternoon',
      trigger: 'workflow_dispatch',
      recordNovedades: true,
      part: '1/2',
      phase: 'frecuencias',
      startedAt: '2026-11-16T15:38:51Z',
      updatedAt: '2026-11-16T15:54:40Z',
      censusBoxesVisited: 239,
      estimatedCensusBoxes: 239,
      discoveredAntennas: 62238,
      scannedAntennas: 62238,
      totalAntennas: 62238,
      percent: 100,
    };
    expect(
      shouldIgnoreScheduleWorkflowRun(
        Date.parse('2026-11-16T17:03:10Z'),
        before18Doc,
      ),
    ).toBe(false);

    // 17:43 UTC (18:43 CET) cuando el escaneo de las 17:03 UTC (18:03 CET) YA completó -> se ignora respaldo
    const done18Doc: ScanStatusPayload = {
      ...before18Doc,
      scanId: 'daily-1803',
      trigger: 'schedule',
      startedAt: '2026-11-16T17:03:05Z',
      updatedAt: '2026-11-16T17:20:00Z',
    };
    expect(
      shouldIgnoreScheduleWorkflowRun(
        Date.parse('2026-11-16T17:43:10Z'),
        done18Doc,
      ),
    ).toBe(true);

    // Si un respaldo `schedule` fugaz (<60s) terminó encima de un escaneo `in_progress`, sigue detectando el activo
    resetScanProgressInternalCacheForTests();
    const nowIso = new Date().toISOString();
    const fiveSecAgoIso = new Date(Date.now() - 5_000).toISOString();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/git/ref/heads/scan-status')) {
        return new Response(JSON.stringify({ object: { sha: 'sha-old' } }), {
          status: 200,
          headers: { 'X-RateLimit-Remaining': '58' },
        });
      }
      if (url.includes('/sha-old/scan-status.json')) {
        return new Response(JSON.stringify(before18Doc), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/actions/workflows/update-and-deploy.yml/runs')) {
        return new Response(
          JSON.stringify({
            workflow_runs: [
              {
                id: 950002,
                event: 'schedule',
                status: 'completed',
                conclusion: 'success',
                created_at: fiveSecAgoIso,
                updated_at: nowIso,
              },
              {
                id: 950001,
                event: 'workflow_dispatch',
                status: 'in_progress',
                conclusion: null,
                created_at: fiveSecAgoIso,
                run_started_at: fiveSecAgoIso,
              },
            ],
          }),
          {
            status: 200,
            headers: { 'X-RateLimit-Remaining': '57' },
          },
        );
      }
      return new Response('Not found', { status: 404 });
    });

    const detected = await fetchLiveScanStatus();
    expect(detected?.state).toBe('running');
    expect(detected?.scanId).toBe('950001');
    fetchSpy.mockRestore();
  });
});

describe('Conteo exacto hasta la unidad en clústeres del mapa sin redondeo', () => {
  function flattenExpressionTokens(expr: unknown): (string | number | boolean)[] {
    if (Array.isArray(expr)) {
      const acc: (string | number | boolean)[] = [];
      for (let i = 0; i < expr.length; i++) {
        acc.push(...flattenExpressionTokens(expr[i]));
      }
      return acc;
    }
    if (
      typeof expr === 'string' ||
      typeof expr === 'number' ||
      typeof expr === 'boolean'
    ) {
      return [expr];
    }
    return [];
  }

  function evaluateNumericStepExpr(expr: unknown, countValue: number): number {
    if (!Array.isArray(expr) || expr[0] !== 'step' || expr.length < 3) {
      throw new Error('Se esperaba una expresión MapLibre ["step", input, default, ...]');
    }
    let result = Number(expr[2]);
    for (let i = 3; i + 1 < expr.length; i += 2) {
      const stopThreshold = Number(expr[i]);
      const stopOutput = Number(expr[i + 1]);
      if (countValue >= stopThreshold) {
        result = stopOutput;
      } else {
        break;
      }
    }
    return result;
  }

  it('construye la expresión WebGL exacta hasta la unidad sin step, concat, sufijo k ni divisiones por 100 o 1000', () => {
    const exactCountExpr = AntenasMapModule.buildClusterExactCountExpr();
    expect(exactCountExpr).toEqual([
      'round',
      ['coalesce', ['get', 'stationSum'], ['get', 'point_count']],
    ]);

    const textFieldExpr = AntenasMapModule.buildClusterCountTextFieldExpr();
    expect(textFieldExpr).toEqual([
      'to-string',
      ['round', ['coalesce', ['get', 'stationSum'], ['get', 'point_count']]],
    ]);

    const tokens = flattenExpressionTokens(textFieldExpr);
    expect(tokens).not.toContain('step');
    expect(tokens).not.toContain('concat');
    expect(tokens).not.toContain('number-format');
    expect(tokens).not.toContain('k');
    expect(tokens).not.toContain('K');
    expect(tokens).not.toContain('/');
    expect(tokens).not.toContain(100);
    expect(tokens).not.toContain(1000);
  });

  it('configura stationSum en clusterProperties y conecta LAYER_CLUSTER_COUNT sin redondeo k en AntenasMap.tsx', () => {
    expect(antenasMapRawSource).toContain('stationCount: site.members.length');
    expect(antenasMapRawSource).toMatch(
      /clusterProperties:\s*\{\s*stationSum:\s*\['\+',\s*\['get',\s*'stationCount'\]\]/,
    );

    expect(antenasMapRawSource).toMatch(
      /id:\s*LAYER_CLUSTERS[\s\S]*?'circle-radius':\s*buildClusterCircleRadiusExpr\(\)/,
    );

    const clusterCountLayerMatch = antenasMapRawSource.match(
      /id:\s*LAYER_CLUSTER_COUNT[\s\S]*?paint:\s*\{[\s\S]*?\}/,
    );
    expect(clusterCountLayerMatch).not.toBeNull();
    const clusterCountLayerBlock = clusterCountLayerMatch?.[0] ?? '';

    expect(clusterCountLayerBlock).toContain(
      "'text-field': buildClusterCountTextFieldExpr()",
    );
    expect(clusterCountLayerBlock).toContain(
      "'text-size': buildClusterCountTextSizeExpr()",
    );
    expect(clusterCountLayerBlock).toMatch(/'text-allow-overlap':\s*true/);
    expect(clusterCountLayerBlock).toMatch(/'text-ignore-placement':\s*true/);

    // Regresión estructural: prohibido truncar o abreviar miles con 'k' o dividir entre 100
    expect(antenasMapRawSource).not.toContain("['/', clusterCountExpr, 100]");
    expect(antenasMapRawSource).not.toContain('point_count_abbreviated');
    expect(clusterCountLayerBlock).not.toContain("'concat'");
    expect(clusterCountLayerBlock).not.toMatch(/['"]k['"]/i);
  });

  it('evaluateClusterCountLabel devuelve cadenas enteras exactas hasta la unidad con stationSum (incluyendo emplazamientos < 30 m) y con fallback a point_count', () => {
    const exactUnitCounts = [2, 49, 999, 1000, 1247, 5893, 15482, 62238];

    for (const exactCount of exactUnitCounts) {
      const reducedPointCount = Math.max(1, Math.floor(exactCount * 0.78));
      const withStationSum = AntenasMapModule.evaluateClusterCountLabel({
        stationSum: exactCount,
        point_count: reducedPointCount,
      });
      expect(withStationSum).toBe(String(exactCount));
      expect(withStationSum).toMatch(/^\d+$/);
      expect(withStationSum).not.toContain('k');
      expect(withStationSum).not.toContain('.');
      expect(withStationSum).not.toContain(',');

      const fallbackPointCount = AntenasMapModule.evaluateClusterCountLabel({
        point_count: exactCount,
      });
      expect(fallbackPointCount).toBe(String(exactCount));
    }

    // Caso representativo de emplazamientos compartidos (< 30 m) donde stationSum > point_count
    expect(
      AntenasMapModule.evaluateClusterCountLabel({
        stationSum: 1247,
        point_count: 983,
      }),
    ).toBe('1247');

    // Redondeo defensivo ante posible ruido en coma flotante de WebGL y valores ausentes/no finitos
    expect(
      AntenasMapModule.evaluateClusterCountLabel({
        stationSum: 1246.9999999,
        point_count: 983,
      }),
    ).toBe('1247');
    expect(
      AntenasMapModule.evaluateClusterCountLabel({
        stationSum: Number.NaN,
        point_count: 15482,
      }),
    ).toBe('15482');
    expect(AntenasMapModule.evaluateClusterCountLabel({})).toBe('0');
    expect(
      AntenasMapModule.evaluateClusterCountLabel({ stationSum: -4 }),
    ).toBe('0');
  });

  it('groupColocatedAntennasForMap conserva la suma exacta de antenas hasta la unidad (stationCount) en datasets mixtos con emplazamientos compartidos < 30 m y estaciones individuales', () => {
    const makeStation = (
      id: string,
      gid: string,
      op: OperatorKey,
      lat: number,
      lon: number,
    ): AntennaRecord => ({
      id,
      gid,
      op,
      opRaw: OPERATOR_META[op].name,
      lat,
      lon,
      dir: 'CALLE PRUEBA 1',
      mun: 'MADRID',
      prov: 'MADRID',
    });

    const mixedAntenas: AntennaRecord[] = [];

    // 1. 120 emplazamientos tri-operador (< 30 m: ~9 m de separación) => 360 antenas reales en 120 puntos GeoJSON
    for (let i = 0; i < 120; i++) {
      const baseLat = 40.0 + i * 0.01;
      const baseLon = -3.9 + (i % 10) * 0.01;
      mixedAntenas.push(
        makeStation(`TRI-MOV-${i}`, `2801${i}`, 'movistar', baseLat, baseLon),
        makeStation(
          `TRI-ORA-${i}`,
          `2802${i}`,
          'orange',
          baseLat + 0.00005,
          baseLon + 0.00004,
        ),
        makeStation(
          `TRI-DIG-${i}`,
          `2803${i}`,
          'digi',
          baseLat - 0.00004,
          baseLon + 0.00005,
        ),
      );
    }

    // 2. 24 emplazamientos bi-operador (< 30 m: ~7 m de separación) => 48 antenas reales en 24 puntos GeoJSON
    for (let i = 0; i < 24; i++) {
      const baseLat = 41.5 + i * 0.01;
      const baseLon = 2.0 + (i % 8) * 0.01;
      mixedAntenas.push(
        makeStation(`BI-VOD-${i}`, `0801${i}`, 'vodafone', baseLat, baseLon),
        makeStation(
          `BI-MAS-${i}`,
          `0802${i}`,
          'masmovil',
          baseLat + 0.00004,
          baseLon - 0.00004,
        ),
      );
    }

    // 3. Pareja de Telefónica/Movistar a < 30 m (~11 m): NUNCA se fusionan entre sí => 2 antenas en 2 puntos
    mixedAntenas.push(
      makeStation('MOV-PAIR-A', '460001', 'movistar', 39.4699, -0.3763),
      makeStation('MOV-PAIR-B', '460002', 'movistar', 39.47, -0.3763),
    );

    // 4. 837 estaciones individuales aisladas (> 1 km entre sí) => 837 antenas en 837 puntos GeoJSON
    // Total exacto = 360 + 48 + 2 + 837 = 1247 antenas reales en 120 + 24 + 2 + 837 = 983 puntos GeoJSON
    const singleOps: OperatorKey[] = [
      'movistar',
      'orange',
      'vodafone',
      'masmovil',
      'digi',
      'otros',
    ];
    for (let i = 0; i < 837; i++) {
      const op = singleOps[i % singleOps.length];
      const lat = 36.5 + Math.floor(i / 30) * 0.05;
      const lon = -6.0 + (i % 30) * 0.05;
      mixedAntenas.push(makeStation(`SINGLE-${i}`, `419${i}`, op, lat, lon));
    }

    expect(mixedAntenas).toHaveLength(1247);

    const groupedSites = groupColocatedAntennasForMap(
      mixedAntenas,
      MULTI_OPERATOR_SITE_MAX_DISTANCE_METERS,
    );
    expect(groupedSites).toHaveLength(983);

    const multiOpSites = groupedSites.filter((s) => s.isMultiOperator);
    expect(multiOpSites).toHaveLength(144);

    // Suma exacta de `stationCount` (`site.members.length`) agregada en `stationSum` por MapLibre
    const stationSumAcrossSites = groupedSites.reduce(
      (sum, site) => sum + site.members.length,
      0,
    );
    expect(stationSumAcrossSites).toBe(1247);
    expect(stationSumAcrossSites).toBe(mixedAntenas.length);

    expect(
      AntenasMapModule.evaluateClusterCountLabel({
        stationSum: stationSumAcrossSites,
        point_count: groupedSites.length,
      }),
    ).toBe('1247');
  });

  it('escala limpiamente circle-radius y text-size hasta conteos exactos de 4 y 5 cifras (10000 -> radio 34 / diámetro 68 px vs text-size 11.5 px)', () => {
    const exactCountExpr = AntenasMapModule.buildClusterExactCountExpr();
    const radiusExpr = AntenasMapModule.buildClusterCircleRadiusExpr();
    const textSizeExpr = AntenasMapModule.buildClusterCountTextSizeExpr();

    expect(radiusExpr).toEqual([
      'step',
      exactCountExpr,
      15.5,
      50,
      19,
      250,
      23,
      1000,
      27.5,
      5000,
      31,
      10000,
      34,
    ]);

    expect(textSizeExpr).toEqual([
      'step',
      exactCountExpr,
      11,
      250,
      11.5,
    ]);

    const expectedScale: {
      count: number;
      radius: number;
      textSize: number;
    }[] = [
      { count: 2, radius: 15.5, textSize: 11 },
      { count: 49, radius: 15.5, textSize: 11 },
      { count: 50, radius: 19, textSize: 11 },
      { count: 249, radius: 19, textSize: 11 },
      { count: 250, radius: 23, textSize: 11.5 },
      { count: 999, radius: 23, textSize: 11.5 },
      { count: 1000, radius: 27.5, textSize: 11.5 },
      { count: 1247, radius: 27.5, textSize: 11.5 },
      { count: 4999, radius: 27.5, textSize: 11.5 },
      { count: 5000, radius: 31, textSize: 11.5 },
      { count: 5893, radius: 31, textSize: 11.5 },
      { count: 9999, radius: 31, textSize: 11.5 },
      { count: 10000, radius: 34, textSize: 11.5 },
      { count: 15482, radius: 34, textSize: 11.5 },
      { count: 62238, radius: 34, textSize: 11.5 },
    ];

    for (const { count, radius, textSize } of expectedScale) {
      const actualRadius = evaluateNumericStepExpr(radiusExpr, count);
      const actualTextSize = evaluateNumericStepExpr(textSizeExpr, count);
      expect(actualRadius).toBe(radius);
      expect(actualTextSize).toBe(textSize);

      const label = AntenasMapModule.evaluateClusterCountLabel({
        stationSum: count,
      });
      const diameterPx = actualRadius * 2;
      // Ancho estimado conservador de dígitos tabulares en Noto Sans Regular (~0.62 * fontSize por dígito)
      const estimatedLabelWidthPx = label.length * actualTextSize * 0.62;
      expect(diameterPx - estimatedLabelWidthPx).toBeGreaterThanOrEqual(14);
    }

    // Verificación explícita de 5 dígitos (10000+): radio 34 px -> diámetro 68 px frente a text-size 11.5 px
    expect(evaluateNumericStepExpr(radiusExpr, 10000) * 2).toBe(68);
    expect(evaluateNumericStepExpr(textSizeExpr, 10000)).toBe(11.5);
  });
});

describe('Tabla Novedades compacta, frecuencia inicio/fin en dos líneas, divisores verticales y agrupación antena nueva + frecuencias', () => {
  it('splitFrequencyRangeLines y splitScanDateTimeLines dividen rangos MHz/GHz y fecha/hora en dos líneas compactas', () => {
    expect(splitFrequencyRangeLines('3460.00 - 3600.00 MHz')).toEqual({
      start: '3460.00 MHz',
      end: '3600.00 MHz',
    });

    expect(splitFrequencyRangeLines('26.50 - 27.50 GHz')).toEqual({
      start: '26.50 GHz',
      end: '27.50 GHz',
    });

    expect(splitFrequencyRangeLines('26.50 – 27.50 ghz')).toEqual({
      start: '26.50 GHz',
      end: '27.50 GHz',
    });

    expect(splitFrequencyRangeLines('758.00 - 768.00')).toEqual({
      start: '758.00 MHz',
      end: '768.00 MHz',
    });

    expect(splitFrequencyRangeLines('26 GHz')).toEqual({
      start: '26 GHz',
      end: null,
    });

    expect(splitFrequencyRangeLines('')).toEqual({
      start: '—',
      end: null,
    });
    expect(splitFrequencyRangeLines('   ')).toEqual({
      start: '—',
      end: null,
    });

    expect(splitScanDateTimeLines('15/11/2026 18:04:27')).toEqual({
      datePart: '15/11/2026',
      timePart: '18:04:27',
    });
    expect(splitScanDateTimeLines('15/11/2026')).toEqual({
      datePart: '15/11/2026',
      timePart: null,
    });
    expect(splitScanDateTimeLines('')).toEqual({
      datePart: '—',
      timePart: null,
    });

    expect(
      getNovedadAntennaGroupKey({
        antennaId: 'DIGI SPAIN TELECOM, S.L.U. - 2809001',
        op: 'digi',
        codigo: '2809001',
      }),
    ).toBe('DIGI SPAIN TELECOM, S.L.U. - 2809001');
    expect(
      getNovedadAntennaGroupKey({
        antennaId: '   ',
        op: 'digi',
        codigo: '2809001',
      }),
    ).toBe('digi::2809001');
  });

  it('orderNovedadesGroupedByNewAntenna intercala cada antena nueva seguida inmediatamente por sus frecuencias asociadas y deja al final las frecuencias de antenas ya existentes', () => {
    const scrambledInput: NovedadRecord[] = [
      // Frecuencia de antena existente (Vodafone) puesta primero en la entrada desordenada
      {
        id: 'freq::VOD-EXIST-0800100::3500',
        tipo: 'frecuencia',
        op: 'vodafone',
        opRaw: 'VODAFONE ESPAÑA, S.A.U.',
        codigo: '0800100',
        antennaId: 'VODAFONE ESPAÑA, S.A.U. - 0800100',
        codigoBanda: 'B-VOD-3500',
        frecuencia: '3710.00 - 3800.00 MHz',
        ubicacion: 'BARCELONA',
        prov: 'BARCELONA',
        scannedAt: '2026-11-16T18:09:00Z',
        fecha: '16/11/2026 19:09:00',
      },
      // Antena nueva 2 (Orange, escaneada antes que Antena nueva 1)
      {
        id: 'antena::ORA-NEW-4600200',
        tipo: 'antena',
        op: 'orange',
        opRaw: 'ORANGE ESPAGNE, S.A.U.',
        codigo: '4600200',
        antennaId: 'ORANGE ESPAGNE, S.A.U. - 4600200',
        codigoBanda: '',
        frecuencia: '',
        ubicacion: 'VALENCIA',
        prov: 'VALENCIA',
        scannedAt: '2026-11-16T18:03:00Z',
        fecha: '16/11/2026 19:03:00',
      },
      // Antena nueva 1 (DIGI, más reciente)
      {
        id: 'antena::DIGI-NEW-2809500',
        tipo: 'antena',
        op: 'digi',
        opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
        codigo: '2809500',
        antennaId: 'DIGI SPAIN TELECOM, S.L.U. - 2809500',
        codigoBanda: '',
        frecuencia: '',
        ubicacion: 'MADRID',
        prov: 'MADRID',
        scannedAt: '2026-11-16T18:06:00Z',
        fecha: '16/11/2026 19:06:00',
      },
      // Frecuencias asociadas a Antena nueva 1 en orden inverso de banda (2600 antes de 1800)
      {
        id: 'freq::DIGI-NEW-2809500::2600',
        tipo: 'frecuencia',
        op: 'digi',
        opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
        codigo: '2809500',
        antennaId: 'DIGI SPAIN TELECOM, S.L.U. - 2809500',
        codigoBanda: 'DG-2600',
        frecuencia: '2620.00 - 2640.00 MHz',
        ubicacion: 'MADRID',
        prov: 'MADRID',
        scannedAt: '2026-11-16T18:06:02Z',
        fecha: '16/11/2026 19:06:02',
      },
      // Frecuencia de otra antena existente (Movistar)
      {
        id: 'freq::MOV-EXIST-2800001::700',
        tipo: 'frecuencia',
        op: 'movistar',
        opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
        codigo: '2800001',
        antennaId: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800001',
        codigoBanda: 'M-700',
        frecuencia: '758.00 - 768.00 MHz',
        ubicacion: 'MADRID',
        prov: 'MADRID',
        scannedAt: '2026-11-16T18:08:00Z',
        fecha: '16/11/2026 19:08:00',
      },
      // Frecuencias asociadas a Antena nueva 2 (26 GHz y 800 MHz mezcladas)
      {
        id: 'freq::ORA-NEW-4600200::26GHZ',
        tipo: 'frecuencia',
        op: 'orange',
        opRaw: 'ORANGE ESPAGNE, S.A.U.',
        codigo: '4600200',
        antennaId: 'ORANGE ESPAGNE, S.A.U. - 4600200',
        codigoBanda: 'OR-26G',
        frecuencia: '26.50 - 27.50 GHz',
        ubicacion: 'VALENCIA',
        prov: 'VALENCIA',
        scannedAt: '2026-11-16T18:03:05Z',
        fecha: '16/11/2026 19:03:05',
      },
      {
        id: 'freq::DIGI-NEW-2809500::1800',
        tipo: 'frecuencia',
        op: 'digi',
        opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
        codigo: '2809500',
        antennaId: 'DIGI SPAIN TELECOM, S.L.U. - 2809500',
        codigoBanda: 'DG-1800',
        frecuencia: '1805.00 - 1825.00 MHz',
        ubicacion: 'MADRID',
        prov: 'MADRID',
        scannedAt: '2026-11-16T18:06:01Z',
        fecha: '16/11/2026 19:06:01',
      },
      {
        id: 'freq::ORA-NEW-4600200::800',
        tipo: 'frecuencia',
        op: 'orange',
        opRaw: 'ORANGE ESPAGNE, S.A.U.',
        codigo: '4600200',
        antennaId: 'ORANGE ESPAGNE, S.A.U. - 4600200',
        codigoBanda: 'OR-800',
        frecuencia: '791.00 - 801.00 MHz',
        ubicacion: 'VALENCIA',
        prov: 'VALENCIA',
        scannedAt: '2026-11-16T18:03:04Z',
        fecha: '16/11/2026 19:03:04',
      },
      //Segunda frecuencia de la antena existente Vodafone (700 MHz debe ir antes de 3500 MHz dentro del grupo Vodafone)
      {
        id: 'freq::VOD-EXIST-0800100::700',
        tipo: 'frecuencia',
        op: 'vodafone',
        opRaw: 'VODAFONE ESPAÑA, S.A.U.',
        codigo: '0800100',
        antennaId: 'VODAFONE ESPAÑA, S.A.U. - 0800100',
        codigoBanda: 'B-VOD-700',
        frecuencia: '768.00 - 778.00 MHz',
        ubicacion: 'BARCELONA',
        prov: 'BARCELONA',
        scannedAt: '2026-11-16T18:08:50Z',
        fecha: '16/11/2026 19:08:50',
      },
    ];

    const expectedIds = [
      // Antena nueva 1 + sus frecuencias asociadas en orden ascendente de MHz
      'antena::DIGI-NEW-2809500',
      'freq::DIGI-NEW-2809500::1800',
      'freq::DIGI-NEW-2809500::2600',
      // Antena nueva 2 + sus frecuencias asociadas en orden ascendente (800 MHz -> 26.50 GHz)
      'antena::ORA-NEW-4600200',
      'freq::ORA-NEW-4600200::800',
      'freq::ORA-NEW-4600200::26GHZ',
      // Después todas las frecuencias nuevas de antenas ya existentes agrupadas por antena
      'freq::VOD-EXIST-0800100::700',
      'freq::VOD-EXIST-0800100::3500',
      'freq::MOV-EXIST-2800001::700',
    ];

    const ordered = orderNovedadesGroupedByNewAntenna(scrambledInput);
    expect(ordered.map((r) => r.id)).toEqual(expectedIds);

    const parsedDataset = parseCustomNovedadesJson({
      updatedAt: '2026-11-16T18:10:00Z',
      scanId: 'daily-2026-11-16',
      previousScanAt: '2026-11-15T18:10:00Z',
      isBaselineScan: false,
      total: scrambledInput.length,
      antenasNuevas: 2,
      frecuenciasNuevas: 7,
      novedades: scrambledInput,
    });
    expect(parsedDataset.novedades.map((r) => r.id)).toEqual(expectedIds);
  });

  it('renderiza en SSR frecuencias apiladas inicio/fin, orden agrupado antena+frecuencias y CSS compacto con líneas verticales entre columnas', async () => {
    const dataset: NovedadesDataset = {
      updatedAt: '2026-11-16T18:10:00Z',
      scanId: 'daily-2026-11-16',
      previousScanAt: '2026-11-15T18:10:00Z',
      isBaselineScan: false,
      total: 4,
      antenasNuevas: 1,
      frecuenciasNuevas: 3,
      // Entrada deliberadamente desordenada: primero todas las antenas o frecuencias sueltas
      novedades: [
        {
          id: 'freq::MOV-EXIST-2800001::3500',
          tipo: 'frecuencia',
          op: 'movistar',
          opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
          codigo: '2800001',
          antennaId: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800001',
          codigoBanda: 'M M -2205199',
          frecuencia: '3460.00 - 3600.00 MHz',
          ubicacion: 'MADRID',
          prov: 'MADRID',
          scannedAt: '2026-11-16T18:09:00Z',
          fecha: '16/11/2026 19:09:00',
        },
        {
          id: 'antena::DIGI-NEW-2809991',
          tipo: 'antena',
          op: 'digi',
          opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
          codigo: '2809991',
          antennaId: 'DIGI SPAIN TELECOM, S.L.U. - 2809991',
          codigoBanda: '',
          frecuencia: '',
          ubicacion: 'ALCALÁ DE HENARES',
          prov: 'MADRID',
          scannedAt: '2026-11-16T18:04:11Z',
          fecha: '16/11/2026 19:04:11',
        },
        {
          id: 'freq::DIGI-NEW-2809991::2600',
          tipo: 'frecuencia',
          op: 'digi',
          opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
          codigo: '2809991',
          antennaId: 'DIGI SPAIN TELECOM, S.L.U. - 2809991',
          codigoBanda: 'DG-2600',
          frecuencia: '2620.00 - 2640.00 MHz',
          ubicacion: 'ALCALÁ DE HENARES',
          prov: 'MADRID',
          scannedAt: '2026-11-16T18:04:13Z',
          fecha: '16/11/2026 19:04:13',
        },
        {
          id: 'freq::DIGI-NEW-2809991::1800',
          tipo: 'frecuencia',
          op: 'digi',
          opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
          codigo: '2809991',
          antennaId: 'DIGI SPAIN TELECOM, S.L.U. - 2809991',
          codigoBanda: 'DG-1800',
          frecuencia: '1805.00 - 1825.00 MHz',
          ubicacion: 'ALCALÁ DE HENARES',
          prov: 'MADRID',
          scannedAt: '2026-11-16T18:04:12Z',
          fecha: '16/11/2026 19:04:12',
        },
      ],
    };

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['novedades-dataset'], dataset);
    queryClient.setQueryData(['antenas-dataset'], createSampleCustomDataset());
    queryClient.setQueryData(['scan-status'], null);

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

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(RouterProvider, { router: testRouter }),
      ),
    );

    // 1. Frecuencias en dos líneas: inicio arriba (.novedades-freq-start) y final abajo (.novedades-freq-end)
    expect(html).toContain(
      '<span class="novedades-freq-line novedades-freq-start">3460.00 MHz</span>',
    );
    expect(html).toContain(
      '<span class="novedades-freq-line novedades-freq-end">3600.00 MHz</span>',
    );
    expect(html).toContain(
      '<span class="novedades-freq-line novedades-freq-start">1805.00 MHz</span>',
    );
    expect(html).toContain(
      '<span class="novedades-freq-line novedades-freq-end">1825.00 MHz</span>',
    );
    expect(html).toContain('<span class="novedades-date-day">16/11/2026</span>');
    expect(html).toContain('<span class="novedades-date-time">19:09:00</span>');

    // 2. Orden exacto de filas en el DOM de #novedades-table:
    //    Fila 1: Antena nueva DIGI (2809991)
    //    Fila 2: Frecuencia asociada DIGI 1800 MHz (.is-associated-freq)
    //    Fila 3: Frecuencia asociada DIGI 2600 MHz (.is-associated-freq)
    //    Fila 4: Frecuencia de antena existente Movistar 3500 MHz (sin .is-associated-freq)
    const rowMatches = Array.from(
      html.matchAll(/<tr\b[^>]*class="([^"]*novedades-row[^"]*)"[^>]*>([\s\S]*?)<\/tr>/g),
    );
    expect(rowMatches).toHaveLength(4);
    expect(rowMatches[0]?.[1]).toBe('novedades-row');
    expect(rowMatches[0]?.[2]).toContain('<span>Antena</span>');
    expect(rowMatches[0]?.[2]).toContain('2809991');

    expect(rowMatches[1]?.[1]).toContain('is-associated-freq');
    expect(rowMatches[1]?.[2]).toContain('<span>Frecuencia</span>');
    expect(rowMatches[1]?.[2]).toContain('DG-1800');

    expect(rowMatches[2]?.[1]).toContain('is-associated-freq');
    expect(rowMatches[2]?.[2]).toContain('<span>Frecuencia</span>');
    expect(rowMatches[2]?.[2]).toContain('DG-2600');

    expect(rowMatches[3]?.[1]).toBe('novedades-row');
    expect(rowMatches[3]?.[2]).toContain('<span>Frecuencia</span>');
    expect(rowMatches[3]?.[2]).toContain('M M -2205199');

    // 3. Verificación CSS: anchura compacta min-width: 460px y líneas verticales separadoras entre columnas
    const fsSpecifier = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFileSync: (path: URL, encoding: string) => string;
    };
    const indexCssSource = readFileSync(
      new URL('../styles/index.css', import.meta.url),
      'utf-8',
    );
    expect(indexCssSource).toMatch(
      /\.novedades-table\s*\{[^}]*min-width:\s*460px;/,
    );
    expect(indexCssSource).not.toMatch(
      /\.novedades-table\s*\{[^}]*min-width:\s*880px;/,
    );
    expect(indexCssSource).toMatch(
      /\.novedades-table thead th:not\(:last-child\)\s*\{[^}]*border-right:\s*1px solid/,
    );
    expect(indexCssSource).toMatch(
      /\.novedades-table tbody td:not\(:last-child\)\s*\{[^}]*border-right:\s*1px solid/,
    );
    expect(indexCssSource).toMatch(
      /\[data-theme='dark'\]\s+\.novedades-table tbody td:not\(:last-child\)\s*\{[^}]*border-right-color:/,
    );
    expect(indexCssSource).toMatch(
      /\.novedades-freq-stack\s*\{[^}]*flex-direction:\s*column;/,
    );
    expect(indexCssSource).toMatch(
      /\.novedades-cell-novedad\s*\{[^}]*flex-direction:\s*column;/,
    );
  });
});

describe('Rango de fusión multioperador en mapa y StationDetailDrawer (< 30 m)', () => {
  it('fija MULTI_OPERATOR_SITE_MAX_DISTANCE_METERS en 30 m en AntenasMap y StationDetailDrawer (fusionando a ~28 m y separando a ~32 m)', () => {
    expect(MULTI_OPERATOR_SITE_MAX_DISTANCE_METERS).toBe(30);
    expect(antenasMapRawSource).toMatch(
      /groupColocatedAntennasForMap\(\s*antenas,\s*MULTI_OPERATOR_SITE_MAX_DISTANCE_METERS,?\s*\)/,
    );
    expect(antenasMapRawSource).not.toMatch(
      /groupColocatedAntennasForMap\(\s*antenas,\s*35\b/,
    );
    expect(antenasMapRawSource).toContain(
      'Emplazamiento compartido (&lt; ${MULTI_OPERATOR_SITE_MAX_DISTANCE_METERS} m)',
    );

    const baseLat = 40.4168;
    const baseLon = -3.7038;
    const movistarBase: AntennaRecord = {
      id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2807701',
      gid: '2807701',
      op: 'movistar',
      opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
      lat: baseLat,
      lon: baseLon,
      dir: 'C/ Gran Vía, 28',
      mun: 'Madrid',
      prov: 'Madrid',
    };
    const orange28m: AntennaRecord = {
      id: 'ORANGE ESPAGNE, S.A.U. - 2807702',
      gid: '2807702',
      op: 'orange',
      opRaw: 'ORANGE ESPAGNE, S.A.U.',
      lat: baseLat + 0.000252, // ~28.0 m (< 30 m)
      lon: baseLon,
      dir: 'C/ Gran Vía, 28',
      mun: 'Madrid',
      prov: 'Madrid',
    };
    const digi32m: AntennaRecord = {
      id: 'DIGI SPAIN TELECOM, S.L.U. - 2807703',
      gid: '2807703',
      op: 'digi',
      opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
      lat: baseLat + 0.000288, // ~32.0 m (>= 30 m, antes < 35 m)
      lon: baseLon,
      dir: 'C/ Gran Vía, 30',
      mun: 'Madrid',
      prov: 'Madrid',
    };

    const htmlUnder30m = renderToStaticMarkup(
      createElement(StationDetailDrawer, {
        antenna: movistarBase,
        allAntenas: [movistarBase, orange28m],
        onClose: () => {},
        onSelectAntenna: () => {},
      }),
    );
    expect(htmlUnder30m).toContain('integrated-operators-card');
    expect(htmlUnder30m).toContain(
      'Operadores integrados en este icono (&lt; 30 m)',
    );
    expect(htmlUnder30m).not.toContain(
      'Operadores integrados en este icono (&lt; 35 m)',
    );

    const htmlOver30m = renderToStaticMarkup(
      createElement(StationDetailDrawer, {
        antenna: movistarBase,
        allAntenas: [movistarBase, digi32m],
        onClose: () => {},
        onSelectAntenna: () => {},
      }),
    );
    expect(htmlOver30m).not.toContain('integrated-operators-card');
  });
});

describe('Listado permanente y acumulativo de Novedades entre múltiples escaneos', () => {
  it('conserva el 100 % de las novedades históricas cuando arranca un nuevo escaneo con 0 novedades nuevas (deltaSeq > 0, novedades: [])', () => {
    const scan1Dataset: NovedadesDataset = {
      updatedAt: '2026-11-15T18:20:00Z',
      scanId: 'daily-2026-11-15',
      previousScanAt: '2026-11-14T18:20:00Z',
      isBaselineScan: false,
      total: 3,
      antenasNuevas: 1,
      frecuenciasNuevas: 2,
      novedades: [
        {
          id: 'antena::DIGI-SCAN1-2809100',
          tipo: 'antena',
          op: 'digi',
          opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
          codigo: '2809100',
          antennaId: 'DIGI SPAIN TELECOM, S.L.U. - 2809100',
          codigoBanda: '',
          frecuencia: '',
          ubicacion: 'MADRID',
          prov: 'MADRID',
          scanId: 'daily-2026-11-15',
          scannedAt: '2026-11-15T18:05:10Z',
          fecha: '15/11/2026 19:05:10',
        },
        {
          id: 'freq::DIGI-SCAN1-2809100::1800',
          tipo: 'frecuencia',
          op: 'digi',
          opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
          codigo: '2809100',
          antennaId: 'DIGI SPAIN TELECOM, S.L.U. - 2809100',
          codigoBanda: 'DG-1800',
          frecuencia: '1805.00 - 1825.00 MHz',
          ubicacion: 'MADRID',
          prov: 'MADRID',
          scanId: 'daily-2026-11-15',
          scannedAt: '2026-11-15T18:05:11Z',
          fecha: '15/11/2026 19:05:11',
        },
        {
          id: 'freq::MOV-SCAN1-2800001::3500',
          tipo: 'frecuencia',
          op: 'movistar',
          opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
          codigo: '2800001',
          antennaId: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800001',
          codigoBanda: 'M M -2205199',
          frecuencia: '3460.00 - 3600.00 MHz',
          ubicacion: 'MADRID',
          prov: 'MADRID',
          scanId: 'daily-2026-11-15',
          scannedAt: '2026-11-15T18:09:00Z',
          fecha: '15/11/2026 19:09:00',
        },
      ],
    };

    const emptyScan2Chunk: LiveScanDeltaChunk = {
      schemaVersion: 2,
      scanId: 'daily-2026-11-16',
      seq: 3,
      chunkIndex: 0,
      isTail: true,
      updatedAt: '2026-11-16T18:02:00Z',
      recordNovedades: true,
      previousScanAt: '2026-11-15T18:20:00Z',
      newAntennas: [],
      bandPatches: [
        {
          id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800001',
          gid: '2800001',
          bandas: ['3500 MHz'],
          frecuencias: ['3460.00 - 3600.00'],
          concesiones: [{ ref: 'M M -2205199', freq: '3460.00 - 3600.00' }],
          bandsScannedAt: '2026-11-16T18:01:58Z',
        },
      ],
      novedades: [],
    };

    const emptyScan2Delta = accumulateLiveDeltaChunks(
      [emptyScan2Chunk],
      'daily-2026-11-16',
    );
    expect(emptyScan2Delta.deltaSeq).toBe(3);
    expect(emptyScan2Delta.novedades).toEqual([]);

    const merged = mergeLiveDeltaIntoNovedadesDataset(
      scan1Dataset,
      emptyScan2Delta,
    );

    expect(merged.scanId).toBe('daily-2026-11-16');
    expect(merged.total).toBe(3);
    expect(merged.antenasNuevas).toBe(1);
    expect(merged.frecuenciasNuevas).toBe(2);
    expect(merged.novedades.map((n) => n.id)).toEqual([
      'antena::DIGI-SCAN1-2809100',
      'freq::DIGI-SCAN1-2809100::1800',
      'freq::MOV-SCAN1-2800001::3500',
    ]);
  });

  it('acumula Scan 1 -> Scan 2 -> Scan 3 manteniendo cada lote agrupado en orden cronológico inverso y sin enterrar frecuencias nuevas debajo de antenas antiguas', async () => {
    // Validación de getNovedadScanBatchKey y scanId opcional en parseadores
    expect(
      getNovedadScanBatchKey({
        scanId: 'daily-2026-11-15',
        fecha: '15/11/2026 19:05:10',
        scannedAt: '2026-11-15T18:05:10Z',
      }),
    ).toBe('scan:daily-2026-11-15');
    expect(
      getNovedadScanBatchKey({
        fecha: '15/11/2026 19:05:10',
        scannedAt: '2026-11-15T18:05:10Z',
      }),
    ).toBe('day:2026-11-15');
    expect(
      getNovedadScanBatchKey({
        fecha: '',
        scannedAt: '2026-11-15T18:05:10Z',
      }),
    ).toBe('day:2026-11-15');
    expect(
      getNovedadScanBatchKey({
        fecha: '',
        scannedAt: '',
      }),
    ).toBe('day:unknown');

    expect(
      parseLiveScanDeltaChunk({
        schemaVersion: 2,
        scanId: 'scan-bad-item',
        seq: 1,
        chunkIndex: 0,
        isTail: true,
        updatedAt: '2026-11-15T18:00:00Z',
        recordNovedades: true,
        previousScanAt: null,
        newAntennas: [],
        bandPatches: [],
        novedades: [
          {
            id: 'antena::BAD',
            tipo: 'antena',
            op: 'digi',
            opRaw: 'DIGI',
            codigo: '28001',
            antennaId: 'DIGI - 28001',
            codigoBanda: '',
            frecuencia: '',
            ubicacion: 'MADRID',
            scanId: 999,
            scannedAt: '2026-11-15T18:00:00Z',
            fecha: '15/11/2026 19:00:00',
          },
        ],
      }),
    ).toBeNull();

    // Scan 1 (15/11/2026): 1 antena nueva DIGI (2809100) + su frecuencia 1800 MHz + 1 frecuencia existente Vodafone
    const scan1Dataset: NovedadesDataset = parseCustomNovedadesJson({
      updatedAt: '2026-11-15T18:20:00Z',
      scanId: 'scan-1',
      previousScanAt: '2026-11-14T18:20:00Z',
      isBaselineScan: false,
      total: 3,
      antenasNuevas: 1,
      frecuenciasNuevas: 2,
      novedades: [
        {
          id: 'freq::VOD-EXIST-0800100::800',
          tipo: 'frecuencia',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          codigo: '0800100',
          antennaId: 'VODAFONE ESPAÑA, S.A.U. - 0800100',
          codigoBanda: 'VF-800',
          frecuencia: '791.00 - 801.00 MHz',
          ubicacion: 'BARCELONA',
          prov: 'BARCELONA',
          scanId: 'scan-1',
          scannedAt: '2026-11-15T18:08:00Z',
          fecha: '15/11/2026 19:08:00',
        },
        {
          id: 'antena::DIGI-SCAN1-2809100',
          tipo: 'antena',
          op: 'digi',
          opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
          codigo: '2809100',
          antennaId: 'DIGI SPAIN TELECOM, S.L.U. - 2809100',
          codigoBanda: '',
          frecuencia: '',
          ubicacion: 'MADRID',
          prov: 'MADRID',
          scanId: 'scan-1',
          scannedAt: '2026-11-15T18:04:00Z',
          fecha: '15/11/2026 19:04:00',
        },
        {
          id: 'freq::DIGI-SCAN1-2809100::1800',
          tipo: 'frecuencia',
          op: 'digi',
          opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
          codigo: '2809100',
          antennaId: 'DIGI SPAIN TELECOM, S.L.U. - 2809100',
          codigoBanda: 'DG-1800',
          frecuencia: '1805.00 - 1825.00 MHz',
          ubicacion: 'MADRID',
          prov: 'MADRID',
          scanId: 'scan-1',
          scannedAt: '2026-11-15T18:04:02Z',
          fecha: '15/11/2026 19:04:02',
        },
      ],
    });

    // Scan 2 (16/11/2026): 1 antena nueva Orange + sus 2 frecuencias (2600 y 700) + 1 frecuencia existente Movistar
    // También incluye un ID duplicado histórico ('antena::DIGI-SCAN1-2809100') para verificar que conserva la fecha de Scan 1
    const scan2Delta = accumulateLiveDeltaChunks(
      [
        {
          schemaVersion: 2,
          scanId: 'scan-2',
          seq: 2,
          chunkIndex: 0,
          isTail: true,
          updatedAt: '2026-11-16T18:10:00Z',
          recordNovedades: true,
          previousScanAt: '2026-11-15T18:20:00Z',
          newAntennas: [],
          bandPatches: [],
          novedades: [
            {
              id: 'freq::MOV-EXIST-2800001::900',
              tipo: 'frecuencia',
              op: 'movistar',
              opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
              codigo: '2800001',
              antennaId: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800001',
              codigoBanda: 'M-900',
              frecuencia: '935.10 - 949.90 MHz',
              ubicacion: 'MADRID',
              prov: 'MADRID',
              scannedAt: '2026-11-16T18:09:00Z',
              fecha: '16/11/2026 19:09:00',
            },
            {
              id: 'freq::ORA-SCAN2-4600500::2600',
              tipo: 'frecuencia',
              op: 'orange',
              opRaw: 'ORANGE ESPAGNE, S.A.U.',
              codigo: '4600500',
              antennaId: 'ORANGE ESPAGNE, S.A.U. - 4600500',
              codigoBanda: 'OR-2600',
              frecuencia: '2620.00 - 2640.00 MHz',
              ubicacion: 'VALENCIA',
              prov: 'VALENCIA',
              scannedAt: '2026-11-16T18:05:03Z',
              fecha: '16/11/2026 19:05:03',
            },
            {
              id: 'antena::ORA-SCAN2-4600500',
              tipo: 'antena',
              op: 'orange',
              opRaw: 'ORANGE ESPAGNE, S.A.U.',
              codigo: '4600500',
              antennaId: 'ORANGE ESPAGNE, S.A.U. - 4600500',
              codigoBanda: '',
              frecuencia: '',
              ubicacion: 'VALENCIA',
              prov: 'VALENCIA',
              scannedAt: '2026-11-16T18:05:00Z',
              fecha: '16/11/2026 19:05:00',
            },
            {
              id: 'freq::ORA-SCAN2-4600500::700',
              tipo: 'frecuencia',
              op: 'orange',
              opRaw: 'ORANGE ESPAGNE, S.A.U.',
              codigo: '4600500',
              antennaId: 'ORANGE ESPAGNE, S.A.U. - 4600500',
              codigoBanda: 'OR-700',
              frecuencia: '768.00 - 778.00 MHz',
              ubicacion: 'VALENCIA',
              prov: 'VALENCIA',
              scannedAt: '2026-11-16T18:05:02Z',
              fecha: '16/11/2026 19:05:02',
            },
            {
              id: 'antena::DIGI-SCAN1-2809100',
              tipo: 'antena',
              op: 'digi',
              opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
              codigo: '2809100',
              antennaId: 'DIGI SPAIN TELECOM, S.L.U. - 2809100',
              codigoBanda: '',
              frecuencia: '',
              ubicacion: 'MADRID',
              prov: 'MADRID',
              scannedAt: '2026-11-16T18:06:00Z',
              fecha: '16/11/2026 19:06:00',
            },
          ],
        },
      ],
      'scan-2',
    );

    const afterScan2 = mergeLiveDeltaIntoNovedadesDataset(
      scan1Dataset,
      scan2Delta,
    );

    expect(afterScan2.total).toBe(7);
    expect(afterScan2.antenasNuevas).toBe(2);
    expect(afterScan2.frecuenciasNuevas).toBe(5);
    expect(afterScan2.novedades.map((r) => r.id)).toEqual([
      // Lote Scan 2 arriba (Antena nueva Orange + 700 + 2600 -> Frecuencia existente Movistar)
      'antena::ORA-SCAN2-4600500',
      'freq::ORA-SCAN2-4600500::700',
      'freq::ORA-SCAN2-4600500::2600',
      'freq::MOV-EXIST-2800001::900',
      // Lote Scan 1 íntegro justo debajo (con su fecha original del 15/11/2026 intacta)
      'antena::DIGI-SCAN1-2809100',
      'freq::DIGI-SCAN1-2809100::1800',
      'freq::VOD-EXIST-0800100::800',
    ]);
    expect(
      afterScan2.novedades.find((r) => r.id === 'antena::DIGI-SCAN1-2809100')
        ?.fecha,
    ).toBe('15/11/2026 19:04:00');

    // Scan 3 (17/11/2026): SOLO descubre frecuencias nuevas en antenas ya existentes (0 antenas nuevas),
    // incluyendo una nueva banda 3500 MHz sobre DIGI 2809100 (que había sido Antena nueva en Scan 1).
    // Debe situarse ARRIBA DEL TODO en el lote Scan 3 (nunca enterrada bajo antenas antiguas ni arrastrada a Scan 1).
    const scan3Delta = accumulateLiveDeltaChunks(
      [
        {
          schemaVersion: 2,
          scanId: 'scan-3',
          seq: 1,
          chunkIndex: 0,
          isTail: true,
          updatedAt: '2026-11-17T18:07:00Z',
          recordNovedades: true,
          previousScanAt: '2026-11-16T18:10:00Z',
          newAntennas: [],
          bandPatches: [],
          novedades: [
            {
              id: 'freq::DIGI-SCAN1-2809100::3500-LATER',
              tipo: 'frecuencia',
              op: 'digi',
              opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
              codigo: '2809100',
              antennaId: 'DIGI SPAIN TELECOM, S.L.U. - 2809100',
              codigoBanda: 'DG-3500-S3',
              frecuencia: '3400.00 - 3420.00 MHz',
              ubicacion: 'MADRID',
              prov: 'MADRID',
              scannedAt: '2026-11-17T18:06:30Z',
              fecha: '17/11/2026 19:06:30',
            },
          ],
        },
      ],
      'scan-3',
    );

    const afterScan3 = mergeLiveDeltaIntoNovedadesDataset(
      afterScan2,
      scan3Delta,
    );

    expect(afterScan3.total).toBe(8);
    expect(afterScan3.antenasNuevas).toBe(2);
    expect(afterScan3.frecuenciasNuevas).toBe(6);
    expect(afterScan3.novedades.map((r) => r.id)).toEqual([
      // Scan 3 arriba del todo (página 1, fila 1) aunque tenga 0 antenas nuevas
      'freq::DIGI-SCAN1-2809100::3500-LATER',
      // Debajo Scan 2
      'antena::ORA-SCAN2-4600500',
      'freq::ORA-SCAN2-4600500::700',
      'freq::ORA-SCAN2-4600500::2600',
      'freq::MOV-EXIST-2800001::900',
      // Debajo Scan 1
      'antena::DIGI-SCAN1-2809100',
      'freq::DIGI-SCAN1-2809100::1800',
      'freq::VOD-EXIST-0800100::800',
    ]);

    // Verificación SSR en NovedadesView: .is-associated-freq se acota al mismo lote de escaneo
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['novedades-dataset'], afterScan3);
    queryClient.setQueryData(['antenas-dataset'], createSampleCustomDataset());
    queryClient.setQueryData(['scan-status'], null);

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

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(RouterProvider, { router: testRouter }),
      ),
    );

    const rowMatches = Array.from(
      html.matchAll(
        /<tr\b[^>]*class="([^"]*novedades-row[^"]*)"[^>]*>([\s\S]*?)<\/tr>/g,
      ),
    );
    expect(rowMatches).toHaveLength(8);
    // Fila 0 (Scan 3, DG-3500-S3 sobre antena 2809100 creada en Scan 1): NO es .is-associated-freq en Scan 3
    expect(rowMatches[0]?.[2]).toContain('DG-3500-S3');
    expect(rowMatches[0]?.[1]).toBe('novedades-row');
    // Filas 2 y 3 (Scan 2, asociadas a Antena nueva ORA 4600500): SÍ tienen .is-associated-freq
    expect(rowMatches[2]?.[2]).toContain('OR-700');
    expect(rowMatches[2]?.[1]).toContain('is-associated-freq');
    expect(rowMatches[3]?.[2]).toContain('OR-2600');
    expect(rowMatches[3]?.[1]).toContain('is-associated-freq');
    // Fila 6 (Scan 1, asociada originalmente a Antena nueva DIGI 2809100): SÍ conserva .is-associated-freq
    expect(rowMatches[6]?.[2]).toContain('DG-1800');
    expect(rowMatches[6]?.[1]).toContain('is-associated-freq');
  });

  it('mantiene lotes separados en dos escaneos forzados el mismo día natural (forced-2 encima de forced-1)', () => {
    const forced1Dataset: NovedadesDataset = {
      updatedAt: '2026-11-16T10:15:00Z',
      scanId: 'forced-1',
      previousScanAt: '2026-11-15T18:20:00Z',
      isBaselineScan: false,
      total: 2,
      antenasNuevas: 1,
      frecuenciasNuevas: 1,
      novedades: [
        {
          id: 'antena::FORCED1-DIGI-2801111',
          tipo: 'antena',
          op: 'digi',
          opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
          codigo: '2801111',
          antennaId: 'DIGI SPAIN TELECOM, S.L.U. - 2801111',
          codigoBanda: '',
          frecuencia: '',
          ubicacion: 'MADRID',
          prov: 'MADRID',
          // Incluso sin scanId explícito en la fila base, forced-1 se sella al fusionar forced-2
          scannedAt: '2026-11-16T10:10:00Z',
          fecha: '16/11/2026 11:10:00',
        },
        {
          id: 'freq::FORCED1-MOV-2800001::800',
          tipo: 'frecuencia',
          op: 'movistar',
          opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
          codigo: '2800001',
          antennaId: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800001',
          codigoBanda: 'M-800-F1',
          frecuencia: '801.00 - 811.00 MHz',
          ubicacion: 'MADRID',
          prov: 'MADRID',
          scannedAt: '2026-11-16T10:12:00Z',
          fecha: '16/11/2026 11:12:00',
        },
      ],
    };

    // Segundo escaneo forzado el MISMO día 16/11/2026 por la tarde con solo una frecuencia nueva en antena existente
    const forced2Delta = accumulateLiveDeltaChunks(
      [
        {
          schemaVersion: 2,
          scanId: 'forced-2',
          seq: 2,
          chunkIndex: 0,
          isTail: true,
          updatedAt: '2026-11-16T15:30:00Z',
          recordNovedades: true,
          previousScanAt: '2026-11-16T10:15:00Z',
          newAntennas: [],
          bandPatches: [],
          novedades: [
            {
              id: 'freq::FORCED2-ORA-2800002::3500',
              tipo: 'frecuencia',
              op: 'orange',
              opRaw: 'ORANGE ESPAGNE, S.A.U.',
              codigo: '2800002',
              antennaId: 'ORANGE ESPAGNE, S.A.U. - 2800002',
              codigoBanda: 'OR-3500-F2',
              frecuencia: '3600.00 - 3710.00 MHz',
              ubicacion: 'ALCALÁ DE HENARES',
              prov: 'MADRID',
              scannedAt: '2026-11-16T15:28:00Z',
              fecha: '16/11/2026 16:28:00',
            },
          ],
        },
      ],
      'forced-2',
    );

    const mergedSameDay = mergeLiveDeltaIntoNovedadesDataset(
      forced1Dataset,
      forced2Delta,
    );

    expect(mergedSameDay.scanId).toBe('forced-2');
    expect(mergedSameDay.total).toBe(3);
    expect(mergedSameDay.novedades.map((n) => n.id)).toEqual([
      // forced-2 arriba del todo aunque sea frecuencia de antena existente y mismo día 16/11/2026
      'freq::FORCED2-ORA-2800002::3500',
      // forced-1 conservado debajo en su propio bloque
      'antena::FORCED1-DIGI-2801111',
      'freq::FORCED1-MOV-2800001::800',
    ]);
  });
});

describe('Tabla Novedades estrecha, etiquetas simplificadas sin punto de operadora y filtros en paralelo (Frecuencia+Fecha y CCAA+Provincia)', () => {
  it('simplifica nombres de operadora (Telefonica, Vodafone, Orange, DIGI) y filtra por Comunidad Autónoma y Provincia', () => {
    expect(getNovedadesOperatorLabel('movistar')).toBe('Telefonica');
    expect(getNovedadesOperatorLabel('vodafone')).toBe('Vodafone');
    expect(getNovedadesOperatorLabel('orange')).toBe('Orange');
    expect(getNovedadesOperatorLabel('digi')).toBe('DIGI');
    expect(getNovedadesOperatorLabel('masmovil')).toBe('MásMóvil');
    expect(getNovedadesOperatorLabel('otros', 'EUSKALTEL, S.A.')).toBe(
      'EUSKALTEL, S.A.',
    );

    expect(NOVEDADES_SPANISH_COMUNIDADES).toHaveLength(19);
    expect(getNovedadesProvincesForComunidad('all')).toHaveLength(52);
    expect(getNovedadesProvincesForComunidad('Galicia')).toEqual([
      'A CORUÑA',
      'LUGO',
      'OURENSE',
      'PONTEVEDRA',
    ]);
    expect(getNovedadesProvincesForComunidad('Comunidad Valenciana')).toEqual([
      'ALICANTE',
      'CASTELLÓN',
      'VALENCIA',
    ]);

    expect(getCanonicalSpanishProvince('LA CORUÑA')).toBe('A CORUÑA');
    expect(getCanonicalSpanishProvince('VALÈNCIA')).toBe('VALENCIA');
    expect(getCanonicalSpanishProvince('ARABA/ÁLAVA')).toBe('ÁLAVA');
    expect(getCanonicalSpanishProvince('ISLAS BALEARES')).toBe('ILLES BALEARS');

    const rows: NovedadRecord[] = [
      {
        id: 'ant:mov:1500001',
        tipo: 'antena',
        op: 'movistar',
        opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
        codigo: '1500001',
        antennaId: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 1500001',
        codigoBanda: '',
        frecuencia: '',
        ubicacion: 'SANTIAGO DE COMPOSTELA',
        prov: 'LA CORUÑA',
        scannedAt: '2026-11-17T06:10:00Z',
        fecha: '17/11/2026 07:10:00',
      },
      {
        id: 'freq:vod:3600002',
        tipo: 'frecuencia',
        op: 'vodafone',
        opRaw: 'VODAFONE ESPAÑA, S.A.U.',
        codigo: '3600002',
        antennaId: 'VODAFONE ESPAÑA, S.A.U. - 3600002',
        codigoBanda: 'PO-3500',
        frecuencia: '3710.00 - 3800.00 MHz',
        ubicacion: 'VIGO',
        prov: 'PONTEVEDRA',
        scannedAt: '2026-11-17T06:11:00Z',
        fecha: '17/11/2026 07:11:00',
      },
      {
        id: 'freq:ora:4600003',
        tipo: 'frecuencia',
        op: 'orange',
        opRaw: 'ORANGE ESPAGNE, S.A.U.',
        codigo: '4600003',
        antennaId: 'ORANGE ESPAGNE, S.A.U. - 4600003',
        codigoBanda: 'V-700',
        frecuencia: '758.00 - 768.00 MHz',
        ubicacion: 'GANDIA',
        prov: 'VALÈNCIA',
        scannedAt: '2026-11-16T17:10:00Z',
        fecha: '16/11/2026 18:10:00',
      },
      {
        id: 'ant:digi:2800004',
        tipo: 'antena',
        op: 'digi',
        opRaw: 'DS MOBILE NETWORKS, S.L.',
        codigo: '2800004',
        antennaId: 'DS MOBILE NETWORKS, S.L. - 2800004',
        codigoBanda: '',
        frecuencia: '',
        ubicacion: 'GETAFE',
        prov: 'MADRID',
        scannedAt: '2026-11-16T17:12:00Z',
        fecha: '16/11/2026 18:12:00',
      },
    ];

    expect(resolveNovedadProvince(rows[0])).toBe('A CORUÑA');
    expect(resolveNovedadComunidad(rows[0])).toBe('Galicia');
    expect(resolveNovedadProvince(rows[2])).toBe('VALENCIA');
    expect(resolveNovedadComunidad(rows[2])).toBe('Comunidad Valenciana');

    // Filtro por Comunidad Autónoma
    expect(
      filterNovedades({
        novedades: rows,
        tipoFilter: 'all',
        operatorFilter: 'all',
        comunidadFilter: 'Galicia',
        searchQuery: '',
      }).map((r) => r.codigo),
    ).toEqual(['1500001', '3600002']);

    // Filtro combinado Comunidad Autónoma + Provincia (normalizando LA CORUÑA -> A CORUÑA)
    expect(
      filterNovedades({
        novedades: rows,
        tipoFilter: 'all',
        operatorFilter: 'all',
        comunidadFilter: 'Galicia',
        provinceFilter: 'A CORUÑA',
        searchQuery: '',
      }).map((r) => r.codigo),
    ).toEqual(['1500001']);

    // Filtro directo por provincia canónica sobre variante cooficial VALÈNCIA
    expect(
      filterNovedades({
        novedades: rows,
        tipoFilter: 'all',
        operatorFilter: 'all',
        provinceFilter: 'VALENCIA',
        searchQuery: '',
      }).map((r) => r.codigo),
    ).toEqual(['4600003']);

    // Búsqueda libre por "telefonica" o por nombre de Comunidad Autónoma ("galicia")
    expect(
      filterNovedades({
        novedades: rows,
        tipoFilter: 'all',
        operatorFilter: 'all',
        searchQuery: 'telefonica galicia',
      }).map((r) => r.codigo),
    ).toEqual(['1500001']);
  });

  it('renderiza en SSR etiquetas "Antena"/"Frecuencia" sin "nueva", operadoras "Telefonica"/"Vodafone"/"Orange"/"DIGI" sin icono circular, columna Código 20% más estrecha y filtros en paralelo', async () => {
    const dataset: NovedadesDataset = {
      updatedAt: '2026-11-17T06:20:00Z',
      scanId: 'scan-compact-ui',
      previousScanAt: '2026-11-16T18:00:00Z',
      isBaselineScan: false,
      total: 4,
      antenasNuevas: 2,
      frecuenciasNuevas: 2,
      novedades: [
        {
          id: 'ant:mov:2800001',
          tipo: 'antena',
          op: 'movistar',
          opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
          codigo: '2800001',
          antennaId: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800001',
          codigoBanda: '',
          frecuencia: '',
          ubicacion: 'MADRID',
          prov: 'MADRID',
          scannedAt: '2026-11-17T06:18:00Z',
          fecha: '17/11/2026 07:18:00',
        },
        {
          id: 'freq:vod:0800002',
          tipo: 'frecuencia',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          codigo: '0800002',
          antennaId: 'VODAFONE ESPAÑA, S.A.U. - 0800002',
          codigoBanda: 'B-3500',
          frecuencia: '3710.00 - 3800.00 MHz',
          ubicacion: 'BARCELONA',
          prov: 'BARCELONA',
          scannedAt: '2026-11-17T06:17:00Z',
          fecha: '17/11/2026 07:17:00',
        },
        {
          id: 'freq:ora:4600003',
          tipo: 'frecuencia',
          op: 'orange',
          opRaw: 'ORANGE ESPAGNE, S.A.U.',
          codigo: 'GALR0453B',
          antennaId: 'ORANGE ESPAGNE, S.A.U. - GALR0453B',
          codigoBanda: 'V-700',
          frecuencia: '758.00 - 768.00 MHz',
          ubicacion: 'VALENCIA',
          prov: 'VALENCIA',
          scannedAt: '2026-11-17T06:16:00Z',
          fecha: '17/11/2026 07:16:00',
        },
        {
          id: 'ant:digi:4100004',
          tipo: 'antena',
          op: 'digi',
          opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
          codigo: '4100004',
          antennaId: 'DIGI SPAIN TELECOM, S.L.U. - 4100004',
          codigoBanda: '',
          frecuencia: '',
          ubicacion: 'SEVILLA',
          prov: 'SEVILLA',
          scannedAt: '2026-11-17T06:15:00Z',
          fecha: '17/11/2026 07:15:00',
        },
      ],
    };

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['novedades-dataset'], dataset);
    queryClient.setQueryData(['antenas-dataset'], createSampleCustomDataset());
    queryClient.setQueryData(['scan-status'], null);

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

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(RouterProvider, { router: testRouter }),
      ),
    );

    // 1. Sin desplegable de operadora ni desplegable antiguo de ubicación única
    expect(html).not.toContain('id="novedades-operator-filter"');
    expect(html).not.toContain('id="novedades-location-filter"');
    // Se conserva la selección superior de operadora
    expect(html).toContain('class="novedades-operator-chips"');

    // 2. Dos pares en paralelo (.novedades-filter-pair): [Frecuencia + Fecha] y [Comunidad Autónoma + Provincia]
    expect(html.match(/class="novedades-filter-pair"/g)).toHaveLength(2);
    const freqDatePairMatch = html.match(
      /<div[^>]*class="novedades-filter-pair"[^>]*aria-label="Filtros de frecuencia y fecha"[^>]*>([\s\S]*?)<div[^>]*class="novedades-filter-pair"/,
    );
    expect(freqDatePairMatch).not.toBeNull();
    expect(freqDatePairMatch?.[1]).toContain('id="novedades-band-filter"');
    expect(freqDatePairMatch?.[1]).toContain('id="novedades-date-filter"');

    const ccaaProvPairMatch = html.match(
      /<div[^>]*class="novedades-filter-pair"[^>]*aria-label="Filtros de ubicación por comunidad autónoma y provincia"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/,
    );
    expect(ccaaProvPairMatch).not.toBeNull();
    expect(ccaaProvPairMatch?.[1]).toContain('id="novedades-ccaa-filter"');
    expect(ccaaProvPairMatch?.[1]).toContain('id="novedades-province-filter"');

    // 3. Dentro de #novedades-table: "Antena" / "Frecuencia" sin "nueva", "Telefonica"/"Vodafone"/"Orange"/"DIGI" y cero iconos circulares (.operator-dot)
    const tableMatch = html.match(
      /<table[^>]*id="novedades-table"[^>]*>([\s\S]*?)<\/table>/,
    );
    expect(tableMatch).not.toBeNull();
    const tableHtml = tableMatch?.[1] ?? '';
    expect(tableHtml).toContain('<span>Antena</span>');
    expect(tableHtml).toContain('<span>Frecuencia</span>');
    expect(tableHtml).not.toContain('Antena nueva');
    expect(tableHtml).not.toContain('Frecuencia nueva');
    expect(tableHtml).not.toContain('operator-dot');
    expect(tableHtml).toContain(
      '<span class="novedades-operator-name">Telefonica</span>',
    );
    expect(tableHtml).toContain(
      '<span class="novedades-operator-name">Vodafone</span>',
    );
    expect(tableHtml).toContain(
      '<span class="novedades-operator-name">Orange</span>',
    );
    expect(tableHtml).toContain(
      '<span class="novedades-operator-name">DIGI</span>',
    );
    expect(tableHtml).not.toContain('novedades-col-codigo');
    expect(tableHtml).toContain('class="novedades-col-novedad"');

    // 4. Verificación CSS: contenedor y tabla compactos, columna Código devuelta a su tamaño original, columna Novedad estrechada y pares 50%/50%
    const fsSpecifier = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFileSync: (path: URL, encoding: string) => string;
    };
    const indexCssSource = readFileSync(
      new URL('../styles/index.css', import.meta.url),
      'utf-8',
    );
    expect(indexCssSource).toMatch(
      /\.page-container\.novedades-page\s*\{[^}]*max-width:\s*1020px;/,
    );
    expect(indexCssSource).toMatch(
      /\.novedades-table\s*\{[^}]*min-width:\s*460px;/,
    );
    expect(indexCssSource).not.toContain('novedades-col-codigo');
    expect(indexCssSource).toMatch(
      /\.novedades-code-link\s*\{[^}]*padding:\s*2px 6px;[^}]*font-size:\s*11\.5px;/,
    );
    expect(indexCssSource).toMatch(
      /\.novedades-table td\.novedades-col-novedad\s*\{[^}]*width:\s*74px;[^}]*max-width:\s*82px;/,
    );
    expect(indexCssSource).toMatch(
      /\.novedades-filter-pair\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/,
    );
  });
});

describe('Novedades — Contadores del último escaneo, encabezado simplificado, 2 bloques de filtro en paralelo, badge Frecuencia sin icono y tabla móvil a ancho completo', () => {
  it('computeLatestScanNovedadesCounts e isLatestScanNovedad cuentan únicamente las novedades del último escaneo realizado y nunca el acumulado histórico', () => {
    const emptyLatestScanDataset: NovedadesDataset = {
      updatedAt: '2026-11-17T07:53:33Z',
      previousScanAt: '2026-11-17T06:06:16Z',
      scanId: '44039933369',
      isBaselineScan: false,
      total: 3,
      antenasNuevas: 1,
      frecuenciasNuevas: 2,
      novedades: [
        {
          id: 'ant:digi:2809991',
          tipo: 'antena',
          op: 'digi',
          opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
          codigo: '2809991',
          antennaId: 'DIGI SPAIN TELECOM, S.L.U. - 2809991',
          codigoBanda: '',
          frecuencia: '',
          ubicacion: 'ALCALÁ DE HENARES',
          prov: 'MADRID',
          scannedAt: '2026-11-17T06:06:16Z',
          fecha: '17/11/2026 07:06:16',
          scanId: '43978102518',
        },
        {
          id: 'freq:mov:2800001:3500',
          tipo: 'frecuencia',
          op: 'movistar',
          opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
          codigo: '2800001',
          antennaId: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800001',
          codigoBanda: 'M M -2205199',
          frecuencia: '3460.00 - 3600.00 MHz',
          ubicacion: 'MADRID',
          prov: 'MADRID',
          scannedAt: '2026-11-17T06:06:16Z',
          fecha: '17/11/2026 07:06:16',
          scanId: '43978102518',
        },
        {
          id: 'freq:vod:0800002:3500',
          tipo: 'frecuencia',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          codigo: '0800002',
          antennaId: 'VODAFONE ESPAÑA, S.A.U. - 0800002',
          codigoBanda: 'B-3500',
          frecuencia: '3710.00 - 3800.00 MHz',
          ubicacion: 'BARCELONA',
          prov: 'BARCELONA',
          scannedAt: '2026-11-17T06:06:16Z',
          fecha: '17/11/2026 07:06:16',
          scanId: '43978102518',
        },
      ],
    };

    expect(
      isLatestScanNovedad(
        emptyLatestScanDataset.novedades[0]!,
        emptyLatestScanDataset,
      ),
    ).toBe(false);
    expect(computeLatestScanNovedadesCounts(emptyLatestScanDataset)).toEqual({
      total: 0,
      antena: 0,
      frecuencia: 0,
      byOp: {
        movistar: 0,
        orange: 0,
        vodafone: 0,
        masmovil: 0,
        digi: 0,
        otros: 0,
      },
    });

    const mixedScanDataset: NovedadesDataset = {
      ...emptyLatestScanDataset,
      updatedAt: '2026-11-17T18:05:00Z',
      previousScanAt: '2026-11-17T07:53:33Z',
      scanId: 'scan-latest-99',
      total: 5,
      antenasNuevas: 2,
      frecuenciasNuevas: 3,
      novedades: [
        {
          id: 'ant:ora:4609001',
          tipo: 'antena',
          op: 'orange',
          opRaw: 'ORANGE ESPAGNE, S.A.U.',
          codigo: '4609001',
          antennaId: 'ORANGE ESPAGNE, S.A.U. - 4609001',
          codigoBanda: '',
          frecuencia: '',
          ubicacion: 'VALENCIA',
          prov: 'VALENCIA',
          scannedAt: '2026-11-17T18:04:00Z',
          fecha: '17/11/2026 19:04:00',
          scanId: 'scan-latest-99',
        },
        {
          id: 'freq:ora:4609001:700',
          tipo: 'frecuencia',
          op: 'orange',
          opRaw: 'ORANGE ESPAGNE, S.A.U.',
          codigo: '4609001',
          antennaId: 'ORANGE ESPAGNE, S.A.U. - 4609001',
          codigoBanda: 'V-700',
          frecuencia: '758.00 - 768.00 MHz',
          ubicacion: 'VALENCIA',
          prov: 'VALENCIA',
          scannedAt: '2026-11-17T18:04:00Z',
          fecha: '17/11/2026 19:04:00',
          scanId: 'scan-latest-99',
        },
        ...emptyLatestScanDataset.novedades,
      ],
    };

    expect(
      isLatestScanNovedad(mixedScanDataset.novedades[0]!, mixedScanDataset),
    ).toBe(true);
    expect(
      isLatestScanNovedad(mixedScanDataset.novedades[2]!, mixedScanDataset),
    ).toBe(false);
    expect(computeLatestScanNovedadesCounts(mixedScanDataset)).toEqual({
      total: 2,
      antena: 1,
      frecuencia: 1,
      byOp: {
        movistar: 0,
        orange: 2,
        vodafone: 0,
        masmovil: 0,
        digi: 0,
        otros: 0,
      },
    });
  });

  it('renderiza encabezado solo con "Novedades", métricas sin frases descriptivas, 2 bloques paralelos de tipo, contadores solo del último escaneo, badge Frecuencia sin icono y tabla móvil sin bordes laterales', async () => {
    const dataset: NovedadesDataset = {
      updatedAt: '2026-11-17T18:05:00Z',
      previousScanAt: '2026-11-17T07:53:33Z',
      scanId: 'scan-latest-99',
      isBaselineScan: false,
      total: 4,
      antenasNuevas: 2,
      frecuenciasNuevas: 2,
      novedades: [
        {
          id: 'ant:ora:4609001',
          tipo: 'antena',
          op: 'orange',
          opRaw: 'ORANGE ESPAGNE, S.A.U.',
          codigo: '4609001',
          antennaId: 'ORANGE ESPAGNE, S.A.U. - 4609001',
          codigoBanda: '',
          frecuencia: '',
          ubicacion: 'VALENCIA',
          prov: 'VALENCIA',
          scannedAt: '2026-11-17T18:04:00Z',
          fecha: '17/11/2026 19:04:00',
          scanId: 'scan-latest-99',
        },
        {
          id: 'freq:mov:2800001:3500',
          tipo: 'frecuencia',
          op: 'movistar',
          opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
          codigo: '2800001',
          antennaId: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800001',
          codigoBanda: 'M M -2205199',
          frecuencia: '3460.00 - 3600.00 MHz',
          ubicacion: 'MADRID',
          prov: 'MADRID',
          scannedAt: '2026-11-17T18:04:00Z',
          fecha: '17/11/2026 19:04:00',
          scanId: 'scan-latest-99',
        },
        // Filas históricas de un escaneo anterior (permanecen en la tabla pero NO suman a los contadores)
        {
          id: 'ant:digi:2809991',
          tipo: 'antena',
          op: 'digi',
          opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
          codigo: '2809991',
          antennaId: 'DIGI SPAIN TELECOM, S.L.U. - 2809991',
          codigoBanda: '',
          frecuencia: '',
          ubicacion: 'ALCALÁ DE HENARES',
          prov: 'MADRID',
          scannedAt: '2026-11-17T06:06:16Z',
          fecha: '17/11/2026 07:06:16',
          scanId: 'scan-older-01',
        },
        {
          id: 'freq:vod:0800002:3500',
          tipo: 'frecuencia',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          codigo: '0800002',
          antennaId: 'VODAFONE ESPAÑA, S.A.U. - 0800002',
          codigoBanda: 'B-3500',
          frecuencia: '3710.00 - 3800.00 MHz',
          ubicacion: 'BARCELONA',
          prov: 'BARCELONA',
          scannedAt: '2026-11-17T06:06:16Z',
          fecha: '17/11/2026 07:06:16',
          scanId: 'scan-older-01',
        },
      ],
    };

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['novedades-dataset'], dataset);
    queryClient.setQueryData(['antenas-dataset'], createSampleCustomDataset());
    queryClient.setQueryData(['scan-status'], null);

    const testRoot = createRootRoute({
      component: () =>
        createElement(
          WorkspaceProvider,
          null,
          createElement(AppHeader),
          createElement(Outlet),
        ),
    });
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

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(RouterProvider, { router: testRouter }),
      ),
    );

    // 1. Encabezado superior: únicamente <h1 class="page-h1">Novedades</h1> sin .page-eyebrow ni .page-lead
    const heroMatch = html.match(
      /<header[^>]*class="page-hero novedades-hero"[^>]*>([\s\S]*?)<\/header>/,
    );
    expect(heroMatch).not.toBeNull();
    expect(heroMatch?.[1]?.trim()).toBe('<h1 class="page-h1">Novedades</h1>');
    expect(html).not.toContain('page-eyebrow');
    expect(html).not.toContain('page-lead');

    // 2. Zona de escaneo: contadores del último escaneo (1 antena nueva, 1 frecuencia nueva, no 2 y 2 acumulados) y sin frases descriptivas debajo
    expect(html).not.toContain('Nuevos emplazamientos incorporados al censo');
    expect(html).not.toContain(
      'Nuevas concesiones de banda asignadas en MINETUR',
    );
    expect(html).toContain(
      '<div class="metric-cell"><span class="metric-label">Antenas nuevas</span><span class="metric-value">1</span></div>',
    );
    expect(html).toContain(
      '<div class="metric-cell"><span class="metric-label">Frecuencias nuevas</span><span class="metric-value">1</span></div>',
    );

    // 3. Dos bloques en paralelo ("Antenas Nuevas" y "Frecuencias Nuevas") sin bloque "Todas" y contando solo el último escaneo
    expect(html).not.toContain('id="novedades-filter-all"');
    const typePillsMatch = html.match(
      /<div[^>]*class="novedades-type-pills"[^>]*>([\s\S]*?)<\/div>/,
    );
    expect(typePillsMatch).not.toBeNull();
    expect(typePillsMatch?.[1]).toContain('id="novedades-filter-antenas"');
    expect(typePillsMatch?.[1]).toContain('<span>Antenas Nuevas</span>');
    expect(typePillsMatch?.[1]).toContain('id="novedades-filter-frecuencias"');
    expect(typePillsMatch?.[1]).toContain('<span>Frecuencias Nuevas</span>');
    expect(
      typePillsMatch?.[1]?.match(/class="novedades-filter-pill"/g),
    ).toHaveLength(2);
    expect(typePillsMatch?.[1]?.match(/>1<\/span>/g)).toHaveLength(2);

    // Chips de operadora y badge del menú lateral cuentan solo el último escaneo (total = 2, DIGI histórico = 0 sin contador)
    const digiChipMatch = html.match(
      /<button[^>]*id="novedades-op-chip-digi"[^>]*>([\s\S]*?)<\/button>/,
    );
    expect(digiChipMatch?.[1]).not.toContain('novedades-pill-count');
    const navBadgeMatch = html.match(
      /<a[^>]*id="nav-tab-novedades"[^>]*>([\s\S]*?)<\/a>/,
    );
    expect(navBadgeMatch?.[1]).toMatch(
      /<span class="nav-tab-badge mono"[^>]*>2<\/span>/,
    );

    // 4. La tabla mantiene las 4 filas permanentes pero los badges de "Frecuencia" NO tienen icono de ondas (<svg)
    const freqBadges = Array.from(
      html.matchAll(
        /<span class="novedades-badge is-frecuencia">([\s\S]*?)<\/span>\s*<span class="novedades-operator-tag"/g,
      ),
      (m) => m[1],
    );
    expect(freqBadges).toHaveLength(2);
    for (const badgeInner of freqBadges) {
      expect(badgeInner).not.toContain('<svg');
      expect(badgeInner).toContain('<span>Frecuencia</span>');
    }
    const antBadges = Array.from(
      html.matchAll(
        /<span class="novedades-badge is-antena">([\s\S]*?)<\/span>\s*<span class="novedades-operator-tag"/g,
      ),
      (m) => m[1],
    );
    expect(antBadges).toHaveLength(2);
    for (const badgeInner of antBadges) {
      expect(badgeInner).toContain('<svg');
      expect(badgeInner).toContain('<span>Antena</span>');
    }

    // 5. CSS: 2 bloques en paralelo y tabla móvil a todo el ancho sin bordes laterales
    const fsSpecifier = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFileSync: (path: URL, encoding: string) => string;
    };
    const indexCssSource = readFileSync(
      new URL('../styles/index.css', import.meta.url),
      'utf-8',
    );
    expect(indexCssSource).toMatch(
      /\.novedades-type-pills\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/,
    );
    expect(indexCssSource).toMatch(
      /@media\s*\(max-width:\s*860px\)\s*\{[\s\S]*?\.novedades-table-section\s*\{[^}]*margin-left:\s*-14px;[^}]*margin-right:\s*-14px;[^}]*width:\s*calc\(100%\s*\+\s*28px\);[^}]*border-left:\s*none;[^}]*border-right:\s*none;[^}]*border-radius:\s*0;/,
    );
  });
});
