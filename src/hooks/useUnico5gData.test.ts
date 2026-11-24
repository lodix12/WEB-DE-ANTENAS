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
import type { AntenasDataset, AntennaRecord } from '../types/antena';
import {
  UNICO_DECLARED_BAND_TABS,
  UNICO_OPERATOR_ORDER,
  type UnicoAntennaRecord,
  type UnicoDataset,
} from '../types/unico5g';
import { Unico5gView } from '../views/Unico5gView';
import { WorkspaceProvider } from './WorkspaceProvider';
import {
  buildDerivedAntenasStructures,
  parseCustomAntenasJson,
} from './useAntenasData';
import {
  UNICO_5G_QUERY_KEY,
  UNICO_BIT_N28,
  UNICO_BIT_N28_PLUS,
  UNICO_BIT_N78,
  UNICO_COMUNIDAD_LIST,
  UNICO_DECLARED_ANY_MASK,
  UNICO_MAX_MATCH_DISTANCE_KM,
  UNICO_PROVINCE_LABELS,
  bandFilterToMask,
  computeUnicoSimpleSummary,
  formatUnicoInt,
  formatUnicoPercent,
  isUnicoOperatorKey,
  matchUnicoDeclaredAntennasMasks,
  normalizeUnicoOperatorInput,
  parseCustomUnico5gJson,
  validateUnico5gSearch,
} from './useUnico5gData';

async function readDiskJsonFile(relativeUrlPath: string): Promise<unknown> {
  const fsSpecifier = 'node:fs';
  const { readFileSync } = (await import(/* @vite-ignore */ fsSpecifier)) as {
    readFileSync: (path: URL, encoding: string) => string;
  };
  return JSON.parse(
    readFileSync(new URL(relativeUrlPath, import.meta.url), 'utf-8'),
  ) as unknown;
}

let cachedUnicoDataset: UnicoDataset | null = null;

async function loadRealUnicoDatasetFromDisk(): Promise<UnicoDataset> {
  if (!cachedUnicoDataset) {
    const raw = await readDiskJsonFile('../../public/data/unico-5g.json');
    cachedUnicoDataset = parseCustomUnico5gJson(raw);
  }
  return cachedUnicoDataset;
}

async function loadRealAntenasDatasetFromDisk(): Promise<AntenasDataset> {
  const raw = await readDiskJsonFile('../../public/data/antenas.json');
  return parseCustomAntenasJson(raw);
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

describe('UNICO 5G — Agrupación unificada Orange+Avatel, cruce espacial a 1.000 m (N28/N28+/N78) y vista simplificada sin tablas ni rankings', () => {
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

  it('cruza la antena real más cercana de la misma operadora <= 1.000 m con bandas N28 / N28+ / N78 y filtra por banda, fase, provincia y comunidad', () => {
    expect(UNICO_MAX_MATCH_DISTANCE_KM).toBe(1.0);
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
      // Caso 2: Fuera del radio de 1.000 m (~1.279 m -> lat + 0.0115) aunque tenga N78 + N28 -> NO declarada (mask === 0)
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
      // Caso 3: La estación real más cercana de la misma operadora (~150 m) SOLO tiene 4G (B20 + B3),
      // aunque exista una segunda estación de esa misma operadora a ~700 m con N78 -> NO declarada (mask === 0)
      makeUnicoAntenna({
        id: 'u-case3-closest-only-4g',
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
      // Caso 2 (~1.279 m > 1.000 m): Movistar con N78 y N28 fuera de rango
      makeRealAntenna({
        id: 'MV-2-FAR',
        gid: '2001',
        op: 'movistar',
        lat: 40.4 + 0.0115,
        lon: -1.4,
        frecuencias: ['758.00 - 768.00', '3600.00 - 3700.00'],
      }),
      // Caso 3a (~150 m): Movistar más cercana solo con B20 (800) + B3 (1800)
      makeRealAntenna({
        id: 'MV-3-CLOSEST-4G',
        gid: '3001',
        op: 'movistar',
        lat: 41.85 + 0.00135,
        lon: -1.92,
        frecuencias: ['791.00 - 801.00', '1805.00 - 1825.00'],
      }),
      // Caso 3b (~700 m): Segunda Movistar más lejana con N78 (ignorada por no ser la más cercana)
      makeRealAntenna({
        id: 'MV-3-SECOND-5G',
        gid: '3002',
        op: 'movistar',
        lat: 41.85 + 0.0063,
        lon: -1.92,
        frecuencias: ['3600.00 - 3700.00'],
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
    expect(masks[4]).toBe(0);
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
    expect(summaryAll.totalDeclared).toBe(3);
    expect(summaryAll.pctDeclaredGlobal).toBeCloseTo(50, 5);
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
      { key: 'movistar', total: 3, declared: 1 },
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
    expect(summaryOnlyN78.totalDeclared).toBe(1);
    expect(
      summaryOnlyN78.byOperator.find((o) => o.key === 'movistar')?.declared,
    ).toBe(1);
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
    expect(summaryFase2.totalAntennas).toBe(3); // u-case1-n28, u-case3-closest-only-4g, u-case4-other-op
    expect(summaryFase2.totalDeclared).toBe(1);

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
  });

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

    // Tarjeta 1: Antenas por operadora (Movistar, Orange, Vodafone; nunca Avatel)
    expect(html).toContain('Antenas por operadora');
    expect(html).toContain('Movistar');
    expect(html).toContain('Orange');
    expect(html).toContain('Vodafone');
    expect(html).not.toContain('Avatel');
    expect(html).not.toMatch(/avatel/i);

    // Tarjeta 2: Declaradas por operadora y pestañas de banda RF 5G
    expect(html).toContain('Declaradas por operadora');
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
});
