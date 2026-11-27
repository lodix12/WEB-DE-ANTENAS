import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppHeader } from '../components/ui/AppHeader';
import { FilterPanel } from '../components/ui/FilterPanel';
import { StationDetailDrawer } from '../components/ui/StationDetailDrawer';
import { MapOverlays } from '../components/map/MapOverlays';
import {
  UNICO_PROJECT_ICON_ANCHOR,
  UNICO_PROJECT_ICON_OFFSET,
  buildUnicoProjectsGeoJson,
  buildUnicoProjectsPopupHtml,
} from '../utils/unicoProjectsMap';
import {
  OPERATOR_ORDER,
  type AntenasDataset,
  type AntennaRecord,
  type LiveBandPatch,
} from '../types/antena';
import {
  UNICO_DECLARED_BAND_TABS,
  UNICO_OPERATOR_ORDER,
  type UnicoAntennaRecord,
  type UnicoDataset,
} from '../types/unico5g';
import { MapaView } from '../views/MapaView';
import { Unico5gView } from '../views/Unico5gView';
import { WorkspaceProvider } from './WorkspaceProvider';
import {
  buildDerivedAntenasStructures,
  mergeLiveDeltaIntoAntenasDataset,
  parseCustomAntenasJson,
} from './useAntenasData';
import type { LiveScanMergedDelta } from './useScanProgress';
import {
  UNICO_5G_QUERY_KEY,
  UNICO_BIT_N28,
  UNICO_BIT_N28_PLUS,
  UNICO_BIT_N78,
  UNICO_COMUNIDAD_LIST,
  UNICO_DECLARED_ANY_MASK,
  UNICO_MAX_MATCH_DISTANCE_KM,
  UNICO_PREFERRED_BAND_MASK,
  UNICO_PROVINCE_LABELS,
  bandFilterToMask,
  computeUnicoSimpleSummary,
  formatUnicoDeclaredBitsList,
  formatUnicoDistance,
  formatUnicoFasesLabel,
  formatUnicoInt,
  formatUnicoPercent,
  isUnicoOperatorKey,
  matchUnicoDeclaredAntennas,
  matchUnicoDeclaredAntennasMasks,
  normalizeUnicoOperatorInput,
  parseCustomUnico5gJson,
  selectEffectiveUnicoDeclaredMasks,
  validateUnico5gSearch,
} from './useUnico5gData';

async function readDiskTextFile(relativeUrlPath: string): Promise<string> {
  const fsSpecifier = 'node:fs';
  const { readFileSync } = (await import(/* @vite-ignore */ fsSpecifier)) as {
    readFileSync: (path: URL, encoding: string) => string;
  };
  return readFileSync(new URL(relativeUrlPath, import.meta.url), 'utf-8');
}

async function readDiskJsonFile(relativeUrlPath: string): Promise<unknown> {
  return JSON.parse(await readDiskTextFile(relativeUrlPath)) as unknown;
}

let cachedUnicoDataset: UnicoDataset | null = null;

async function loadRealUnicoDatasetFromDisk(): Promise<UnicoDataset> {
  if (!cachedUnicoDataset) {
    const raw = await readDiskJsonFile('../../public/data/unico-5g.json');
    cachedUnicoDataset = parseCustomUnico5gJson(raw);
  }
  return cachedUnicoDataset;
}

let cachedAntenasDataset: AntenasDataset | null = null;

async function loadRealAntenasDatasetFromDisk(): Promise<AntenasDataset> {
  if (!cachedAntenasDataset) {
    const raw = await readDiskJsonFile('../../public/data/antenas.json');
    cachedAntenasDataset = parseCustomAntenasJson(raw);
  }
  return cachedAntenasDataset;
}

function makeUnicoAntenna(
  overrides: Partial<UnicoAntennaRecord> & Pick<UnicoAntennaRecord, 'id'>,
): UnicoAntennaRecord {
  return {
    fase: 1,
    op: 'movistar',
    empresa: 'TELEFÓNICA MÓVILES ESPAÑA, S.A.',
    ccaa: 'Comunidad de Madrid',
    prov: 'MADRID',
    mun: 'Madrid',
    lat: 40.4168,
    lon: -3.7038,
    ...overrides,
  };
}

function makeRealAntenna(
  overrides: Partial<AntennaRecord> & Pick<AntennaRecord, 'id' | 'gid'>,
): AntennaRecord {
  return {
    op: 'movistar',
    opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
    lat: 40.4168,
    lon: -3.7038,
    dir: 'CL PRUEBA 1',
    mun: 'MADRID',
    prov: 'MADRID',
    ...overrides,
  };
}

function makeSyntheticAntenasDataset(
  antenas: AntennaRecord[],
  updatedAt = '2026-11-24T17:00:00Z',
): AntenasDataset {
  return {
    updatedAt,
    sourceUrl: 'https://geoportal.minetur.gob.es/VCTEL/vcne.do',
    total: antenas.length,
    crawlStats: {
      requestsCount: 1,
      durationSeconds: 1,
      gridBoxesVisited: 1,
      subdividedBoxes: 0,
      zoomParam: 7,
      delaySeconds: 0.02,
      bandsPopulatedCount: antenas.filter((a) => Array.isArray(a.bandas))
        .length,
    },
    operators: {
      movistar: {
        key: 'movistar',
        name: 'Movistar (Telefónica)',
        count: antenas.filter((a) => a.op === 'movistar').length,
        legalEntities: ['TELEFONICA MOVILES ESPAÑA, S.A.U.'],
      },
      orange: {
        key: 'orange',
        name: 'Orange (MasOrange)',
        count: antenas.filter((a) => a.op === 'orange').length,
        legalEntities: ['ORANGE ESPAGNE, S.A.U.'],
      },
      vodafone: {
        key: 'vodafone',
        name: 'Vodafone España',
        count: antenas.filter((a) => a.op === 'vodafone').length,
        legalEntities: ['VODAFONE ESPAÑA, S.A.U.'],
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
    provinces: [],
    antenas,
  };
}

function makeLiveDelta(
  overrides: Partial<LiveScanMergedDelta> = {},
): LiveScanMergedDelta {
  return {
    scanId: 'scan-unico-live-1',
    deltaSeq: 1,
    recordNovedades: true,
    previousScanAt: '2026-11-24T16:00:00Z',
    updatedAt: '2026-11-24T17:15:00Z',
    completedDatasetUpdatedAt: '',
    newAntennas: [],
    bandPatchesById: new Map<string, LiveBandPatch>(),
    bandPatchesByGid: new Map<string, LiveBandPatch>(),
    novedades: [],
    removedAntennaIds: new Set<string>(),
    eliminaciones: [],
    ...overrides,
  };
}

describe('UNICO 5G — Agrupación unificada Orange+Avatel, cruce espacial a 1.200 m (N28/N28+/N78) y vista simplificada sin tablas ni rankings', () => {
  it('valida public/data/unico-5g.json (7.330 Fase 1 + 1.961 Fase 2 = 9.291), unifica Orange + UTE Orange + Avatel en Orange (2.832) y garantiza cero códigos excluidos', async () => {
    const dataset = await loadRealUnicoDatasetFromDisk();

    expect(dataset.fase1Total).toBe(7330);
    expect(dataset.fase2Total).toBe(1961);
    expect(dataset.total).toBe(9291);
    expect(dataset.antenas.length).toBe(9291);

    // Orden fijo de 3 operadoras sin Avatel separado ni rankings
    expect(UNICO_OPERATOR_ORDER).toEqual(['movistar', 'orange', 'vodafone']);
    expect(isUnicoOperatorKey('orange')).toBe(true);
    expect(isUnicoOperatorKey('avatel')).toBe(false);
    expect('avatel' in dataset.operators).toBe(false);

    // Todas las adjudicaciones de Avatel, Orange Espagne y UTE Orange se agrupan en 'orange'
    expect(normalizeUnicoOperatorInput('AVATEL TELECOM S.A.')).toBe('orange');
    expect(normalizeUnicoOperatorInput('ORANGE ESPAGNE S.A.')).toBe('orange');
    expect(
      normalizeUnicoOperatorInput(
        'UTE ORANGE ESPAGNE Y ORANGE COMUNICACIONES FIJAS',
      ),
    ).toBe('orange');
    expect(
      normalizeUnicoOperatorInput('TELEFÓNICA MÓVILES ESPAÑA, S.A.'),
    ).toBe('movistar');
    expect(normalizeUnicoOperatorInput('VODAFONE ESPAÑA S.A.')).toBe(
      'vodafone',
    );

    expect(dataset.operators.movistar.total).toBe(5239);
    expect(dataset.operators.movistar.fase1).toBe(4123);
    expect(dataset.operators.movistar.fase2).toBe(1116);

    expect(dataset.operators.orange.label).toBe('Orange');
    expect(dataset.operators.orange.total).toBe(2832);
    expect(dataset.operators.orange.fase1).toBe(1987); // 1.505 Orange Espagne + 482 Avatel
    expect(dataset.operators.orange.fase2).toBe(845); // 400 Orange Espagne + 445 UTE Orange

    expect(dataset.operators.vodafone.total).toBe(1220);
    expect(dataset.operators.vodafone.fase1).toBe(1220);
    expect(dataset.operators.vodafone.fase2).toBe(0);

    const orangeEntityNames = dataset.operators.orange.entities.map(
      (e) => e.empresa,
    );
    expect(orangeEntityNames).toContain('AVATEL TELECOM S.A.');
    expect(orangeEntityNames).toContain('ORANGE ESPAGNE S.A.');
    expect(orangeEntityNames).toContain(
      'UTE ORANGE ESPAGNE Y ORANGE COMUNICACIONES FIJAS',
    );

    // Verificar fila por fila: cero op === 'avatel' y cero campos de código de emplazamiento / ID de propietario
    let avatelEmpresaRows = 0;
    let uteOrangeRows = 0;
    for (let i = 0; i < dataset.antenas.length; i++) {
      const rec = dataset.antenas[i];
      const rawRec = rec as unknown as Record<string, unknown>;
      expect(rawRec.op).not.toBe('avatel');
      expect('emplazamiento' in rawRec).toBe(false);
      expect('codigoEmplazamiento' in rawRec).toBe(false);
      expect('idPropietario' in rawRec).toBe(false);
      expect(rec.id).not.toMatch(/0000000-\d+/);

      if (rec.empresa === 'AVATEL TELECOM S.A.') {
        expect(rec.op).toBe('orange');
        avatelEmpresaRows++;
      }
      if (rec.empresa === 'UTE ORANGE ESPAGNE Y ORANGE COMUNICACIONES FIJAS') {
        expect(rec.op).toBe('orange');
        uteOrangeRows++;
      }
    }
    expect(avatelEmpresaRows).toBe(482);
    expect(uteOrangeRows).toBe(445);

    // Catálogos territoriales y pestañas de bandas declaradas
    expect(UNICO_PROVINCE_LABELS.length).toBe(50);
    expect(UNICO_COMUNIDAD_LIST.length).toBe(17);
    expect(UNICO_DECLARED_BAND_TABS.map((t) => t.label)).toEqual([
      'Todo',
      'N78',
      'N28',
      'N28+',
    ]);

    // Conversión defensiva de registros heredados op: 'avatel' y rechazo de GeoJSON / campos prohibidos
    const convertedLegacy = parseCustomUnico5gJson({
      schemaVersion: 1,
      antenas: [
        {
          id: 'legacy-avatel-1',
          fase: 1,
          op: 'avatel',
          empresa: 'AVATEL TELECOM S.A.',
          ccaa: 'Andalucía',
          prov: 'ALMERÍA',
          mun: 'Albanchez',
          lat: 37.295783,
          lon: -2.176656,
        },
      ],
    });
    expect(convertedLegacy.antenas[0].op).toBe('orange');
    expect(convertedLegacy.operators.orange.total).toBe(1);

    expect(() =>
      parseCustomUnico5gJson({ type: 'FeatureCollection', features: [] }),
    ).toThrow(/GeoJSON/i);
    expect(() =>
      parseCustomUnico5gJson({
        ...dataset,
        antenas: [
          {
            ...dataset.antenas[0],
            codigoEmplazamiento: '01_01055_000168',
          },
        ],
      }),
    ).toThrow(/prohibidos/i);
    expect(() =>
      parseCustomUnico5gJson({
        ...dataset,
        antenas: [
          {
            ...dataset.antenas[0],
            idPropietario: '0000000-001',
          },
        ],
      }),
    ).toThrow(/prohibidos/i);
  });

  it('cruza la antena real válida más cercana de la misma operadora <= 1.200 m con bandas N28 / N28+ / N78 (saltando no válidas de más cercano a lejano) y filtra por banda, fase, provincia y comunidad', () => {
    expect(UNICO_MAX_MATCH_DISTANCE_KM).toBe(1.2);
    expect(UNICO_PREFERRED_BAND_MASK).toBe(UNICO_BIT_N78 | UNICO_BIT_N28_PLUS);
    expect(bandFilterToMask('all')).toBe(UNICO_DECLARED_ANY_MASK);
    expect(bandFilterToMask('N78')).toBe(UNICO_BIT_N78);
    expect(bandFilterToMask('N28')).toBe(UNICO_BIT_N28);
    expect(bandFilterToMask('N28+')).toBe(UNICO_BIT_N28_PLUS);

    // Coordenadas base bien separadas entre sí (> 50 km) para aislar cada caso espacial
    const unicoAntenas: UnicoAntennaRecord[] = [
      // Caso 1a: Movistar con estación real a ~500 m (lat + 0.0045) con N78 (3600-3700 MHz) -> DECLARADA (N78)
      makeUnicoAntenna({
        id: 'u-case1-n78',
        fase: 1,
        op: 'movistar',
        ccaa: 'Comunidad de Madrid',
        prov: 'MADRID',
        mun: 'Sierra Norte',
        lat: 40.0,
        lon: -3.5,
      }),
      // Caso 1b: Orange con estación real a ~500 m (lat + 0.0045) con N28 (758-768 MHz) -> DECLARADA (N28)
      makeUnicoAntenna({
        id: 'u-case1-n28',
        fase: 2,
        op: 'orange',
        empresa: 'ORANGE ESPAGNE S.A.',
        ccaa: 'Andalucía',
        prov: 'SEVILLA',
        mun: 'Cazalla',
        lat: 37.5,
        lon: -5.8,
      }),
      // Caso 1c: Vodafone con estación real a ~500 m (lat + 0.0045) con N28+ (758-788 MHz) -> DECLARADA (N28+)
      makeUnicoAntenna({
        id: 'u-case1-n28plus',
        fase: 1,
        op: 'vodafone',
        empresa: 'VODAFONE ESPAÑA S.A.',
        ccaa: 'Galicia',
        prov: 'LUGO',
        mun: 'Vilalba',
        lat: 43.3,
        lon: -7.6,
      }),
      // Caso 2: Fuera del radio de 1.200 m (~1.279 m -> lat + 0.0115) aunque tenga N78 + N28 -> NO declarada (mask === 0)
      makeUnicoAntenna({
        id: 'u-case2-out-of-range',
        fase: 1,
        op: 'movistar',
        ccaa: 'Aragón',
        prov: 'TERUEL',
        mun: 'Albarracín',
        lat: 40.4,
        lon: -1.4,
      }),
      // Caso 3: Las estaciones reales más cercanas de la misma operadora (~150 m solo 4G y ~400 m solo B7/N258)
      // NO tienen bandas requeridas, pero puede dar los saltos necesarios de más cercano a lejano y alcanzar
      // la estación válida más cercana a ~1.145 m (<= 1.200 m) con N78 antes que otra válida más lejana (~1.190 m N28)
      makeUnicoAntenna({
        id: 'u-case3-jumps-over-4g',
        fase: 2,
        op: 'movistar',
        ccaa: 'Castilla y León',
        prov: 'SORIA',
        mun: 'Ágreda',
        lat: 41.85,
        lon: -1.92,
      }),
      // Caso 4: Estación real de OTRA operadora (Movistar) a ~20 m con N78 sobre coordenada de Orange -> NO declarada (mask === 0)
      makeUnicoAntenna({
        id: 'u-case4-other-op',
        fase: 2,
        op: 'orange',
        empresa: 'AVATEL TELECOM S.A.',
        ccaa: 'Andalucía',
        prov: 'ALMERÍA',
        mun: 'Sorbas',
        lat: 37.1,
        lon: -2.1,
      }),
    ];

    const realAntenas: AntennaRecord[] = [
      // Caso 1a (~500 m): Movistar N78
      makeRealAntenna({
        id: 'MV-1A',
        gid: '1001',
        op: 'movistar',
        lat: 40.0 + 0.0045,
        lon: -3.5,
        frecuencias: ['3600.00 - 3700.00'],
      }),
      // Caso 1b (~500 m): Orange N28
      makeRealAntenna({
        id: 'OR-1B',
        gid: '1002',
        op: 'orange',
        opRaw: 'ORANGE ESPAGNE, S.A.U.',
        lat: 37.5 + 0.0045,
        lon: -5.8,
        frecuencias: ['758.00 - 768.00'],
      }),
      // Caso 1c (~500 m): Vodafone N28+
      makeRealAntenna({
        id: 'VF-1C',
        gid: '1003',
        op: 'vodafone',
        opRaw: 'VODAFONE ESPAÑA, S.A.U.',
        lat: 43.3 + 0.0045,
        lon: -7.6,
        frecuencias: ['758.00 - 788.00'],
      }),
      // Caso 2 (~1.279 m > 1.200 m): Movistar con N78 y N28 fuera de rango
      makeRealAntenna({
        id: 'MV-2-FAR',
        gid: '2001',
        op: 'movistar',
        lat: 40.4 + 0.0115,
        lon: -1.4,
        frecuencias: ['758.00 - 768.00', '3600.00 - 3700.00'],
      }),
      // Caso 3a (~150 m): Movistar más cercana solo con B20 (800) + B3 (1800) -> saltada por no válida
      makeRealAntenna({
        id: 'MV-3-CLOSEST-4G',
        gid: '3001',
        op: 'movistar',
        lat: 41.85 + 0.00135,
        lon: -1.92,
        frecuencias: ['791.00 - 801.00', '1805.00 - 1825.00'],
      }),
      // Caso 3b (~400 m): Segunda Movistar solo con B7 (2600) + N258 (26 GHz) -> saltada por no válida
      makeRealAntenna({
        id: 'MV-3-SECOND-INVALID',
        gid: '3002',
        op: 'movistar',
        lat: 41.85 + 0.0036,
        lon: -1.92,
        frecuencias: ['2620.00 - 2640.00', '26.5 - 27.5 GHz'],
      }),
      // Caso 3c (~1.145 m <= 1.200 m): Tercera Movistar válida con N78 -> seleccionada (más cercana válida)
      makeRealAntenna({
        id: 'MV-3-THIRD-5G',
        gid: '3003',
        op: 'movistar',
        lat: 41.85 + 0.0103,
        lon: -1.92,
        frecuencias: ['3600.00 - 3700.00'],
      }),
      // Caso 3d (~1.190 m <= 1.200 m): Cuarta Movistar válida con N28 -> más lejana, no debe imponerse sobre MV-3-THIRD-5G
      makeRealAntenna({
        id: 'MV-3-FOURTH-5G',
        gid: '3004',
        op: 'movistar',
        lat: 41.85 + 0.0107,
        lon: -1.92,
        frecuencias: ['758.00 - 768.00'],
      }),
      // Caso 4 (~20 m): Movistar pegada a coordenada UNICO de Orange
      makeRealAntenna({
        id: 'MV-4-WRONG-OP',
        gid: '4001',
        op: 'movistar',
        lat: 37.1 + 0.00018,
        lon: -2.1,
        frecuencias: ['3600.00 - 3700.00'],
      }),
    ];

    const masks = matchUnicoDeclaredAntennasMasks(unicoAntenas, realAntenas);

    expect(masks[0]).toBe(UNICO_BIT_N78);
    expect(masks[1]).toBe(UNICO_BIT_N28);
    expect(masks[2]).toBe(UNICO_BIT_N28_PLUS);
    expect(masks[3]).toBe(0);
    expect(masks[4]).toBe(UNICO_BIT_N78);
    expect(masks[5]).toBe(0);

    // Caso 5: Filtros de banda ('all' | 'N78' | 'N28' | 'N28+'), Fase ('all' | '1' | '2'), Provincias y Comunidades
    const emptySet = new Set<string>();

    const summaryAll = computeUnicoSimpleSummary(unicoAntenas, masks, {
      fase: 'all',
      selectedProvinces: emptySet,
      selectedComunidades: emptySet,
      bandFilter: 'all',
    });
    expect(summaryAll.totalAntennas).toBe(6);
    expect(summaryAll.totalDeclared).toBe(4);
    expect(summaryAll.pctDeclaredGlobal).toBeCloseTo((4 / 6) * 100, 5);
    expect(summaryAll.byOperator.map((o) => o.key)).toEqual([
      'movistar',
      'orange',
      'vodafone',
    ]);
    expect(
      summaryAll.byOperator.map((o) => ({
        key: o.key,
        total: o.total,
        declared: o.declared,
      })),
    ).toEqual([
      { key: 'movistar', total: 3, declared: 2 },
      { key: 'orange', total: 2, declared: 1 },
      { key: 'vodafone', total: 1, declared: 1 },
    ]);

    const summaryOnlyN78 = computeUnicoSimpleSummary(unicoAntenas, masks, {
      fase: 'all',
      selectedProvinces: emptySet,
      selectedComunidades: emptySet,
      bandFilter: 'N78',
    });
    expect(summaryOnlyN78.totalAntennas).toBe(6);
    expect(summaryOnlyN78.totalDeclared).toBe(2);
    expect(
      summaryOnlyN78.byOperator.find((o) => o.key === 'movistar')?.declared,
    ).toBe(2);
    expect(
      summaryOnlyN78.byOperator.find((o) => o.key === 'orange')?.declared,
    ).toBe(0);
    expect(
      summaryOnlyN78.byOperator.find((o) => o.key === 'vodafone')?.declared,
    ).toBe(0);

    const summaryOnlyN28 = computeUnicoSimpleSummary(unicoAntenas, masks, {
      fase: 'all',
      selectedProvinces: emptySet,
      selectedComunidades: emptySet,
      bandFilter: 'N28',
    });
    expect(summaryOnlyN28.totalDeclared).toBe(1);
    expect(
      summaryOnlyN28.byOperator.find((o) => o.key === 'orange')?.declared,
    ).toBe(1);

    const summaryOnlyN28Plus = computeUnicoSimpleSummary(unicoAntenas, masks, {
      fase: 'all',
      selectedProvinces: emptySet,
      selectedComunidades: emptySet,
      bandFilter: 'N28+',
    });
    expect(summaryOnlyN28Plus.totalDeclared).toBe(1);
    expect(
      summaryOnlyN28Plus.byOperator.find((o) => o.key === 'vodafone')?.declared,
    ).toBe(1);

    // Filtro por Fase 1 vs Fase 2
    const summaryFase1 = computeUnicoSimpleSummary(unicoAntenas, masks, {
      fase: '1',
      selectedProvinces: emptySet,
      selectedComunidades: emptySet,
      bandFilter: 'all',
    });
    expect(summaryFase1.totalAntennas).toBe(3); // u-case1-n78, u-case1-n28plus, u-case2-out-of-range
    expect(summaryFase1.totalDeclared).toBe(2);

    const summaryFase2 = computeUnicoSimpleSummary(unicoAntenas, masks, {
      fase: '2',
      selectedProvinces: emptySet,
      selectedComunidades: emptySet,
      bandFilter: 'all',
    });
    expect(summaryFase2.totalAntennas).toBe(3); // u-case1-n28, u-case3-jumps-over-4g, u-case4-other-op
    expect(summaryFase2.totalDeclared).toBe(2);

    // Filtro por Provincias seleccionadas
    const summaryProvs = computeUnicoSimpleSummary(unicoAntenas, masks, {
      fase: 'all',
      selectedProvinces: new Set(['MADRID', 'LUGO']),
      selectedComunidades: emptySet,
      bandFilter: 'all',
    });
    expect(summaryProvs.totalAntennas).toBe(2);
    expect(summaryProvs.totalDeclared).toBe(2);

    // Filtro por Comunidades Autónomas seleccionadas
    const summaryCcaas = computeUnicoSimpleSummary(unicoAntenas, masks, {
      fase: 'all',
      selectedProvinces: emptySet,
      selectedComunidades: new Set(['Andalucía']),
      bandFilter: 'all',
    });
    expect(summaryCcaas.totalAntennas).toBe(2); // SEVILLA + ALMERÍA
    expect(summaryCcaas.totalDeclared).toBe(1); // solo SEVILLA (N28)

    // Mientras antenas.json aún carga (declaredMasks === null), mantiene totales y deja declaradas a 0
    const summaryPending = computeUnicoSimpleSummary(unicoAntenas, null, {
      fase: 'all',
      selectedProvinces: emptySet,
      selectedComunidades: emptySet,
      bandFilter: 'all',
    });
    expect(summaryPending.totalAntennas).toBe(6);
    expect(summaryPending.totalDeclared).toBe(0);
    expect(summaryPending.pctDeclaredGlobal).toBe(0);

    // Validación de parámetros de URL y utilidades de formato
    expect(
      validateUnico5gSearch({
        tab: 'comunidad',
        fase: '2',
        band: 'N78',
        provs: 'MADRID,SEVILLA',
        ccaas: 'Andalucía',
      }),
    ).toEqual({
      tab: 'comunidad',
      fase: '2',
      band: 'N78',
      provs: 'MADRID,SEVILLA',
      ccaas: 'Andalucía',
    });
    expect(
      validateUnico5gSearch({
        tab: 'provincia',
        fase: 'invalid',
        band: 'B20',
      }),
    ).toEqual({});
    expect(formatUnicoInt(9291)).toBe('9.291');
    expect(formatUnicoPercent(7330, 9291)).toBe('78,9%');
  });

  it('cruza en disco public/data/unico-5g.json × public/data/antenas.json cumpliendo invariantes reales por operadora y banda', async () => {
    const [unicoDataset, rawAntenasDataset] = await Promise.all([
      loadRealUnicoDatasetFromDisk(),
      loadRealAntenasDatasetFromDisk(),
    ]);
    const derived = buildDerivedAntenasStructures(rawAntenasDataset);

    const declaredMasks = matchUnicoDeclaredAntennasMasks(
      unicoDataset.antenas,
      derived.dataset.antenas,
      derived.bandCodeMasks,
    );
    expect(declaredMasks.length).toBe(9291);

    const emptySet = new Set<string>();
    const summaryAll = computeUnicoSimpleSummary(
      unicoDataset.antenas,
      declaredMasks,
      {
        fase: 'all',
        selectedProvinces: emptySet,
        selectedComunidades: emptySet,
        bandFilter: 'all',
      },
    );

    expect(summaryAll.totalAntennas).toBe(9291);
    expect(summaryAll.totalDeclared).toBeGreaterThan(5000);
    expect(summaryAll.totalDeclared).toBeLessThanOrEqual(9291);

    for (const opKey of UNICO_OPERATOR_ORDER) {
      const stat = summaryAll.byOperator.find((o) => o.key === opKey);
      expect(stat).toBeDefined();
      if (!stat) {
        throw new Error(`Falta resumen para operadora ${opKey}`);
      }
      expect(stat.total).toBe(unicoDataset.operators[opKey].total);
      expect(stat.declared).toBeGreaterThan(0);
      expect(stat.declared).toBeLessThanOrEqual(stat.total);
    }

    const summaryN78 = computeUnicoSimpleSummary(
      unicoDataset.antenas,
      declaredMasks,
      {
        fase: 'all',
        selectedProvinces: emptySet,
        selectedComunidades: emptySet,
        bandFilter: 'N78',
      },
    );
    const summaryN28 = computeUnicoSimpleSummary(
      unicoDataset.antenas,
      declaredMasks,
      {
        fase: 'all',
        selectedProvinces: emptySet,
        selectedComunidades: emptySet,
        bandFilter: 'N28',
      },
    );
    const summaryN28Plus = computeUnicoSimpleSummary(
      unicoDataset.antenas,
      declaredMasks,
      {
        fase: 'all',
        selectedProvinces: emptySet,
        selectedComunidades: emptySet,
        bandFilter: 'N28+',
      },
    );

    expect(summaryN78.totalDeclared).toBeGreaterThan(0);
    expect(summaryN78.totalDeclared).toBeLessThanOrEqual(
      summaryAll.totalDeclared,
    );

    expect(summaryN28.totalDeclared).toBeGreaterThan(0);
    expect(summaryN28.totalDeclared).toBeLessThanOrEqual(
      summaryAll.totalDeclared,
    );

    expect(summaryN28Plus.totalDeclared).toBeGreaterThan(0);
    expect(summaryN28Plus.totalDeclared).toBeLessThanOrEqual(
      summaryAll.totalDeclared,
    );

    // La unión ('all') nunca excede la suma de bandas individuales ni es menor que el máximo individual
    expect(summaryAll.totalDeclared).toBeLessThanOrEqual(
      summaryN78.totalDeclared +
        summaryN28.totalDeclared +
        summaryN28Plus.totalDeclared,
    );
    expect(summaryAll.totalDeclared).toBeGreaterThanOrEqual(
      Math.max(
        summaryN78.totalDeclared,
        summaryN28.totalDeclared,
        summaryN28Plus.totalDeclared,
      ),
    );
  }, 15_000);

  it('renderiza SSR de AppHeader y Unico5gView en /unico-5g con pestañas territoriales, declaradas por banda y cero tablas ni rankings', async () => {
    const unicoDataset = await loadRealUnicoDatasetFromDisk();
    const movistarSample = unicoDataset.antenas.find(
      (a) => a.op === 'movistar',
    );
    const orangeSample = unicoDataset.antenas.find((a) => a.op === 'orange');
    if (!movistarSample || !orangeSample) {
      throw new Error('Faltan muestras de Movistar u Orange en unicoDataset');
    }

    const syntheticAntenasDataset: AntenasDataset = {
      updatedAt: '2026-11-24T17:00:00Z',
      sourceUrl: 'https://geoportal.minetur.gob.es/VCTEL/vcne.do',
      total: 2,
      crawlStats: {
        requestsCount: 1,
        durationSeconds: 1,
        gridBoxesVisited: 1,
        subdividedBoxes: 0,
        zoomParam: 7,
        delaySeconds: 0.02,
        bandsPopulatedCount: 2,
      },
      operators: {
        movistar: {
          key: 'movistar',
          name: 'Movistar (Telefónica)',
          count: 1,
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
          provincia: movistarSample.prov,
          count: 2,
          byOperator: { movistar: 1, orange: 1 },
        },
      ],
      antenas: [
        makeRealAntenna({
          id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 990001',
          gid: '990001',
          op: 'movistar',
          lat: movistarSample.lat + 0.0005,
          lon: movistarSample.lon,
          mun: movistarSample.mun,
          prov: movistarSample.prov,
          bandas: ['3500 MHz'],
          frecuencias: ['3600.00 - 3700.00'],
        }),
        makeRealAntenna({
          id: 'ORANGE ESPAGNE, S.A.U. - 990002',
          gid: '990002',
          op: 'orange',
          opRaw: 'ORANGE ESPAGNE, S.A.U.',
          lat: orangeSample.lat + 0.0005,
          lon: orangeSample.lon,
          mun: orangeSample.mun,
          prov: orangeSample.prov,
          bandas: ['700 MHz'],
          frecuencias: ['758.00 - 768.00'],
        }),
      ],
    };

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(UNICO_5G_QUERY_KEY, unicoDataset);
    queryClient.setQueryData(['antenas-dataset'], syntheticAntenasDataset);

    const rootRoute = createRootRoute({
      component: () =>
        createElement(
          WorkspaceProvider,
          null,
          createElement(AppHeader),
          createElement(Outlet),
        ),
    });
    const mapStubRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => createElement('div', null, 'Mapa'),
    });
    const novedadesStubRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/novedades',
      component: () => createElement('div', null, 'Novedades'),
    });
    const eliminacionesStubRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/eliminaciones',
      component: () => createElement('div', null, 'Eliminaciones'),
    });
    const estadisticasStubRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/estadisticas',
      component: () => createElement('div', null, 'Estadisticas'),
    });
    const unicoRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/unico-5g',
      validateSearch: validateUnico5gSearch,
      component: Unico5gView,
    });

    const memoryRouter = createRouter({
      routeTree: rootRoute.addChildren([
        mapStubRoute,
        novedadesStubRoute,
        eliminacionesStubRoute,
        estadisticasStubRoute,
        unicoRoute,
      ]),
      history: createMemoryHistory({ initialEntries: ['/unico-5g'] }),
    });
    await memoryRouter.load();

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(RouterProvider, { router: memoryRouter }),
      ),
    );

    // Navegación principal con contador 9.291
    expect(html).toContain('UNICO 5G');
    expect(html).toContain('9.291');

    // Pestañas y selector territorial
    expect(html).toContain('Por Provincia');
    expect(html).toContain('Por Comunidad');
    expect(html).toContain('Todas las provincias');

    // Tarjeta 1: Antenas por operadora (Telefonica, Orange, Vodafone; nunca Movistar ni Avatel)
    expect(html).toContain('Antenas por operadora');
    expect(html).toContain('Telefonica');
    expect(html).toContain('Orange');
    expect(html).toContain('Vodafone');
    expect(html).not.toContain('Movistar');
    expect(html).not.toContain('Avatel');
    expect(html).not.toMatch(/avatel/i);

    // Tarjeta 2: DECLARADAS X/X (Y%) con fondo morado en número de antenas y porcentaje en verde
    expect(html).toContain('DECLARADAS');
    expect(html).toContain('2/9.291');
    expect(html).toContain('(0,0%)');
    expect(html).toContain('unico-count-pill');
    expect(html).toContain('unico-pct-green');
    expect(html).not.toContain('Declaradas por operadora');
    expect(html).toContain('Todo');
    expect(html).toContain('N78');
    expect(html).toContain('N28');
    expect(html).toContain('N28+');

    // Cero tablas, cero rankings y cero códigos excluidos
    expect(html).not.toContain('<table');
    expect(html).not.toMatch(/ranking/i);
    expect(html).not.toMatch(/operador líder/i);
    expect(html).not.toMatch(/id de propietario/i);
    expect(html).not.toMatch(/código de emplazamiento/i);

    // Garantizar que los filtros actualizan estado local sin navegar ni desplazar el scroll de la página
    const fsSpecifier = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFileSync: (path: URL, encoding: string) => string;
    };
    const viewSource = readFileSync(
      new URL('../views/Unico5gView.tsx', import.meta.url),
      'utf-8',
    );
    expect(viewSource).not.toMatch(/\buseNavigate\b/);
    expect(viewSource).not.toMatch(/\bscrollTo\b|\bscrollIntoView\b/);
  });

  it('parsea declaredUpdatedAt y declaredMasks válidos en parseCustomUnico5gJson e ignora máscaras malformadas o de longitud distinta', () => {
    const sampleAntenas = [
      makeUnicoAntenna({ id: 'u-p1', op: 'movistar' }),
      makeUnicoAntenna({
        id: 'u-p2',
        op: 'orange',
        empresa: 'ORANGE ESPAGNE S.A.',
      }),
    ];

    const parsedValid = parseCustomUnico5gJson({
      schemaVersion: 1,
      updatedAt: '2026-11-24T18:00:00Z',
      declaredUpdatedAt: '  2026-11-24T18:10:00Z  ',
      antenas: sampleAntenas,
      declaredMasks: [UNICO_BIT_N78, UNICO_BIT_N28 | (1 << 5)],
      declaredSummary: {
        total: 2,
        declared: 2,
        byBand: { all: 2, N78: 1, N28: 1, 'N28+': 0 },
        byOperator: {
          movistar: { total: 1, declared: 1, N78: 1, N28: 0, 'N28+': 0 },
          orange: { total: 1, declared: 1, N78: 0, N28: 1, 'N28+': 0 },
          vodafone: { total: 0, declared: 0, N78: 0, N28: 0, 'N28+': 0 },
        },
      },
    });

    expect(parsedValid.declaredUpdatedAt).toBe('2026-11-24T18:10:00Z');
    expect(parsedValid.declaredMasks).toEqual([UNICO_BIT_N78, UNICO_BIT_N28]);
    expect(parsedValid.declaredSummary?.declared).toBe(2);

    // Longitud distinta -> omite declaredMasks sin fallar
    const parsedWrongLength = parseCustomUnico5gJson({
      schemaVersion: 1,
      declaredUpdatedAt: '   ',
      antenas: sampleAntenas,
      declaredMasks: [UNICO_BIT_N78],
    });
    expect(parsedWrongLength.declaredUpdatedAt).toBeUndefined();
    expect(parsedWrongLength.declaredMasks).toBeUndefined();

    // Elementos malformados (negativos, decimales o no numéricos) -> omite declaredMasks
    for (const badMasks of [
      [-1, 0],
      [1.5, 0],
      ['1', 0],
      [Number.NaN, 0],
    ]) {
      const parsedBad = parseCustomUnico5gJson({
        schemaVersion: 1,
        antenas: sampleAntenas,
        declaredMasks: badMasks,
      });
      expect(parsedBad.declaredMasks).toBeUndefined();
    }
  });

  it('selecciona máscaras persistidas al instante antes de cargar antenas.json, calcula en vivo al cargarlo y prioriza persistidas más recientes durante refetch post-escaneo', async () => {
    const unicoAntenas: UnicoAntennaRecord[] = [
      makeUnicoAntenna({
        id: 'u-sel-1',
        op: 'movistar',
        lat: 40.0,
        lon: -3.5,
      }),
      makeUnicoAntenna({
        id: 'u-sel-2',
        op: 'orange',
        empresa: 'ORANGE ESPAGNE S.A.',
        lat: 37.5,
        lon: -5.8,
      }),
    ];

    const unicoDataset = parseCustomUnico5gJson({
      schemaVersion: 1,
      updatedAt: '2026-11-24T18:00:00Z',
      declaredUpdatedAt: '2026-11-24T18:30:00Z',
      antenas: unicoAntenas,
      declaredMasks: [UNICO_BIT_N78, UNICO_BIT_N28],
    });
    const persistedMasks = new Uint16Array(unicoDataset.declaredMasks ?? []);

    // Estación real en vivo con N28+ solo en el primer emplazamiento (distinta a persistedMasks)
    const olderAntenasDerived = buildDerivedAntenasStructures(
      makeSyntheticAntenasDataset(
        [
          makeRealAntenna({
            id: 'MV-LIVE-1',
            gid: '5001',
            op: 'movistar',
            lat: 40.0 + 0.002,
            lon: -3.5,
            frecuencias: ['758.00 - 788.00'],
          }),
        ],
        '2026-11-24T18:00:00Z',
      ),
    );

    expect(
      selectEffectiveUnicoDeclaredMasks({
        unicoDataset: null,
        persistedMasks,
        antenasDerived: null,
        isAntenasFetching: false,
      }),
    ).toBeNull();

    // 1) Carga inicial: antenas.json aún no llegó -> devuelve persistedMasks al instante
    const instantMasks = selectEffectiveUnicoDeclaredMasks({
      unicoDataset,
      persistedMasks,
      antenasDerived: null,
      isAntenasFetching: true,
    });
    expect(instantMasks).toBe(persistedMasks);

    expect(
      selectEffectiveUnicoDeclaredMasks({
        unicoDataset,
        persistedMasks: null,
        antenasDerived: null,
        isAntenasFetching: true,
      }),
    ).toBeNull();

    // 2) antenas.json cargado (isAntenasFetching: false) -> cálculo en vivo autoritativo
    const liveMasks = selectEffectiveUnicoDeclaredMasks({
      unicoDataset,
      persistedMasks,
      antenasDerived: olderAntenasDerived,
      isAntenasFetching: false,
    });
    expect(Array.from(liveMasks ?? [])).toEqual([UNICO_BIT_N28_PLUS, 0]);

    // 3) Post-escaneo: unico-5g.json ya trajo declaredUpdatedAt más reciente mientras antenas.json refetchea
    const refetchingNewerPersisted = selectEffectiveUnicoDeclaredMasks({
      unicoDataset,
      persistedMasks,
      antenasDerived: olderAntenasDerived,
      isAntenasFetching: true,
    });
    expect(refetchingNewerPersisted).toBe(persistedMasks);

    // 4) Si antenas.json ya está igual o más actualizado que declaredUpdatedAt, mantiene el cálculo en vivo
    const upToDateAntenasDerived = buildDerivedAntenasStructures(
      makeSyntheticAntenasDataset(
        olderAntenasDerived.dataset.antenas,
        '2026-11-24T18:30:00Z',
      ),
    );
    const refetchingUpToDate = selectEffectiveUnicoDeclaredMasks({
      unicoDataset,
      persistedMasks,
      antenasDerived: upToDateAntenasDerived,
      isAntenasFetching: true,
    });
    expect(Array.from(refetchingUpToDate ?? [])).toEqual([
      UNICO_BIT_N28_PLUS,
      0,
    ]);

    // 5) SSR de Unico5gView sin antenas.json en caché muestra al instante las declaradas persistidas
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(UNICO_5G_QUERY_KEY, unicoDataset);

    const rootRoute = createRootRoute({
      component: () => createElement(Outlet),
    });
    const unicoRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/unico-5g',
      validateSearch: validateUnico5gSearch,
      component: Unico5gView,
    });
    const memoryRouter = createRouter({
      routeTree: rootRoute.addChildren([unicoRoute]),
      history: createMemoryHistory({ initialEntries: ['/unico-5g'] }),
    });
    await memoryRouter.load();

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(RouterProvider, { router: memoryRouter }),
      ),
    );
    expect(html).toContain('DECLARADAS');
    expect(html).toContain('2/2');
    expect(html).toContain('(100,0%)');
    expect(html).not.toContain('cruzando censo real');
  });

  it('reacciona en vivo a deltas de escaneo (newAntennas N78, bandPatches N28+ y removedAntennaIds) mediante mergeLiveDeltaIntoAntenasDataset', () => {
    const unicoAntenas: UnicoAntennaRecord[] = [
      // Sitio 0 (Movistar): inicialmente sin estación real cercana -> 0
      makeUnicoAntenna({
        id: 'u-live-new-n78',
        op: 'movistar',
        lat: 40.0,
        lon: -3.5,
      }),
      // Sitio 1 (Orange): inicialmente estación real más cercana solo 4G (B20) -> 0
      makeUnicoAntenna({
        id: 'u-live-patch-n28plus',
        op: 'orange',
        empresa: 'ORANGE ESPAGNE S.A.',
        ccaa: 'Andalucía',
        prov: 'SEVILLA',
        mun: 'Cazalla',
        lat: 37.5,
        lon: -5.8,
      }),
      // Sitio 2 (Vodafone): inicialmente estación real 5G (N78) -> UNICO_BIT_N78
      makeUnicoAntenna({
        id: 'u-live-remove-5g',
        op: 'vodafone',
        empresa: 'VODAFONE ESPAÑA S.A.',
        ccaa: 'Galicia',
        prov: 'LUGO',
        mun: 'Vilalba',
        lat: 43.3,
        lon: -7.6,
      }),
    ];

    const orange4gId = 'ORANGE ESPAGNE, S.A.U. - 700001';
    const vodafone5gId = 'VODAFONE ESPAÑA, S.A.U. - 700002';

    const baseDataset = makeSyntheticAntenasDataset(
      [
        makeRealAntenna({
          id: orange4gId,
          gid: '700001',
          op: 'orange',
          opRaw: 'ORANGE ESPAGNE, S.A.U.',
          lat: 37.5 + 0.0018, // ~200 m
          lon: -5.8,
          mun: 'CAZALLA',
          prov: 'SEVILLA',
          bandas: ['800 MHz'],
          frecuencias: ['791.00 - 801.00'],
          bandsScannedAt: '2026-11-24T16:00:00Z',
        }),
        makeRealAntenna({
          id: vodafone5gId,
          gid: '700002',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          lat: 43.3 + 0.0018, // ~200 m
          lon: -7.6,
          mun: 'VILALBA',
          prov: 'LUGO',
          bandas: ['3500 MHz'],
          frecuencias: ['3600.00 - 3700.00'],
          bandsScannedAt: '2026-11-24T16:00:00Z',
        }),
      ],
      '2026-11-24T17:00:00Z',
    );

    const baseDerived = buildDerivedAntenasStructures(baseDataset);
    const baseMasks = matchUnicoDeclaredAntennasMasks(
      unicoAntenas,
      baseDerived.dataset.antenas,
      baseDerived.bandCodeMasks,
    );
    expect(Array.from(baseMasks)).toEqual([0, 0, UNICO_BIT_N78]);

    // 1) Alta en vivo de una nueva antena real con N78 a ~445 m (<= 1,2 km) -> Sitio 0 pasa a UNICO_BIT_N78
    const deltaAddN78 = makeLiveDelta({
      deltaSeq: 1,
      updatedAt: '2026-11-24T17:10:00Z',
      newAntennas: [
        makeRealAntenna({
          id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 700003',
          gid: '700003',
          op: 'movistar',
          lat: 40.0 + 0.004, // ~445 m
          lon: -3.5,
          bandas: ['3500 MHz'],
          frecuencias: ['3600.00 - 3700.00'],
          bandsScannedAt: '2026-11-24T17:10:00Z',
        }),
      ],
    });
    const afterAddDataset = mergeLiveDeltaIntoAntenasDataset(
      baseDataset,
      deltaAddN78,
    );
    const afterAddDerived = buildDerivedAntenasStructures(afterAddDataset);
    const afterAddMasks = matchUnicoDeclaredAntennasMasks(
      unicoAntenas,
      afterAddDerived.dataset.antenas,
      afterAddDerived.bandCodeMasks,
    );
    expect(Array.from(afterAddMasks)).toEqual([
      UNICO_BIT_N78,
      0,
      UNICO_BIT_N78,
    ]);

    // 2) bandPatch añade N28+ a la estación 4G más cercana de Orange -> Sitio 1 pasa a UNICO_BIT_N28_PLUS
    const n28PlusPatch: LiveBandPatch = {
      id: orange4gId,
      gid: '700001',
      bandas: ['700 MHz', '800 MHz'],
      frecuencias: ['758.00 - 788.00', '791.00 - 801.00'],
      concesiones: [],
      bandsScannedAt: '2026-11-24T17:15:00Z',
    };
    const deltaBandPatch = makeLiveDelta({
      deltaSeq: 2,
      updatedAt: '2026-11-24T17:15:00Z',
      newAntennas: deltaAddN78.newAntennas,
      bandPatchesById: new Map([[orange4gId, n28PlusPatch]]),
    });
    const afterPatchDataset = mergeLiveDeltaIntoAntenasDataset(
      baseDataset,
      deltaBandPatch,
    );
    const afterPatchDerived = buildDerivedAntenasStructures(afterPatchDataset);
    const afterPatchMasks = matchUnicoDeclaredAntennasMasks(
      unicoAntenas,
      afterPatchDerived.dataset.antenas,
      afterPatchDerived.bandCodeMasks,
    );
    expect(Array.from(afterPatchMasks)).toEqual([
      UNICO_BIT_N78,
      UNICO_BIT_N28_PLUS,
      UNICO_BIT_N78,
    ]);

    // 3) Baja en vivo mediante removedAntennaIds elimina la estación 5G de Vodafone -> Sitio 2 vuelve a 0
    const deltaRemove5g = makeLiveDelta({
      deltaSeq: 3,
      updatedAt: '2026-11-24T17:20:00Z',
      newAntennas: deltaAddN78.newAntennas,
      bandPatchesById: new Map([[orange4gId, n28PlusPatch]]),
      removedAntennaIds: new Set([vodafone5gId]),
    });
    const afterRemoveDataset = mergeLiveDeltaIntoAntenasDataset(
      baseDataset,
      deltaRemove5g,
    );
    const afterRemoveDerived =
      buildDerivedAntenasStructures(afterRemoveDataset);
    const afterRemoveMasks = matchUnicoDeclaredAntennasMasks(
      unicoAntenas,
      afterRemoveDerived.dataset.antenas,
      afterRemoveDerived.bandCodeMasks,
    );
    expect(Array.from(afterRemoveMasks)).toEqual([
      UNICO_BIT_N78,
      UNICO_BIT_N28_PLUS,
      0,
    ]);
  });

  it('invalida ["unico-5g-dataset"] al completar un escaneo y descarga unico-5g.json con cache: "no-cache"', async () => {
    const [scanProgressSource, unicoHookSource] = await Promise.all([
      readDiskTextFile('./useScanProgress.ts'),
      readDiskTextFile('./useUnico5gData.ts'),
    ]);

    const invalidateFnMatch = scanProgressSource.match(
      /function useInvalidateDatasetsOnScanCompletion\([\s\S]*?\n\}/,
    );
    expect(invalidateFnMatch).not.toBeNull();
    const invalidateFnBody = invalidateFnMatch?.[0] ?? '';
    expect(invalidateFnBody).toMatch(
      /invalidateQueries\(\{\s*queryKey:\s*\['unico-5g-dataset'\]\s*,?\s*\}\)/,
    );

    const fetchFnMatch = unicoHookSource.match(
      /export async function importUnico5gJsonDataset\([\s\S]*?\n\}/,
    );
    expect(fetchFnMatch).not.toBeNull();
    const fetchFnBody = fetchFnMatch?.[0] ?? '';
    expect(fetchFnBody).toContain('data/unico-5g.json');
    expect(fetchFnBody).toMatch(/cache:\s*'no-cache'/);
  });

  it('mantiene paridad exacta bit a bit entre declaredMasks persistidos en public/data/unico-5g.json y el cruce en vivo con public/data/antenas.json', async () => {
    const [unicoDataset, rawAntenasDataset] = await Promise.all([
      loadRealUnicoDatasetFromDisk(),
      loadRealAntenasDatasetFromDisk(),
    ]);
    const derived = buildDerivedAntenasStructures(rawAntenasDataset);
    const liveMasks = matchUnicoDeclaredAntennasMasks(
      unicoDataset.antenas,
      derived.dataset.antenas,
      derived.bandCodeMasks,
    );

    expect(unicoDataset.declaredMasks).toBeDefined();
    expect(unicoDataset.declaredMasks?.length).toBe(
      unicoDataset.antenas.length,
    );
    expect(unicoDataset.declaredUpdatedAt).toBe(rawAntenasDataset.updatedAt);
    expect(Array.from(liveMasks)).toEqual(unicoDataset.declaredMasks);
  }, 15_000);

  it('verifica que .github/workflows/update-and-deploy.yml sincroniza public/data/unico-5g.json con --sync-antenas y lo añade al commit en Parte 1/2 y Parte 2/2', async () => {
    const workflowSource = await readDiskTextFile(
      '../../.github/workflows/update-and-deploy.yml',
    );

    const part1Start = workflowSource.indexOf('  scan-part-1:');
    const part2Start = workflowSource.indexOf('  scan-part-2:');
    const deployStart = workflowSource.indexOf('  build-and-deploy:');

    expect(part1Start).toBeGreaterThan(-1);
    expect(part2Start).toBeGreaterThan(part1Start);
    expect(deployStart).toBeGreaterThan(part2Start);

    const part1Block = workflowSource.slice(part1Start, part2Start);
    const part2Block = workflowSource.slice(part2Start, deployStart);

    for (const block of [part1Block, part2Block]) {
      expect(block).toMatch(
        /scripts\/build_unico_5g\.py(?:[^\n]|\\\n)*--sync-antenas/,
      );
      expect(block).toMatch(
        /git\s+add\b(?:[^\n]|\\\n)*public\/data\/unico-5g\.json/,
      );
    }
  });

  it('selecciona 1-a-1 por operadora las antenas reales declaradas UNICO 5G en matchUnicoDeclaredAntennas (fallback a siguiente más cercana, torre compartida multioperador y paridad 1:1 con el dataset real)', async () => {
    expect(formatUnicoDeclaredBitsList(UNICO_BIT_N78)).toEqual(['N78']);
    expect(
      formatUnicoDeclaredBitsList(UNICO_BIT_N28 | UNICO_BIT_N78),
    ).toEqual(['N78', 'N28']);
    expect(
      formatUnicoDeclaredBitsList(UNICO_BIT_N28_PLUS | UNICO_BIT_N78),
    ).toEqual(['N78', 'N28+']);
    expect(formatUnicoFasesLabel([1])).toBe('Fase 1');
    expect(formatUnicoFasesLabel([2])).toBe('Fase 2');
    expect(formatUnicoFasesLabel([1, 2])).toBe('Fase 1 y 2');
    expect(formatUnicoFasesLabel([])).toBe('UNICO 5G');

    const unicoAntenas: UnicoAntennaRecord[] = [
      // 0: Expediente Movistar más lejano (~445 m de MV-PRIMARY-5G) -> tras ser elegida por u-map-f1-closer,
      //    debe buscar la siguiente más cercana disponible (MV-SECOND-N28 a ~333 m al norte)
      makeUnicoAntenna({
        id: 'u-map-f2-farther',
        fase: 2,
        op: 'movistar',
        mun: 'Pueblo A',
        lat: 40.0 + 0.004,
        lon: -3.5,
      }),
      // 1: Expediente Movistar más cercano (~111 m de MV-PRIMARY-5G) -> se queda MV-PRIMARY-5G
      makeUnicoAntenna({
        id: 'u-map-f1-closer',
        fase: 1,
        op: 'movistar',
        mun: 'Pueblo A',
        lat: 40.0 + 0.001,
        lon: -3.5,
      }),
      // 2: Tercer expediente Movistar (~222 m al sur de MV-PRIMARY-5G) -> MV-PRIMARY-5G y MV-SECOND-N28 ocupadas -> 0
      makeUnicoAntenna({
        id: 'u-map-f2-exhausted',
        fase: 2,
        op: 'movistar',
        mun: 'Pueblo A',
        lat: 40.0 - 0.002,
        lon: -3.5,
      }),
      // 3: Expediente Vodafone en el mismo emplazamiento compartido (< 15 m de MV-PRIMARY-5G) -> NO se bloquea por Movistar
      makeUnicoAntenna({
        id: 'u-map-vf-shared',
        fase: 1,
        op: 'vodafone',
        empresa: 'VODAFONE ESPAÑA S.A.',
        mun: 'Pueblo A',
        lat: 40.0 + 0.00005,
        lon: -3.5,
      }),
      // 4: Caso 4G-only más cercana (~100 m) + segunda sin bandas requeridas (~350 m) -> salta ambas y elige la 5G válida más cercana (~1.145 m <= 1.200 m)
      makeUnicoAntenna({
        id: 'u-map-jumps-over-4g',
        fase: 1,
        op: 'orange',
        empresa: 'ORANGE ESPAGNE S.A.',
        lat: 38.0,
        lon: -4.0,
      }),
      // 5: Caso fuera de rango (> 1.200 m, ~1.334 m) -> no seleccionada
      makeUnicoAntenna({
        id: 'u-map-too-far',
        fase: 2,
        op: 'vodafone',
        empresa: 'VODAFONE ESPAÑA S.A.',
        lat: 42.0,
        lon: -5.0,
      }),
    ];

    const realAntenas: AntennaRecord[] = [
      makeRealAntenna({
        id: 'MV-PRIMARY-5G',
        gid: '880001',
        op: 'movistar',
        lat: 40.0,
        lon: -3.5,
        bandas: ['700 MHz', '3500 MHz'],
        frecuencias: ['758.00 - 768.00', '3600.00 - 3700.00'],
      }),
      makeRealAntenna({
        id: 'MV-SECOND-N28',
        gid: '880011',
        op: 'movistar',
        lat: 40.0 + 0.007,
        lon: -3.5,
        bandas: ['700 MHz'],
        frecuencias: ['758.00 - 768.00'],
      }),
      makeRealAntenna({
        id: 'VF-SHARED-N28PLUS',
        gid: '880012',
        op: 'vodafone',
        opRaw: 'VODAFONE ESPAÑA, S.A.U.',
        lat: 40.0 + 0.00003,
        lon: -3.5,
        bandas: ['700 MHz'],
        frecuencias: ['758.00 - 788.00'],
      }),
      makeRealAntenna({
        id: 'OR-CLOSEST-4G',
        gid: '880002',
        op: 'orange',
        opRaw: 'ORANGE ESPAGNE, S.A.U.',
        lat: 38.0 + 0.0009,
        lon: -4.0,
        bandas: ['800 MHz'],
        frecuencias: ['791.00 - 801.00'],
      }),
      makeRealAntenna({
        id: 'OR-SECOND-INVALID',
        gid: '880005',
        op: 'orange',
        opRaw: 'ORANGE ESPAGNE, S.A.U.',
        lat: 38.0 + 0.0031,
        lon: -4.0,
        bandas: ['1800 MHz'],
        frecuencias: ['1805.00 - 1825.00'],
      }),
      makeRealAntenna({
        id: 'OR-THIRD-5G',
        gid: '880003',
        op: 'orange',
        opRaw: 'ORANGE ESPAGNE, S.A.U.',
        lat: 38.0 + 0.0103,
        lon: -4.0,
        bandas: ['3500 MHz'],
        frecuencias: ['3600.00 - 3700.00'],
      }),
      makeRealAntenna({
        id: 'VF-TOO-FAR-5G',
        gid: '880004',
        op: 'vodafone',
        opRaw: 'VODAFONE ESPAÑA, S.A.U.',
        lat: 42.0 + 0.012,
        lon: -5.0,
        bandas: ['3500 MHz'],
        frecuencias: ['3600.00 - 3700.00'],
      }),
    ];

    const matchResult = matchUnicoDeclaredAntennas(unicoAntenas, realAntenas);
    expect(Array.from(matchResult.declaredMasks)).toEqual([
      UNICO_BIT_N28,
      UNICO_BIT_N78 | UNICO_BIT_N28,
      0,
      UNICO_BIT_N28_PLUS,
      UNICO_BIT_N78,
      0,
    ]);
    expect(matchResult.declaredRealAntennasById.size).toBe(4);
    expect(matchResult.declaredRealAntennasById.has('OR-CLOSEST-4G')).toBe(
      false,
    );
    expect(matchResult.declaredRealAntennasById.has('OR-SECOND-INVALID')).toBe(
      false,
    );
    expect(matchResult.declaredRealAntennasById.has('OR-THIRD-5G')).toBe(true);
    expect(matchResult.declaredRealAntennasById.has('VF-TOO-FAR-5G')).toBe(
      false,
    );

    const mvPrimaryMatch =
      matchResult.declaredRealAntennasById.get('MV-PRIMARY-5G');
    expect(mvPrimaryMatch).toBeDefined();
    expect(mvPrimaryMatch?.fases).toEqual([1]);
    expect(mvPrimaryMatch?.declaredBits).toBe(UNICO_BIT_N78 | UNICO_BIT_N28);
    expect(mvPrimaryMatch?.entries).toHaveLength(1);
    expect(mvPrimaryMatch?.entries[0]?.unicoId).toBe('u-map-f1-closer');

    const mvSecondMatch =
      matchResult.declaredRealAntennasById.get('MV-SECOND-N28');
    expect(mvSecondMatch).toBeDefined();
    expect(mvSecondMatch?.fases).toEqual([2]);
    expect(mvSecondMatch?.declaredBits).toBe(UNICO_BIT_N28);
    expect(mvSecondMatch?.entries).toHaveLength(1);
    expect(mvSecondMatch?.entries[0]?.unicoId).toBe('u-map-f2-farther');

    const vfSharedMatch =
      matchResult.declaredRealAntennasById.get('VF-SHARED-N28PLUS');
    expect(vfSharedMatch).toBeDefined();
    expect(vfSharedMatch?.fases).toEqual([1]);
    expect(vfSharedMatch?.declaredBits).toBe(UNICO_BIT_N28_PLUS);
    expect(vfSharedMatch?.entries).toHaveLength(1);
    expect(vfSharedMatch?.entries[0]?.unicoId).toBe('u-map-vf-shared');

    const orThirdMatch =
      matchResult.declaredRealAntennasById.get('OR-THIRD-5G');
    expect(orThirdMatch).toBeDefined();
    expect(orThirdMatch?.fases).toEqual([1]);
    expect(orThirdMatch?.declaredBits).toBe(UNICO_BIT_N78);
    expect(orThirdMatch?.entries).toHaveLength(1);
    expect(orThirdMatch?.entries[0]?.unicoId).toBe('u-map-jumps-over-4g');
    expect(orThirdMatch?.minDistanceKm).toBeGreaterThan(1.0);
    expect(orThirdMatch?.minDistanceKm).toBeLessThanOrEqual(
      UNICO_MAX_MATCH_DISTANCE_KM,
    );

    // Paridad exacta 1-a-1 sobre el dataset real en disco (unico-5g.json × antenas.json)
    const [unicoDataset, rawAntenasDataset] = await Promise.all([
      loadRealUnicoDatasetFromDisk(),
      loadRealAntenasDatasetFromDisk(),
    ]);
    const derived = buildDerivedAntenasStructures(rawAntenasDataset);
    const realMatch = matchUnicoDeclaredAntennas(
      unicoDataset.antenas,
      derived.dataset.antenas,
      derived.bandCodeMasks,
    );

    let nonZeroMasks = 0;
    for (let i = 0; i < realMatch.declaredMasks.length; i++) {
      if (realMatch.declaredMasks[i] !== 0) nonZeroMasks += 1;
    }

    for (const [antId, info] of realMatch.declaredRealAntennasById.entries()) {
      expect(derived.byId.has(antId)).toBe(true);
      expect(info.declaredBits & UNICO_DECLARED_ANY_MASK).not.toBe(0);
      expect(info.entries).toHaveLength(1);
      expect(info.minDistanceKm).toBeLessThanOrEqual(
        UNICO_MAX_MATCH_DISTANCE_KM + 1e-9,
      );
    }

    // Regla 1-a-1 estricta: tantas antenas reales seleccionadas como ubicaciones UNICO declaradas
    expect(realMatch.declaredRealAntennasById.size).toBe(nonZeroMasks);
    expect(realMatch.declaredRealAntennasById.size).toBeGreaterThan(5000);
  }, 15_000);

  it('resalta las antenas declaradas UNICO 5G en AntenasMap, MapOverlays, FilterPanel, StationDetailDrawer y MapaView (SSR)', async () => {
    const [antenasMapSource, mapOverlaysSource] = await Promise.all([
      readDiskTextFile('../components/map/AntenasMap.tsx'),
      readDiskTextFile('../components/map/MapOverlays.tsx'),
    ]);

    // 1. Capas WebGL dedicadas en AntenasMap colocadas debajo de LAYER_UNCLUSTERED y activas por defecto
    expect(antenasMapSource).toContain(
      "const LAYER_UNICO_DECLARED_HALO = 'antenas-unico-declared-halo';",
    );
    expect(antenasMapSource).toContain(
      "const LAYER_UNICO_DECLARED_RING = 'antenas-unico-declared-ring';",
    );
    expect(antenasMapSource).toContain("['==', ['get', 'isUnicoDeclared'], true]");
    expect(antenasMapSource).toContain(
      'const [internalHighlightUnicoDeclared, setInternalHighlightUnicoDeclared] =\n    useState<boolean>(true);',
    );
    expect(
      antenasMapSource.indexOf('map.addLayer({\n        id: LAYER_UNICO_DECLARED_HALO'),
    ).toBeGreaterThan(-1);
    expect(
      antenasMapSource.indexOf('id: LAYER_UNICO_DECLARED_HALO'),
    ).toBeLessThan(antenasMapSource.indexOf('id: LAYER_UNICO_DECLARED_RING'));
    expect(
      antenasMapSource.indexOf('id: LAYER_UNICO_DECLARED_RING'),
    ).toBeLessThan(antenasMapSource.indexOf('id: LAYER_UNCLUSTERED,'));
    // Tarjetas flotantes de hover en antenas eliminadas (la ficha técnica completa se abre al hacer clic)
    expect(antenasMapSource).not.toContain('function buildPopupHtml');
    expect(antenasMapSource).not.toContain('Clic para inspeccionar ficha técnica');

    // 2. MapOverlays expone el interruptor #map-highlight-unico-option en el desplegable de capas
    expect(mapOverlaysSource).toContain('id="map-highlight-unico-option"');
    expect(mapOverlaysSource).toContain('Resaltar declaradas UNICO 5G');
    const overlaysHtml = renderToStaticMarkup(
      createElement(MapOverlays, {
        styleId: 'osm',
        onStyleChange: () => {},
        highlightUnicoDeclared: true,
        onToggleHighlightUnicoDeclared: () => {},
        onFlyToRegion: () => {},
      }),
    );
    expect(overlaysHtml).toContain('id="map-style-switcher-btn"');

    // 3. FilterPanel + StationDetailDrawer + MapaView con emplazamiento compartido (< 15 m) donde Movistar es UNICO y Vodafone no
    const unicoFixture: UnicoAntennaRecord[] = [
      makeUnicoAntenna({
        id: 'u-ui-mv-1',
        fase: 1,
        op: 'movistar',
        empresa: 'TELEFÓNICA MÓVILES ESPAÑA, S.A.',
        ccaa: 'Comunidad de Madrid',
        prov: 'MADRID',
        mun: 'Buitrago del Lozoya',
        lat: 40.992,
        lon: -3.635,
      }),
    ];
    const mvAnt = makeRealAntenna({
      id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2890001',
      gid: '2890001',
      op: 'movistar',
      lat: 40.9921, // ~11 m de la coordenada UNICO
      lon: -3.635,
      mun: 'BUITRAGO DEL LOZOYA',
      prov: 'MADRID',
      bandas: ['700 MHz', '3500 MHz'],
      frecuencias: ['758.00 - 768.00', '3600.00 - 3700.00'],
    });
    const vfSharedAnt = makeRealAntenna({
      id: 'VODAFONE ESPAÑA, S.A.U. - 2890002',
      gid: '2890002',
      op: 'vodafone',
      opRaw: 'VODAFONE ESPAÑA, S.A.U.',
      lat: 40.99214, // ~4.4 m de Movistar (< 15 m -> icono multicolor compartido)
      lon: -3.635,
      mun: 'BUITRAGO DEL LOZOYA',
      prov: 'MADRID',
      bandas: ['800 MHz'],
      frecuencias: ['791.00 - 801.00'],
    });
    const syntheticAntenas = makeSyntheticAntenasDataset([mvAnt, vfSharedAnt]);
    const derived = buildDerivedAntenasStructures(syntheticAntenas);
    const { declaredRealAntennasById } = matchUnicoDeclaredAntennas(
      unicoFixture,
      derived.dataset.antenas,
      derived.bandCodeMasks,
    );

    expect(declaredRealAntennasById.has(mvAnt.id)).toBe(true);
    expect(declaredRealAntennasById.has(vfSharedAnt.id)).toBe(false);

    // FilterPanel SSR con sección UNICO 5G y contador exacto
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
        onlyUnicoDeclared: false,
        onOnlyUnicoDeclaredChange: () => {},
        unicoDeclaredCount: 1,
        highlightUnicoDeclared: true,
        activeOperators: [...OPERATOR_ORDER],
        onToggleOperator: () => {},
        onSelectAllOperators: () => {},
        onClearAllOperators: () => {},
        hasActiveFilters: false,
        onResetFilters: () => {},
        onFlyTo: () => {},
      }),
    );
    expect(filterHtml).toContain('id="filter-unico-declared-checkbox"');
    expect(filterHtml).toContain('Solo declaradas UNICO 5G');
    expect(filterHtml).toContain('1 declarada');
    expect(filterHtml).toContain('unico-filter-legend-swatch');
    expect(filterHtml).toContain('≤ 1.200 m con N28/N28+/N78');

    // FilterPanel SSR con unicoStatus loading/error y highlightUnicoDeclared desactivado
    const filterLoadingHtml = renderToStaticMarkup(
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
        onlyUnicoDeclared: false,
        onOnlyUnicoDeclaredChange: () => {},
        unicoDeclaredCount: 0,
        unicoStatus: 'loading',
        highlightUnicoDeclared: false,
        activeOperators: [...OPERATOR_ORDER],
        onToggleOperator: () => {},
        onSelectAllOperators: () => {},
        onClearAllOperators: () => {},
        hasActiveFilters: false,
        onResetFilters: () => {},
        onFlyTo: () => {},
      }),
    );
    expect(filterLoadingHtml).toContain('Cargando…');
    expect(filterLoadingHtml).toContain('disabled=""');
    expect(filterLoadingHtml).toContain('Sincronizando declaraciones UNICO 5G…');
    expect(filterLoadingHtml).toContain('unico-filter-legend-swatch is-muted');

    const filterMutedHtml = renderToStaticMarkup(
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
        onlyUnicoDeclared: false,
        onOnlyUnicoDeclaredChange: () => {},
        unicoDeclaredCount: 1,
        unicoStatus: 'ready',
        highlightUnicoDeclared: false,
        activeOperators: [...OPERATOR_ORDER],
        onToggleOperator: () => {},
        onSelectAllOperators: () => {},
        onClearAllOperators: () => {},
        hasActiveFilters: false,
        onResetFilters: () => {},
        onFlyTo: () => {},
      }),
    );
    expect(filterMutedHtml).toContain('unico-filter-legend-swatch is-muted');
    expect(filterMutedHtml).toContain(
      'Resaltado verde desactivado en opciones del mapa (≤ 1.200 m con N28/N28+/N78)',
    );

    const filterErrorHtml = renderToStaticMarkup(
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
        onlyUnicoDeclared: false,
        onOnlyUnicoDeclaredChange: () => {},
        unicoDeclaredCount: 0,
        unicoStatus: 'error',
        highlightUnicoDeclared: true,
        activeOperators: [...OPERATOR_ORDER],
        onToggleOperator: () => {},
        onSelectAllOperators: () => {},
        onClearAllOperators: () => {},
        hasActiveFilters: false,
        onResetFilters: () => {},
        onFlyTo: () => {},
      }),
    );
    expect(filterErrorHtml).toContain('No disponible');
    expect(filterErrorHtml).toContain('disabled=""');
    expect(filterErrorHtml).toContain('No se pudo cargar el catálogo UNICO 5G');

    // StationDetailDrawer SSR sobre la estación Movistar declarada UNICO
    const drawerMovistarHtml = renderToStaticMarkup(
      createElement(StationDetailDrawer, {
        antenna: mvAnt,
        allAntenas: derived.dataset.antenas,
        unicoDeclaredById: declaredRealAntennasById,
        onClose: () => {},
        onSelectAntenna: () => {},
      }),
    );
    expect(drawerMovistarHtml).toContain('id="station-unico-card"');
    expect(drawerMovistarHtml).toContain('Declaración UNICO 5G');
    expect(drawerMovistarHtml).toContain('UNICO 5G · Fase 1');
    expect(drawerMovistarHtml).toContain('1.200');
    expect(drawerMovistarHtml).toContain('prioridad N78/N28+ frente a solo N28');
    expect(drawerMovistarHtml).toContain('Buitrago del Lozoya');
    expect(drawerMovistarHtml).toContain('integrated-op-unico-tag');
    expect(drawerMovistarHtml).toContain(
      'title="TELEFÓNICA MÓVILES ESPAÑA, S.A."',
    );
    expect(drawerMovistarHtml).not.toMatch(/id de propietario/i);
    expect(drawerMovistarHtml).not.toMatch(/código de emplazamiento/i);

    // StationDetailDrawer SSR sobre la estación Vodafone NO declarada en el mismo mástil
    const drawerVodafoneHtml = renderToStaticMarkup(
      createElement(StationDetailDrawer, {
        antenna: vfSharedAnt,
        allAntenas: derived.dataset.antenas,
        unicoDeclaredById: declaredRealAntennasById,
        onClose: () => {},
        onSelectAntenna: () => {},
      }),
    );
    expect(drawerVodafoneHtml).not.toContain('id="station-unico-card"');
    // Pero sí muestra la etiqueta UNICO en la pestaña integrada y vecino de Movistar
    expect(drawerVodafoneHtml).toContain('integrated-op-unico-tag');

    // MapaView SSR integrado con QueryClient + Router + WorkspaceProvider
    const syntheticUnicoDataset = parseCustomUnico5gJson({
      schemaVersion: 1,
      updatedAt: '2026-11-24T17:00:00Z',
      antenas: unicoFixture,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(['antenas-dataset'], syntheticAntenas);
    queryClient.setQueryData(['scan-status'], null);
    queryClient.setQueryData(UNICO_5G_QUERY_KEY, syntheticUnicoDataset);

    const rootRoute = createRootRoute({ component: Outlet });
    const mapaRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      validateSearch: (s: Record<string, unknown>) => ({
        gid: typeof s.gid === 'string' ? s.gid : undefined,
        id: typeof s.id === 'string' ? s.id : undefined,
      }),
      component: MapaView,
    });
    const memoryRouter = createRouter({
      routeTree: rootRoute.addChildren([mapaRoute]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    await memoryRouter.load();

    const mapaHtml = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          WorkspaceProvider,
          null,
          createElement(RouterProvider, { router: memoryRouter }),
        ),
      ),
    );
    expect(mapaHtml).toContain('id="filter-unico-declared-checkbox"');
    expect(mapaHtml).toContain('Solo declaradas UNICO 5G');
    expect(mapaHtml).toContain('1 declarada');

    // 4. Casos límite de formatUnicoDistance y matchUnicoDeclaredAntennas
    expect(formatUnicoDistance(0.009)).toBe('9\u00A0m');
    expect(formatUnicoDistance(0.9996)).toBe('1.000\u00A0m');
    expect(formatUnicoDistance(1.0)).toBe('1.000\u00A0m');
    expect(formatUnicoDistance(1.25)).toBe('1,25\u00A0km');
    expect(formatUnicoDistance(Number.NaN)).toBe('0\u00A0m');
    expect(formatUnicoDistance(-0.5)).toBe('0\u00A0m');

    const edgeUnico: UnicoAntennaRecord[] = [
      makeUnicoAntenna({
        id: 'u-edge-nan',
        fase: 1,
        op: 'movistar',
        lat: Number.NaN,
        lon: -3.7,
      }),
      makeUnicoAntenna({
        id: 'u-edge-xfera',
        fase: 2,
        op: 'orange',
        empresa: 'ORANGE ESPAGNE, S.A.U.',
        lat: 40.5,
        lon: -3.5,
      }),
      makeUnicoAntenna({
        id: 'u-edge-avatel',
        fase: 1,
        op: 'orange',
        empresa: 'AVATEL TELECOM S.A.',
        lat: 40.7,
        lon: -3.5,
      }),
    ];
    const edgeReals: AntennaRecord[] = [
      makeRealAntenna({
        id: 'BAD-COORD-1',
        gid: '9990001',
        op: 'movistar',
        lat: Number.POSITIVE_INFINITY,
        lon: -3.7,
        bandas: ['700 MHz'],
        frecuencias: ['758.00 - 768.00'],
      }),
      makeRealAntenna({
        id: 'XFERA MOVILES, S.A.U. - 9990002',
        gid: '9990002',
        op: 'otros',
        opRaw: 'MÁSMÓVIL / XFERA MOVILES, S.A.U.',
        lat: 40.5005,
        lon: -3.5,
        bandas: ['3500 MHz'],
        frecuencias: ['3600.00 - 3700.00'],
      }),
      makeRealAntenna({
        id: 'AVATEL TELECOM S.A. - 9990003',
        gid: '9990003',
        op: 'otros',
        opRaw: 'AVATEL TELECOM S.A.',
        lat: 40.7005,
        lon: -3.5,
        bandas: ['700 MHz'],
        frecuencias: ['758.00 - 768.00'],
      }),
    ];
    const edgeRes = matchUnicoDeclaredAntennas(edgeUnico, edgeReals);
    expect(edgeRes.declaredMasks[0]).toBe(0);
    expect(edgeRes.declaredMasks[1]).toBe(UNICO_BIT_N78);
    expect(edgeRes.declaredMasks[2]).toBe(UNICO_BIT_N28);
    expect(
      edgeRes.declaredRealAntennasById.has('XFERA MOVILES, S.A.U. - 9990002'),
    ).toBe(true);
    expect(
      edgeRes.declaredRealAntennasById.has('AVATEL TELECOM S.A. - 9990003'),
    ).toBe(true);

    // Empate exacto de distancia: menor unicoIdx gana la antena más cercana y el siguiente pasa a la 2ª;
    // entre dos estaciones equidistantes, gana menor stationIdx
    const tieUnico: UnicoAntennaRecord[] = [
      makeUnicoAntenna({
        id: 'u-tie-0',
        fase: 1,
        op: 'movistar',
        lat: 39.5,
        lon: -3.0,
      }),
      makeUnicoAntenna({
        id: 'u-tie-1',
        fase: 2,
        op: 'movistar',
        lat: 39.5,
        lon: -3.0,
      }),
    ];
    const tieReals: AntennaRecord[] = [
      makeRealAntenna({
        id: 'MV-TIE-A',
        gid: '991001',
        op: 'movistar',
        lat: 39.501,
        lon: -3.0,
        bandas: ['3500 MHz'],
        frecuencias: ['3600.00 - 3700.00'],
      }),
      makeRealAntenna({
        id: 'MV-TIE-B',
        gid: '991002',
        op: 'movistar',
        lat: 39.499,
        lon: -3.0,
        bandas: ['700 MHz'],
        frecuencias: ['758.00 - 768.00'],
      }),
    ];
    const tieRes = matchUnicoDeclaredAntennas(tieUnico, tieReals);
    expect(Array.from(tieRes.declaredMasks)).toEqual([
      UNICO_BIT_N78,
      UNICO_BIT_N28,
    ]);
    expect(
      tieRes.declaredRealAntennasById.get('MV-TIE-A')?.entries[0]?.unicoId,
    ).toBe('u-tie-0');
    expect(
      tieRes.declaredRealAntennasById.get('MV-TIE-B')?.entries[0]?.unicoId,
    ).toBe('u-tie-1');

    // Saltos sobre antenas no válidas (4G-only) y ocupadas de más cercano a lejano hasta 1.200 m:
    // (a) Dos proyectos Vodafone con la misma 4G-only más cercana: ambos la saltan; u-4g-shared-2 está más
    //     cerca de VF-5G-FAR (39.105) que u-4g-shared-1 -> u-4g-shared-2 gana VF-5G-FAR (N78) y
    //     u-4g-shared-1 salta a VF-5G-FURTHER (N28+ a ~1.112 m <= 1.200 m).
    // (b) Fallback tras 5G reclamada (OR-5G-CLAIMED) que salta dos 4G-only intermedias (OR-4G-NEXT,
    //     OR-4G-EXTRA) y alcanza OR-5G-FOURTH (N28 a ~1.112 m <= 1.200 m).
    const fourGUnico: UnicoAntennaRecord[] = [
      makeUnicoAntenna({
        id: 'u-4g-shared-1',
        fase: 1,
        op: 'vodafone',
        empresa: 'VODAFONE ESPAÑA S.A.',
        lat: 39.1,
        lon: -2.0,
      }),
      makeUnicoAntenna({
        id: 'u-4g-shared-2',
        fase: 2,
        op: 'vodafone',
        empresa: 'VODAFONE ESPAÑA S.A.',
        lat: 39.1002,
        lon: -2.0,
      }),
      makeUnicoAntenna({
        id: 'u-fb-winner',
        fase: 1,
        op: 'orange',
        empresa: 'ORANGE ESPAGNE S.A.',
        lat: 39.2,
        lon: -2.0,
      }),
      makeUnicoAntenna({
        id: 'u-fb-jumps-4g',
        fase: 2,
        op: 'orange',
        empresa: 'ORANGE ESPAGNE S.A.',
        lat: 39.201,
        lon: -2.0,
      }),
    ];
    const fourGReals: AntennaRecord[] = [
      makeRealAntenna({
        id: 'VF-4G-NEAR',
        gid: '992001',
        op: 'vodafone',
        opRaw: 'VODAFONE ESPAÑA, S.A.U.',
        lat: 39.1001,
        lon: -2.0,
        bandas: ['800 MHz'],
        frecuencias: ['791.00 - 801.00'],
      }),
      makeRealAntenna({
        id: 'VF-5G-FAR',
        gid: '992002',
        op: 'vodafone',
        opRaw: 'VODAFONE ESPAÑA, S.A.U.',
        lat: 39.105,
        lon: -2.0,
        bandas: ['3500 MHz'],
        frecuencias: ['3600.00 - 3700.00'],
      }),
      makeRealAntenna({
        id: 'VF-5G-FURTHER',
        gid: '992006',
        op: 'vodafone',
        opRaw: 'VODAFONE ESPAÑA, S.A.U.',
        lat: 39.11,
        lon: -2.0,
        bandas: ['700 MHz'],
        frecuencias: ['758.00 - 788.00'],
      }),
      makeRealAntenna({
        id: 'OR-5G-CLAIMED',
        gid: '992003',
        op: 'orange',
        opRaw: 'ORANGE ESPAGNE, S.A.U.',
        lat: 39.2,
        lon: -2.0,
        bandas: ['3500 MHz'],
        frecuencias: ['3600.00 - 3700.00'],
      }),
      makeRealAntenna({
        id: 'OR-4G-NEXT',
        gid: '992004',
        op: 'orange',
        opRaw: 'ORANGE ESPAGNE, S.A.U.',
        lat: 39.203,
        lon: -2.0,
        bandas: ['800 MHz'],
        frecuencias: ['791.00 - 801.00'],
      }),
      makeRealAntenna({
        id: 'OR-4G-EXTRA',
        gid: '992007',
        op: 'orange',
        opRaw: 'ORANGE ESPAGNE, S.A.U.',
        lat: 39.206,
        lon: -2.0,
        bandas: ['1800 MHz'],
        frecuencias: ['1805.00 - 1825.00'],
      }),
      makeRealAntenna({
        id: 'OR-5G-FOURTH',
        gid: '992005',
        op: 'orange',
        opRaw: 'ORANGE ESPAGNE, S.A.U.',
        lat: 39.211,
        lon: -2.0,
        bandas: ['700 MHz'],
        frecuencias: ['758.00 - 768.00'],
      }),
    ];
    const fourGRes = matchUnicoDeclaredAntennas(fourGUnico, fourGReals);
    expect(Array.from(fourGRes.declaredMasks)).toEqual([
      UNICO_BIT_N28_PLUS,
      UNICO_BIT_N78,
      UNICO_BIT_N78,
      UNICO_BIT_N28,
    ]);
    expect(fourGRes.declaredRealAntennasById.size).toBe(4);
    expect(fourGRes.declaredRealAntennasById.has('VF-4G-NEAR')).toBe(false);
    expect(fourGRes.declaredRealAntennasById.has('OR-4G-NEXT')).toBe(false);
    expect(fourGRes.declaredRealAntennasById.has('OR-4G-EXTRA')).toBe(false);
    expect(
      fourGRes.declaredRealAntennasById.get('VF-5G-FAR')?.entries[0]?.unicoId,
    ).toBe('u-4g-shared-2');
    expect(
      fourGRes.declaredRealAntennasById.get('VF-5G-FURTHER')?.entries[0]
        ?.unicoId,
    ).toBe('u-4g-shared-1');
    expect(
      fourGRes.declaredRealAntennasById.get('OR-5G-CLAIMED')?.entries[0]
        ?.unicoId,
    ).toBe('u-fb-winner');
    expect(
      fourGRes.declaredRealAntennasById.get('OR-5G-FOURTH')?.entries[0]
        ?.unicoId,
    ).toBe('u-fb-jumps-4g');

    // Preferencia N78 / N28+ frente a solo N28 más cercana (<= 1.200 m):
    // - u-pref-n78 (43.0): solo N28 a ~50 m, N78 a ~1.145 m -> elige N78
    // - u-pref-n28p (43.2): solo N28 a ~50 m, N28+ a ~1.000 m -> elige N28+
    // - u-pref-closer-tier0 (43.4): solo N28 a ~50 m, N28+ a ~400 m, N78 a ~900 m -> elige N28+ (más cercana del nivel 0)
    // - u-pref-fallback-n28 (43.6): solo N28 a ~50 m, N78 a ~1.279 m (> 1.200 m) -> respaldo a solo N28
    // - u-pref-compete-a (43.80005) y u-pref-compete-b (43.8015): ambos tienen solo N28 muy cerca (~5 m para a),
    //   y una N78 lejana en 43.8105 (~1.162 m para a, ~1.001 m para b): b está más cerca de la N78 y se la queda;
    //   a cae en respaldo a solo N28 (~5 m) sin perder su declaración.
    const prefUnico: UnicoAntennaRecord[] = [
      makeUnicoAntenna({
        id: 'u-pref-n78',
        fase: 1,
        op: 'movistar',
        lat: 43.0,
        lon: -2.5,
      }),
      makeUnicoAntenna({
        id: 'u-pref-n28p',
        fase: 1,
        op: 'orange',
        empresa: 'ORANGE ESPAGNE S.A.',
        lat: 43.2,
        lon: -2.5,
      }),
      makeUnicoAntenna({
        id: 'u-pref-closer-tier0',
        fase: 2,
        op: 'vodafone',
        empresa: 'VODAFONE ESPAÑA S.A.',
        lat: 43.4,
        lon: -2.5,
      }),
      makeUnicoAntenna({
        id: 'u-pref-fallback-n28',
        fase: 2,
        op: 'movistar',
        lat: 43.6,
        lon: -2.5,
      }),
      makeUnicoAntenna({
        id: 'u-pref-compete-a',
        fase: 1,
        op: 'vodafone',
        empresa: 'VODAFONE ESPAÑA S.A.',
        lat: 43.80005,
        lon: -2.5,
      }),
      makeUnicoAntenna({
        id: 'u-pref-compete-b',
        fase: 2,
        op: 'vodafone',
        empresa: 'VODAFONE ESPAÑA S.A.',
        lat: 43.8015,
        lon: -2.5,
      }),
    ];
    const prefReals: AntennaRecord[] = [
      makeRealAntenna({
        id: 'MV-PREF-1-N28',
        gid: '995001',
        op: 'movistar',
        lat: 43.00045,
        lon: -2.5,
        bandas: ['700 MHz'],
        frecuencias: ['758.00 - 768.00'],
      }),
      makeRealAntenna({
        id: 'MV-PREF-1-N78',
        gid: '995002',
        op: 'movistar',
        lat: 43.0103,
        lon: -2.5,
        bandas: ['3500 MHz'],
        frecuencias: ['3600.00 - 3700.00'],
      }),
      makeRealAntenna({
        id: 'OR-PREF-2-N28',
        gid: '995003',
        op: 'orange',
        opRaw: 'ORANGE ESPAGNE, S.A.U.',
        lat: 43.20045,
        lon: -2.5,
        bandas: ['700 MHz'],
        frecuencias: ['758.00 - 768.00'],
      }),
      makeRealAntenna({
        id: 'OR-PREF-2-N28P',
        gid: '995004',
        op: 'orange',
        opRaw: 'ORANGE ESPAGNE, S.A.U.',
        lat: 43.209,
        lon: -2.5,
        bandas: ['700 MHz'],
        frecuencias: ['758.00 - 788.00'],
      }),
      makeRealAntenna({
        id: 'VF-PREF-3-N28',
        gid: '995005',
        op: 'vodafone',
        opRaw: 'VODAFONE ESPAÑA, S.A.U.',
        lat: 43.40045,
        lon: -2.5,
        bandas: ['700 MHz'],
        frecuencias: ['758.00 - 768.00'],
      }),
      makeRealAntenna({
        id: 'VF-PREF-3-N28P',
        gid: '995006',
        op: 'vodafone',
        opRaw: 'VODAFONE ESPAÑA, S.A.U.',
        lat: 43.4036,
        lon: -2.5,
        bandas: ['700 MHz'],
        frecuencias: ['758.00 - 788.00'],
      }),
      makeRealAntenna({
        id: 'VF-PREF-3-N78',
        gid: '995007',
        op: 'vodafone',
        opRaw: 'VODAFONE ESPAÑA, S.A.U.',
        lat: 43.4081,
        lon: -2.5,
        bandas: ['3500 MHz'],
        frecuencias: ['3600.00 - 3700.00'],
      }),
      makeRealAntenna({
        id: 'MV-PREF-4-N28',
        gid: '995008',
        op: 'movistar',
        lat: 43.60045,
        lon: -2.5,
        bandas: ['700 MHz'],
        frecuencias: ['758.00 - 768.00'],
      }),
      makeRealAntenna({
        id: 'MV-PREF-4-N78-OUT',
        gid: '995009',
        op: 'movistar',
        lat: 43.6115,
        lon: -2.5,
        bandas: ['3500 MHz'],
        frecuencias: ['3600.00 - 3700.00'],
      }),
      makeRealAntenna({
        id: 'VF-COMP-N28',
        gid: '995010',
        op: 'vodafone',
        opRaw: 'VODAFONE ESPAÑA, S.A.U.',
        lat: 43.8,
        lon: -2.5,
        bandas: ['700 MHz'],
        frecuencias: ['758.00 - 768.00'],
      }),
      makeRealAntenna({
        id: 'VF-COMP-N78',
        gid: '995011',
        op: 'vodafone',
        opRaw: 'VODAFONE ESPAÑA, S.A.U.',
        lat: 43.8105,
        lon: -2.5,
        bandas: ['700 MHz', '3500 MHz'],
        frecuencias: ['758.00 - 768.00', '3600.00 - 3700.00'],
      }),
    ];
    const prefRes = matchUnicoDeclaredAntennas(prefUnico, prefReals);
    expect(Array.from(prefRes.declaredMasks)).toEqual([
      UNICO_BIT_N78,
      UNICO_BIT_N28_PLUS,
      UNICO_BIT_N28_PLUS,
      UNICO_BIT_N28,
      UNICO_BIT_N28,
      UNICO_BIT_N78 | UNICO_BIT_N28,
    ]);
    expect(
      prefRes.declaredRealAntennasById.get('MV-PREF-1-N78')?.entries[0]
        ?.unicoId,
    ).toBe('u-pref-n78');
    expect(
      prefRes.declaredRealAntennasById.get('OR-PREF-2-N28P')?.entries[0]
        ?.unicoId,
    ).toBe('u-pref-n28p');
    expect(
      prefRes.declaredRealAntennasById.get('VF-PREF-3-N28P')?.entries[0]
        ?.unicoId,
    ).toBe('u-pref-closer-tier0');
    expect(
      prefRes.declaredRealAntennasById.get('MV-PREF-4-N28')?.entries[0]
        ?.unicoId,
    ).toBe('u-pref-fallback-n28');
    expect(
      prefRes.declaredRealAntennasById.get('VF-COMP-N78')?.entries[0]?.unicoId,
    ).toBe('u-pref-compete-b');
    expect(
      prefRes.declaredRealAntennasById.get('VF-COMP-N28')?.entries[0]?.unicoId,
    ).toBe('u-pref-compete-a');

    // Protección ante ID duplicado en dataset sintético: conserva el match más cercano y nunca duplica
    const dupIdUnico: UnicoAntennaRecord[] = [
      makeUnicoAntenna({
        id: 'u-dup-close',
        fase: 1,
        op: 'movistar',
        lat: 39.3,
        lon: -2.5,
      }),
      makeUnicoAntenna({
        id: 'u-dup-far',
        fase: 2,
        op: 'movistar',
        lat: 39.303,
        lon: -2.5,
      }),
    ];
    const dupIdReals: AntennaRecord[] = [
      makeRealAntenna({
        id: 'MV-DUP-ID',
        gid: '993001',
        op: 'movistar',
        lat: 39.3001,
        lon: -2.5,
        bandas: ['3500 MHz'],
        frecuencias: ['3600.00 - 3700.00'],
      }),
      makeRealAntenna({
        id: 'MV-DUP-ID',
        gid: '993002',
        op: 'movistar',
        lat: 39.3035,
        lon: -2.5,
        bandas: ['700 MHz'],
        frecuencias: ['758.00 - 768.00'],
      }),
    ];
    const dupIdRes = matchUnicoDeclaredAntennas(dupIdUnico, dupIdReals);
    expect(Array.from(dupIdRes.declaredMasks)).toEqual([UNICO_BIT_N78, 0]);
    expect(dupIdRes.declaredRealAntennasById.size).toBe(1);
    expect(
      dupIdRes.declaredRealAntennasById.get('MV-DUP-ID')?.entries[0]?.unicoId,
    ).toBe('u-dup-close');

    // Torre compartida (< 15 m) con AMBAS operadoras (Movistar y Vodafone) declaradas UNICO en StationDetailDrawer SSR
    const dualSharedUnico: UnicoAntennaRecord[] = [
      makeUnicoAntenna({
        id: 'u-dual-mv',
        fase: 1,
        op: 'movistar',
        lat: 40.992,
        lon: -3.635,
      }),
      makeUnicoAntenna({
        id: 'u-dual-vf',
        fase: 2,
        op: 'vodafone',
        empresa: 'VODAFONE ESPAÑA S.A.',
        lat: 40.99205,
        lon: -3.635,
      }),
    ];
    const vfShared5g = makeRealAntenna({
      id: 'VODAFONE ESPAÑA, S.A.U. - 2890099',
      gid: '2890099',
      op: 'vodafone',
      opRaw: 'VODAFONE ESPAÑA, S.A.U.',
      lat: 40.99214,
      lon: -3.635,
      mun: 'BUITRAGO DEL LOZOYA',
      prov: 'MADRID',
      bandas: ['700 MHz'],
      frecuencias: ['758.00 - 788.00'],
    });
    const dualDerived = buildDerivedAntenasStructures(
      makeSyntheticAntenasDataset([mvAnt, vfShared5g]),
    );
    const dualMatch = matchUnicoDeclaredAntennas(
      dualSharedUnico,
      dualDerived.dataset.antenas,
      dualDerived.bandCodeMasks,
    );
    expect(dualMatch.declaredRealAntennasById.size).toBe(2);
    const dualDrawerVfHtml = renderToStaticMarkup(
      createElement(StationDetailDrawer, {
        antenna: vfShared5g,
        allAntenas: dualDerived.dataset.antenas,
        unicoDeclaredById: dualMatch.declaredRealAntennasById,
        onClose: () => {},
        onSelectAntenna: () => {},
      }),
    );
    expect(dualDrawerVfHtml).toContain('id="station-unico-card"');
    expect(dualDrawerVfHtml).toContain('UNICO 5G · Fase 2');
    expect(dualDrawerVfHtml).toContain('N28+');
  });

  it('construye el GeoJSON puntual con las 9.291 coordenadas oficiales exactas de proyectos UNICO 5G y formatea popups individuales, compartidos e interactivos', async () => {
    // 1. Casos sintéticos (declarada, sin declarar, coordenada inválida filtrada y XSS escapado)
    const synthProjects: UnicoAntennaRecord[] = [
      makeUnicoAntenna({
        id: 'u-coord-1',
        fase: 1,
        op: 'movistar',
        empresa: 'TELEFÓNICA MÓVILES ESPAÑA, S.A.',
        ccaa: 'Comunidad de Madrid',
        prov: 'MADRID',
        mun: 'Buitrago del Lozoya',
        lat: 40.992012,
        lon: -3.635045,
      }),
      makeUnicoAntenna({
        id: 'u-coord-2',
        fase: 2,
        op: 'orange',
        empresa: 'AVATEL <TELECOM> & "S.A."',
        ccaa: 'Andalucía',
        prov: 'ALMERÍA',
        mun: 'Abrucena',
        lat: 37.141906,
        lon: -2.781546,
      }),
      makeUnicoAntenna({
        id: 'u-coord-invalid',
        fase: 1,
        op: 'vodafone',
        lat: Number.NaN,
        lon: -3.5,
      }),
    ];
    const synthReals: AntennaRecord[] = [
      makeRealAntenna({
        id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2890001',
        gid: '2890001',
        op: 'movistar',
        lat: 40.9921,
        lon: -3.635045,
        bandas: ['700 MHz', '3500 MHz'],
        frecuencias: ['758.00 - 768.00', '3600.00 - 3700.00'],
      }),
    ];
    const synthMatch = matchUnicoDeclaredAntennas(synthProjects, synthReals);
    const synthGeo = buildUnicoProjectsGeoJson(
      synthProjects,
      synthMatch.declaredMasks,
      synthMatch.declaredRealAntennasById,
    );

    expect(synthGeo.type).toBe('FeatureCollection');
    expect(synthGeo.features).toHaveLength(2);
    expect(synthGeo.features[0].geometry.coordinates).toEqual([
      -3.635045,
      40.992012,
    ]);
    expect(synthGeo.features[0].properties.iconKey).toBe('unico-coord:movistar');
    expect(synthGeo.features[0].properties.isDeclared).toBe(true);
    expect(synthGeo.features[0].properties.declaredBits).toBe(
      UNICO_BIT_N78 | UNICO_BIT_N28,
    );
    expect(synthGeo.features[0].properties.matchedAntennaId).toBe(
      'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2890001',
    );
    expect(synthGeo.features[0].properties.matchedDistanceKm).toBeGreaterThan(0);

    expect(synthGeo.features[1].geometry.coordinates).toEqual([
      -2.781546,
      37.141906,
    ]);
    expect(synthGeo.features[1].properties.iconKey).toBe('unico-coord:orange');
    expect(synthGeo.features[1].properties.isDeclared).toBe(false);
    expect(synthGeo.features[1].properties.matchedAntennaId).toBe('');
    expect(synthGeo.features[1].properties.matchedDistanceKm).toBe(-1);

    // Popups hover e interactivo (declarada, pendiente con escapado HTML y múltiples proyectos en misma coordenada)
    const declaredHoverHtml = buildUnicoProjectsPopupHtml(
      [synthGeo.features[0].properties],
      { interactive: false, hasMatchedAntenna: true },
    );
    expect(declaredHoverHtml).toContain('Coordenada oficial UNICO 5G');
    expect(declaredHoverHtml).toContain('Fase 1');
    expect(declaredHoverHtml).toContain('Declarada · N78/N28');
    expect(declaredHoverHtml).toContain('40.992012, -3.635045');
    expect(declaredHoverHtml).toContain('ver antena declarada');

    const declaredPinnedHtml = buildUnicoProjectsPopupHtml(
      [synthGeo.features[0].properties],
      { interactive: true, hasMatchedAntenna: true },
    );
    expect(declaredPinnedHtml).toContain('data-unico-action="copy"');
    expect(declaredPinnedHtml).toContain('data-unico-action="focus-matched"');
    expect(declaredPinnedHtml).toContain('Ver antena declarada');

    const pendingPinnedHtml = buildUnicoProjectsPopupHtml(
      [synthGeo.features[1].properties],
      {
        interactive: true,
        hasMatchedAntenna: false,
        fallbackStationLabel: 'Movistar #2890001',
      },
    );
    expect(pendingPinnedHtml).toContain('Sin declarar');
    expect(pendingPinnedHtml).toContain('AVATEL &lt;TELECOM&gt; &amp; &quot;S.A.&quot;');
    expect(pendingPinnedHtml).toContain('data-unico-action="focus-fallback"');
    expect(pendingPinnedHtml).toContain('Ver Movistar #2890001');

    const multiCoordHtml = buildUnicoProjectsPopupHtml(
      [synthGeo.features[0].properties, synthGeo.features[1].properties],
      { interactive: true, hasMatchedAntenna: true },
    );
    expect(multiCoordHtml).toContain('2 proy.');
    expect(multiCoordHtml).toContain('Buitrago del Lozoya');
    expect(multiCoordHtml).toContain('Abrucena');
    expect(multiCoordHtml).toContain('map-popup-unico-multi-list');

    // 2. Dataset real completo en disco: exactamente 9.291 puntos en sus coordenadas oficiales exactas
    const [unicoDataset, rawAntenasDataset] = await Promise.all([
      loadRealUnicoDatasetFromDisk(),
      loadRealAntenasDatasetFromDisk(),
    ]);
    const derived = buildDerivedAntenasStructures(rawAntenasDataset);
    const realMatch = matchUnicoDeclaredAntennas(
      unicoDataset.antenas,
      derived.dataset.antenas,
      derived.bandCodeMasks,
    );

    const realGeo = buildUnicoProjectsGeoJson(
      unicoDataset.antenas,
      realMatch.declaredMasks,
      realMatch.declaredRealAntennasById,
    );
    expect(realGeo.features).toHaveLength(9291);

    let movistarCount = 0;
    let orangeCount = 0;
    let vodafoneCount = 0;
    let fase1Count = 0;
    let fase2Count = 0;
    let declaredCount = 0;
    let sameCoordSegoviaCount = 0;

    for (let i = 0; i < realGeo.features.length; i++) {
      const feature = realGeo.features[i];
      const src = unicoDataset.antenas[i];
      expect(feature.geometry.coordinates[0]).toBe(src.lon);
      expect(feature.geometry.coordinates[1]).toBe(src.lat);
      expect(feature.properties.id).toBe(src.id);
      expect(feature.properties.iconKey).toBe(`unico-coord:${src.op}`);

      if (src.op === 'movistar') movistarCount++;
      else if (src.op === 'orange') orangeCount++;
      else if (src.op === 'vodafone') vodafoneCount++;

      if (src.fase === 1) fase1Count++;
      else fase2Count++;

      if (feature.properties.isDeclared) {
        declaredCount++;
        expect(feature.properties.matchedAntennaId).not.toBe('');
      }
      if (src.lat === 41.402994 && src.lon === -4.325894) {
        sameCoordSegoviaCount++;
      }
    }

    expect(movistarCount).toBe(5239);
    expect(orangeCount).toBe(2832);
    expect(vodafoneCount).toBe(1220);
    expect(fase1Count).toBe(7330);
    expect(fase2Count).toBe(1961);
    expect(declaredCount).toBe(realMatch.declaredRealAntennasById.size);
    // Ambas ubicaciones oficiales en la misma coordenada exacta (Cuéllar y Espirdo) se conservan intactas
    expect(sameCoordSegoviaCount).toBe(2);
  }, 15_000);

  it('expone la opción Coordenadas UNICO 5G (9.291 ubicaciones) en el menú de capas cartográficas y conecta la capa WebGL en AntenasMap, WorkspaceProvider y MapaView', async () => {
    const [
      antenasMapSource,
      mapOverlaysSource,
      workspaceProviderSource,
      useWorkspaceSource,
      mapaViewSource,
      mapCssSource,
    ] = await Promise.all([
      readDiskTextFile('../components/map/AntenasMap.tsx'),
      readDiskTextFile('../components/map/MapOverlays.tsx'),
      readDiskTextFile('./WorkspaceProvider.tsx'),
      readDiskTextFile('./useWorkspace.ts'),
      readDiskTextFile('../views/MapaView.tsx'),
      readDiskTextFile('../styles/map.css'),
    ]);

    // 1. MapOverlays: interruptor #map-unico-projects-option dentro del menú de Capas cartográficas
    expect(mapOverlaysSource).toContain('id="map-unico-projects-option"');
    expect(mapOverlaysSource).toContain('Coordenadas UNICO 5G');
    expect(mapOverlaysSource).toContain('ubicaciones');
    expect(mapOverlaysSource).toContain('is-unico-coords-active');
    expect(mapOverlaysSource).toContain('is-unico-coords-on');
    expect(
      mapOverlaysSource.indexOf('id="map-highlight-unico-option"'),
    ).toBeLessThan(mapOverlaysSource.indexOf('id="map-unico-projects-option"'));
    expect(
      mapOverlaysSource.indexOf('id="map-unico-projects-option"'),
    ).toBeLessThan(mapOverlaysSource.indexOf('id="map-lock-3d-option"'));

    const overlaysHtml = renderToStaticMarkup(
      createElement(MapOverlays, {
        styleId: 'osm',
        onStyleChange: () => {},
        showUnicoProjects: true,
        onToggleShowUnicoProjects: () => {},
        unicoProjectsCount: 9291,
        onFlyToRegion: () => {},
      }),
    );
    expect(overlaysHtml).toContain('id="map-style-switcher-btn"');

    // 2. WorkspaceProvider + useWorkspace + MapaView: estado por defecto false y paso de las 9.291 ubicaciones
    expect(useWorkspaceSource).toContain('showUnicoProjects: boolean;');
    expect(useWorkspaceSource).toContain('toggleShowUnicoProjects: () => void;');
    expect(workspaceProviderSource).toContain(
      'const [showUnicoProjects, setShowUnicoProjects] = useState<boolean>(false);',
    );
    expect(mapaViewSource).toContain('unicoProjects={unicoDataset?.antenas}');
    expect(mapaViewSource).toContain('unicoDeclaredMasks={unicoDeclaredMasks}');
    expect(mapaViewSource).toContain('showUnicoProjects={showUnicoProjects}');
    expect(mapaViewSource).toContain(
      'onToggleShowUnicoProjects={toggleShowUnicoProjects}',
    );

    // 3. AntenasMap: fuente sin clustering, capa WebGL sobre antenas y bajo selección, recarga de estilo y ajuste en medición
    expect(antenasMapSource).toContain(
      "const UNICO_PROJECTS_SOURCE_ID = 'unico-projects-source';",
    );
    expect(antenasMapSource).toContain(
      "const LAYER_UNICO_PROJECTS = 'unico-projects-points';",
    );
    expect(antenasMapSource).toContain(
      'const [internalShowUnicoProjects, setInternalShowUnicoProjects] =\n    useState<boolean>(false);',
    );
    expect(
      antenasMapSource.indexOf('id: LAYER_UNCLUSTERED_MULTI,'),
    ).toBeLessThan(antenasMapSource.indexOf('id: LAYER_UNICO_PROJECTS,'));
    expect(
      antenasMapSource.indexOf('id: LAYER_UNICO_PROJECTS,'),
    ).toBeLessThan(antenasMapSource.indexOf('id: LAYER_SELECTED_HALO,'));
    expect(antenasMapSource).toContain('registerAllUnicoProjectSprites(map)');
    expect(antenasMapSource).toContain(
      "'icon-anchor': UNICO_PROJECT_ICON_ANCHOR",
    );
    expect(antenasMapSource).toContain('UNICO_PROJECT_ICON_OFFSET');
    expect(antenasMapSource).toContain('UNICO_PIN_POPUP_OFFSET');
    expect(antenasMapSource).toContain('antenas-map-popup-interactive');
    expect(antenasMapSource).toContain('unicoProjectsCount={unicoProjects.length}');
    expect(UNICO_PROJECT_ICON_ANCHOR).toBe('bottom');
    expect(UNICO_PROJECT_ICON_OFFSET).toEqual([0, 4]);

    // 4. CSS: estilos del conmutador ámbar y del popup interactivo de coordenadas oficiales
    expect(mapCssSource).toContain('.map-lock-3d-option.is-unico-coords-active');
    expect(mapCssSource).toContain('.map-switch-pill.is-unico-coords-on');
    expect(mapCssSource).toContain('.antenas-map-popup-interactive.maplibregl-popup');
    expect(mapCssSource).toContain('.map-popup-unico-coord-badge');
    expect(mapCssSource).toContain('.map-popup-unico-coord-pin');
  });
});
