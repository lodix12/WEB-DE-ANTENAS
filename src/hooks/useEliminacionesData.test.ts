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
import { WorkspaceProvider } from './WorkspaceProvider';
import type {
  AntenasDataset,
  EliminacionRecord,
  EliminacionesDataset,
  LiveScanDeltaChunk,
} from '../types/antena';
import { EliminacionesView } from '../views/EliminacionesView';
import {
  buildDerivedAntenasStructures,
  mergeLiveDeltaIntoAntenasDataset,
  resolveLiveSelectedAntenna,
} from './useAntenasData';
import {
  computeLatestScanEliminacionesCounts,
  filterEliminaciones,
  isLatestScanEliminacion,
  mergeLiveDeltaIntoEliminacionesDataset,
  orderEliminacionesGroupedByRemovedAntenna,
  parseCustomEliminacionesJson,
} from './useEliminacionesData';
import { validateNovedadesSearch } from './useNovedadesData';
import {
  accumulateLiveDeltaChunks,
  parseLiveScanDeltaChunk,
  parseScanStatusPayload,
} from './useScanProgress';

function makeEliminacion(
  overrides: Partial<EliminacionRecord> &
    Pick<EliminacionRecord, 'id' | 'tipo' | 'codigo' | 'antennaId'>,
): EliminacionRecord {
  return {
    op: 'orange',
    opRaw: 'ORANGE ESPAGNE, S.A.U.',
    codigoBanda: '',
    frecuencia: '',
    ubicacion: 'MADRID',
    prov: 'MADRID',
    scannedAt: '2026-11-22T12:00:00Z',
    fecha: '22/11/2026 13:00:00',
    ...overrides,
  };
}

describe('Eliminaciones — Esquema JSON propio, agrupación, filtros y contadores', () => {
  it('parseCustomEliminacionesJson valida el formato propio y el baseline real en disco, y rechaza GeoJSON', async () => {
    const validDoc: EliminacionesDataset = {
      updatedAt: '2026-11-22T12:00:00Z',
      scanId: 'scan-10',
      previousScanAt: '2026-11-21T12:00:00Z',
      isBaselineScan: false,
      total: 2,
      antenasEliminadas: 1,
      frecuenciasEliminadas: 1,
      eliminaciones: [
        makeEliminacion({
          id: 'del-freq:OR-1:R1:758.00 - 768.00',
          tipo: 'frecuencia',
          codigo: '1',
          antennaId: 'OR-1',
          codigoBanda: 'R1',
          frecuencia: '758.00 - 768.00',
          lat: 40.4168,
          lon: -3.7038,
          scanId: 'scan-10',
        }),
        makeEliminacion({
          id: 'del-ant:OR-1',
          tipo: 'antena',
          codigo: '1',
          antennaId: 'OR-1',
          lat: 40.4168,
          lon: -3.7038,
          scanId: 'scan-10',
        }),
      ],
    };

    const parsed = parseCustomEliminacionesJson(validDoc);
    expect(parsed.total).toBe(2);
    // La antena eliminada debe quedar inmediatamente antes de su frecuencia asociada
    expect(parsed.eliminaciones.map((r) => r.id)).toEqual([
      'del-ant:OR-1',
      'del-freq:OR-1:R1:758.00 - 768.00',
    ]);
    expect(parsed.eliminaciones[0].lat).toBe(40.4168);
    expect(parsed.eliminaciones[0].lon).toBe(-3.7038);

    // Rechazo estricto de GeoJSON en raíz y en filas
    expect(() =>
      parseCustomEliminacionesJson({ type: 'FeatureCollection', features: [] }),
    ).toThrow(/GeoJSON/i);
    expect(() =>
      parseCustomEliminacionesJson({
        ...validDoc,
        eliminaciones: [
          {
            ...validDoc.eliminaciones[0],
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-3.7, 40.4] },
          },
        ],
      }),
    ).toThrow(/GeoJSON/i);

    // Validación directa del archivo real public/data/eliminaciones.json
    const fsSpecifier = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFileSync: (path: URL, encoding: string) => string;
    };
    const diskRaw = JSON.parse(
      readFileSync(
        new URL('../../public/data/eliminaciones.json', import.meta.url),
        'utf-8',
      ),
    ) as unknown;
    const diskParsed = parseCustomEliminacionesJson(diskRaw);
    expect(Array.isArray(diskParsed.eliminaciones)).toBe(true);
    expect(diskParsed.total).toBe(diskParsed.eliminaciones.length);
  });

  it('agrupa cada lote del más reciente al más antiguo intercalando cada antena eliminada seguida de sus frecuencias por MHz', () => {
    const rows: EliminacionRecord[] = [
      makeEliminacion({
        id: 'del-freq:OLD-1:R-OLD:811.00 - 821.00',
        tipo: 'frecuencia',
        codigo: 'OLD1',
        antennaId: 'OLD-1',
        codigoBanda: 'R-OLD',
        frecuencia: '811.00 - 821.00',
        scanId: 'scan-1',
        scannedAt: '2026-11-20T10:00:00Z',
        fecha: '20/11/2026 11:00:00',
      }),
      makeEliminacion({
        id: 'del-ant:OLD-1',
        tipo: 'antena',
        codigo: 'OLD1',
        antennaId: 'OLD-1',
        scanId: 'scan-1',
        scannedAt: '2026-11-20T10:00:00Z',
        fecha: '20/11/2026 11:00:00',
      }),
      makeEliminacion({
        id: 'del-freq:SURV-2:R-S:1830.00 - 1850.00',
        tipo: 'frecuencia',
        codigo: 'SURV2',
        antennaId: 'SURV-2',
        codigoBanda: 'R-S',
        frecuencia: '1830.00 - 1850.00',
        scanId: 'scan-2',
        scannedAt: '2026-11-22T12:00:00Z',
        fecha: '22/11/2026 13:00:00',
      }),
      makeEliminacion({
        id: 'del-freq:NEW-1:R-1800:1830.00 - 1850.00',
        tipo: 'frecuencia',
        codigo: 'NEW1',
        antennaId: 'NEW-1',
        codigoBanda: 'R-1800',
        frecuencia: '1830.00 - 1850.00',
        scanId: 'scan-2',
        scannedAt: '2026-11-22T12:00:00Z',
        fecha: '22/11/2026 13:00:00',
      }),
      makeEliminacion({
        id: 'del-ant:NEW-1',
        tipo: 'antena',
        codigo: 'NEW1',
        antennaId: 'NEW-1',
        scanId: 'scan-2',
        scannedAt: '2026-11-22T12:00:00Z',
        fecha: '22/11/2026 13:00:00',
      }),
      makeEliminacion({
        id: 'del-freq:NEW-1:R-700:758.00 - 768.00',
        tipo: 'frecuencia',
        codigo: 'NEW1',
        antennaId: 'NEW-1',
        codigoBanda: 'R-700',
        frecuencia: '758.00 - 768.00',
        scanId: 'scan-2',
        scannedAt: '2026-11-22T12:00:00Z',
        fecha: '22/11/2026 13:00:00',
      }),
    ];

    const ordered = orderEliminacionesGroupedByRemovedAntenna(rows);
    expect(ordered.map((r) => r.id)).toEqual([
      'del-ant:NEW-1',
      'del-freq:NEW-1:R-700:758.00 - 768.00',
      'del-freq:NEW-1:R-1800:1830.00 - 1850.00',
      'del-freq:SURV-2:R-S:1830.00 - 1850.00',
      'del-ant:OLD-1',
      'del-freq:OLD-1:R-OLD:811.00 - 821.00',
    ]);
  });

  it('filtra por tipo, operadora, banda, CCAA, provincia, fecha y búsqueda libre insensible a acentos', () => {
    const rows: EliminacionRecord[] = [
      makeEliminacion({
        id: 'del-ant:M1',
        tipo: 'antena',
        op: 'movistar',
        opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
        codigo: '1500001',
        antennaId: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 1500001',
        ubicacion: 'A CORUÑA',
        prov: 'A CORUÑA',
        scannedAt: '2026-11-22T12:00:00Z',
        fecha: '22/11/2026 13:00:00',
      }),
      makeEliminacion({
        id: 'del-freq:V1:VF-700:768.00 - 778.00',
        tipo: 'frecuencia',
        op: 'vodafone',
        opRaw: 'VODAFONE ESPAÑA, S.A.U.',
        codigo: '2800999',
        antennaId: 'VODAFONE ESPAÑA, S.A.U. - 2800999',
        codigoBanda: 'VF-700',
        frecuencia: '768.00 - 778.00',
        ubicacion: 'MADRID',
        prov: 'MADRID',
        scannedAt: '2026-11-21T10:00:00Z',
        fecha: '21/11/2026 11:00:00',
      }),
    ];

    expect(
      filterEliminaciones({
        eliminaciones: rows,
        tipoFilter: 'antena',
        operatorFilter: 'all',
        searchQuery: '',
      }).map((r) => r.id),
    ).toEqual(['del-ant:M1']);

    expect(
      filterEliminaciones({
        eliminaciones: rows,
        tipoFilter: 'all',
        operatorFilter: 'vodafone',
        bandFilter: '700 MHz',
        comunidadFilter: 'Comunidad de Madrid',
        provinceFilter: 'Madrid',
        dateFilter: '21/11/2026',
        searchQuery: 'retirada vf-700',
      }).map((r) => r.id),
    ).toEqual(['del-freq:V1:VF-700:768.00 - 778.00']);

    expect(
      filterEliminaciones({
        eliminaciones: rows,
        tipoFilter: 'all',
        operatorFilter: 'all',
        searchQuery: 'coruna baja telefonica',
      }).map((r) => r.id),
    ).toEqual(['del-ant:M1']);
  });

  it('computeLatestScanEliminacionesCounts e isLatestScanEliminacion contabilizan solo el último escaneo', () => {
    const dataset: EliminacionesDataset = {
      updatedAt: '2026-11-22T12:00:00Z',
      scanId: 'scan-2',
      previousScanAt: '2026-11-21T12:00:00Z',
      isBaselineScan: false,
      total: 4,
      antenasEliminadas: 2,
      frecuenciasEliminadas: 2,
      eliminaciones: [
        makeEliminacion({
          id: 'del-ant:LATEST-1',
          tipo: 'antena',
          op: 'orange',
          codigo: 'L1',
          antennaId: 'LATEST-1',
          scanId: 'scan-2',
          scannedAt: '2026-11-22T12:00:00Z',
        }),
        makeEliminacion({
          id: 'del-freq:LATEST-2:F1:811.00 - 821.00',
          tipo: 'frecuencia',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          codigo: 'L2',
          antennaId: 'LATEST-2',
          codigoBanda: 'F1',
          frecuencia: '811.00 - 821.00',
          scanId: 'scan-2',
          scannedAt: '2026-11-22T12:00:00Z',
        }),
        makeEliminacion({
          id: 'del-ant:HIST-1',
          tipo: 'antena',
          op: 'digi',
          opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
          codigo: 'H1',
          antennaId: 'HIST-1',
          scanId: 'scan-1',
          scannedAt: '2026-11-20T10:00:00Z',
        }),
        makeEliminacion({
          id: 'del-freq:HIST-1:D1:1870.00 - 1880.00',
          tipo: 'frecuencia',
          op: 'digi',
          opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
          codigo: 'H1',
          antennaId: 'HIST-1',
          codigoBanda: 'D1',
          frecuencia: '1870.00 - 1880.00',
          scanId: 'scan-1',
          scannedAt: '2026-11-20T10:00:00Z',
        }),
      ],
    };

    expect(isLatestScanEliminacion(dataset.eliminaciones[0], dataset)).toBe(true);
    expect(isLatestScanEliminacion(dataset.eliminaciones[2], dataset)).toBe(false);

    const counts = computeLatestScanEliminacionesCounts(dataset);
    expect(counts).toEqual({
      total: 2,
      antena: 1,
      frecuencia: 1,
      byOp: {
        movistar: 0,
        orange: 1,
        vodafone: 1,
        digi: 0,
        otros: 0,
      },
    });

    expect(
      computeLatestScanEliminacionesCounts({
        ...dataset,
        isBaselineScan: true,
      }).total,
    ).toBe(0);
  });
});

describe('Eliminaciones — Delta en vivo sobre antenas.json y eliminaciones.json', () => {
  it('parseLiveScanDeltaChunk valida removedAntennaIds y eliminaciones, rechaza GeoJSON y actualiza ambos datasets en vivo', () => {
    const status = parseScanStatusPayload({
      schemaVersion: 2,
      state: 'running',
      scanId: 'scan-live-2',
      trigger: 'workflow_dispatch',
      recordNovedades: true,
      part: '1/2',
      phase: 'frecuencias',
      startedAt: '2026-11-22T12:00:00Z',
      updatedAt: '2026-11-22T12:05:00Z',
      censusBoxesVisited: 239,
      estimatedCensusBoxes: 239,
      discoveredAntennas: 2,
      scannedAntennas: 1,
      totalAntennas: 2,
      percent: 50,
      deltaSeq: 2,
      chunkCount: 0,
      liveNewAntennasCount: 0,
      liveUpdatedAntennasCount: 1,
      liveNovedadesCount: 0,
      liveEliminacionesCount: 2,
      requestsPerSecond: 40,
    });
    expect(status?.liveEliminacionesCount).toBe(2);

    const rawChunk: LiveScanDeltaChunk = {
      schemaVersion: 2,
      scanId: 'scan-live-2',
      seq: 2,
      chunkIndex: 0,
      isTail: true,
      previousScanAt: '2026-11-21T12:00:00Z',
      recordNovedades: true,
      updatedAt: '2026-11-22T12:05:00Z',
      newAntennas: [],
      bandPatches: [],
      novedades: [],
      removedAntennaIds: ['ORANGE ESPAGNE, S.A.U. - GONE_1'],
      eliminaciones: [
        makeEliminacion({
          id: 'del-ant:ORANGE ESPAGNE, S.A.U. - GONE_1',
          tipo: 'antena',
          codigo: 'GONE_1',
          antennaId: 'ORANGE ESPAGNE, S.A.U. - GONE_1',
          lat: 40.41,
          lon: -3.7,
          scanId: 'scan-live-2',
          scannedAt: '2026-11-22T12:05:00Z',
        }),
        makeEliminacion({
          id: 'del-freq:ORANGE ESPAGNE, S.A.U. - GONE_1:OR-700:758.00 - 768.00',
          tipo: 'frecuencia',
          codigo: 'GONE_1',
          antennaId: 'ORANGE ESPAGNE, S.A.U. - GONE_1',
          codigoBanda: 'OR-700',
          frecuencia: '758.00 - 768.00',
          lat: 40.41,
          lon: -3.7,
          scanId: 'scan-live-2',
          scannedAt: '2026-11-22T12:05:00Z',
        }),
      ],
    };

    const parsedChunk = parseLiveScanDeltaChunk(rawChunk);
    expect(parsedChunk).toEqual(rawChunk);

    // GeoJSON incrustado en eliminaciones se rechaza lanzando error explícito
    expect(() =>
      parseLiveScanDeltaChunk({
        ...rawChunk,
        eliminaciones: [
          {
            ...rawChunk.eliminaciones![0],
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-3.7, 40.41] },
          },
        ],
      }),
    ).toThrow(/GeoJSON/i);

    const mergedDelta = accumulateLiveDeltaChunks([parsedChunk!], 'scan-live-2');
    expect(mergedDelta.removedAntennaIds.has('ORANGE ESPAGNE, S.A.U. - GONE_1')).toBe(
      true,
    );
    expect(mergedDelta.eliminaciones).toHaveLength(2);

    // 1) mergeLiveDeltaIntoAntenasDataset elimina la antena retirada del mapa y recalcula totales
    const baseAntenas: AntenasDataset = {
      updatedAt: '2026-11-21T12:00:00Z',
      sourceUrl: 'https://geoportal.minetur.gob.es/VCTEL/vcne.do',
      total: 2,
      crawlStats: {
        requestsCount: 1,
        durationSeconds: 1,
        gridBoxesVisited: 1,
        subdividedBoxes: 0,
        zoomParam: 7,
        delaySeconds: 0.02,
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
          name: 'Orange',
          count: 1,
          legalEntities: ['ORANGE ESPAGNE, S.A.U.'],
        },
        vodafone: {
          key: 'vodafone',
          name: 'Vodafone',
          count: 0,
          legalEntities: [],
        },
        digi: {
          key: 'digi',
          name: 'DIGI',
          count: 0,
          legalEntities: [],
        },
        otros: {
          key: 'otros',
          name: 'Otros',
          count: 0,
          legalEntities: [],
        },
      },
      provinces: [
        {
          provincia: 'MADRID',
          count: 2,
          byOperator: {
            movistar: 1,
            orange: 1,
            vodafone: 0,
            digi: 0,
            otros: 0,
          },
        },
      ],
      antenas: [
        {
          id: 'ORANGE ESPAGNE, S.A.U. - GONE_1',
          gid: 'GONE_1',
          op: 'orange',
          opRaw: 'ORANGE ESPAGNE, S.A.U.',
          lat: 40.41,
          lon: -3.7,
          dir: 'CL A',
          mun: 'MADRID',
          prov: 'MADRID',
          bandas: ['700 MHz'],
          frecuencias: ['758.00 - 768.00'],
        },
        {
          id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - KEEP_1',
          gid: 'KEEP_1',
          op: 'movistar',
          opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
          lat: 40.42,
          lon: -3.71,
          dir: 'CL B',
          mun: 'MADRID',
          prov: 'MADRID',
          bandas: ['800 MHz'],
          frecuencias: ['811.00 - 821.00'],
        },
      ],
    };

    const liveAntenas = mergeLiveDeltaIntoAntenasDataset(baseAntenas, mergedDelta);
    expect(liveAntenas.total).toBe(1);
    expect(liveAntenas.antenas.map((a) => a.id)).toEqual([
      'TELEFONICA MOVILES ESPAÑA, S.A.U. - KEEP_1',
    ]);
    expect(liveAntenas.operators.movistar.count).toBe(1);
    expect(liveAntenas.operators.orange.count).toBe(0);

    // 2) mergeLiveDeltaIntoEliminacionesDataset conserva el histórico y añade las nuevas bajas encima
    const baseElims: EliminacionesDataset = {
      updatedAt: '2026-11-21T12:00:00Z',
      scanId: 'scan-1',
      previousScanAt: '2026-11-20T12:00:00Z',
      isBaselineScan: false,
      total: 1,
      antenasEliminadas: 0,
      frecuenciasEliminadas: 1,
      eliminaciones: [
        makeEliminacion({
          id: 'del-freq:HIST:R0:945.00 - 955.00',
          tipo: 'frecuencia',
          codigo: 'HIST',
          antennaId: 'HIST',
          codigoBanda: 'R0',
          frecuencia: '945.00 - 955.00',
          scanId: 'scan-1',
          scannedAt: '2026-11-21T12:00:00Z',
        }),
      ],
    };

    const liveElims = mergeLiveDeltaIntoEliminacionesDataset(
      baseElims,
      mergedDelta,
    );
    expect(liveElims.scanId).toBe('scan-live-2');
    expect(liveElims.total).toBe(3);
    expect(liveElims.antenasEliminadas).toBe(1);
    expect(liveElims.frecuenciasEliminadas).toBe(2);
    expect(liveElims.eliminaciones.map((r) => r.id)).toEqual([
      'del-ant:ORANGE ESPAGNE, S.A.U. - GONE_1',
      'del-freq:ORANGE ESPAGNE, S.A.U. - GONE_1:OR-700:758.00 - 768.00',
      'del-freq:HIST:R0:945.00 - 955.00',
    ]);
  });
});

describe('Eliminaciones — Renderizado SSR de EliminacionesView y AppHeader', () => {
  it('renderiza enlace #nav-tab-eliminaciones con badge del último escaneo y enlaces inteligentes según estado de la antena', async () => {
    const antenasDataset: AntenasDataset = {
      updatedAt: '2026-11-22T12:00:00Z',
      sourceUrl: 'https://geoportal.minetur.gob.es/VCTEL/vcne.do',
      total: 1,
      crawlStats: {
        requestsCount: 1,
        durationSeconds: 1,
        gridBoxesVisited: 1,
        subdividedBoxes: 0,
        zoomParam: 7,
        delaySeconds: 0.02,
      },
      operators: {
        movistar: {
          key: 'movistar',
          name: 'Movistar (Telefónica)',
          count: 0,
          legalEntities: [],
        },
        orange: {
          key: 'orange',
          name: 'Orange',
          count: 0,
          legalEntities: [],
        },
        vodafone: {
          key: 'vodafone',
          name: 'Vodafone',
          count: 1,
          legalEntities: ['VODAFONE ESPAÑA, S.A.U.'],
        },
        digi: {
          key: 'digi',
          name: 'DIGI',
          count: 0,
          legalEntities: [],
        },
        otros: {
          key: 'otros',
          name: 'Otros',
          count: 0,
          legalEntities: [],
        },
      },
      provinces: [
        {
          provincia: 'VALENCIA',
          count: 1,
          byOperator: {
            movistar: 0,
            orange: 0,
            vodafone: 1,
            digi: 0,
            otros: 0,
          },
        },
      ],
      antenas: [
        {
          id: 'VODAFONE ESPAÑA, S.A.U. - ACTIVE_1',
          gid: 'ACTIVE_1',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          lat: 39.4699,
          lon: -0.3763,
          dir: 'AV PUERTO',
          mun: 'VALENCIA',
          prov: 'VALENCIA',
          bandas: ['700 MHz'],
          frecuencias: ['768.00 - 778.00'],
        },
      ],
    };

    const eliminacionesDataset: EliminacionesDataset = {
      updatedAt: '2026-11-22T12:00:00Z',
      scanId: 'scan-2',
      previousScanAt: '2026-11-21T12:00:00Z',
      isBaselineScan: false,
      total: 4,
      antenasEliminadas: 2,
      frecuenciasEliminadas: 2,
      eliminaciones: [
        // Antena eliminada CON coordenadas en el último escaneo -> enlace ?lat=...&lon=...
        makeEliminacion({
          id: 'del-ant:ORANGE ESPAGNE, S.A.U. - GONE_COORDS',
          tipo: 'antena',
          op: 'orange',
          codigo: 'GONE_COORDS',
          antennaId: 'ORANGE ESPAGNE, S.A.U. - GONE_COORDS',
          lat: 40.416775,
          lon: -3.70379,
          scanId: 'scan-2',
          scannedAt: '2026-11-22T12:00:00Z',
        }),
        // Frecuencia eliminada en antena aún activa -> enlace ?gid=ACTIVE_1&id=...
        makeEliminacion({
          id: 'del-freq:VODAFONE ESPAÑA, S.A.U. - ACTIVE_1:VF-800:842.00 - 852.00',
          tipo: 'frecuencia',
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          codigo: 'ACTIVE_1',
          antennaId: 'VODAFONE ESPAÑA, S.A.U. - ACTIVE_1',
          codigoBanda: 'VF-800',
          frecuencia: '842.00 - 852.00',
          ubicacion: 'VALENCIA',
          prov: 'VALENCIA',
          lat: 39.4699,
          lon: -0.3763,
          scanId: 'scan-2',
          scannedAt: '2026-11-22T12:00:00Z',
        }),
        // Antena eliminada SIN coordenadas en un escaneo histórico -> span estático (no cuenta en badge del último escaneo)
        makeEliminacion({
          id: 'del-ant:DIGI SPAIN TELECOM, S.L.U. - HIST_NOCOORDS',
          tipo: 'antena',
          op: 'digi',
          opRaw: 'DIGI SPAIN TELECOM, S.L.U.',
          codigo: 'HIST_NOCOORDS',
          antennaId: 'DIGI SPAIN TELECOM, S.L.U. - HIST_NOCOORDS',
          scanId: 'scan-1',
          scannedAt: '2026-11-20T10:00:00Z',
          fecha: '20/11/2026 11:00:00',
        }),
      ],
    };

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['antenas-dataset'], antenasDataset);
    queryClient.setQueryData(['eliminaciones-dataset'], eliminacionesDataset);
    queryClient.setQueryData(['novedades-dataset'], {
      updatedAt: '2026-11-22T12:00:00Z',
      scanId: 'scan-2',
      previousScanAt: '2026-11-21T12:00:00Z',
      isBaselineScan: true,
      total: 0,
      antenasNuevas: 0,
      frecuenciasNuevas: 0,
      novedades: [],
    });

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
      component: () => createElement('div', null, 'Novedades'),
    });
    const testElim = createRoute({
      getParentRoute: () => testRoot,
      path: '/eliminaciones',
      validateSearch: validateNovedadesSearch,
      component: EliminacionesView,
    });
    const testStats = createRoute({
      getParentRoute: () => testRoot,
      path: '/estadisticas',
      component: () => createElement('div', null, 'Estadisticas'),
    });

    const testRouter = createRouter({
      routeTree: testRoot.addChildren([testMap, testNov, testElim, testStats]),
      history: createMemoryHistory({ initialEntries: ['/eliminaciones'] }),
    });
    await testRouter.load();

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(RouterProvider, { router: testRouter }),
      ),
    );

    // 1) AppHeader contiene #nav-tab-eliminaciones con badge = 2 (solo scan-2, no el histórico)
    const navMatch = html.match(
      /<a[^>]*id="nav-tab-eliminaciones"[^>]*>([\s\S]*?)<\/a>/,
    );
    expect(navMatch).not.toBeNull();
    expect(navMatch?.[1]).toContain('Eliminaciones');
    expect(navMatch?.[1]).toMatch(
      /<span class="nav-tab-badge is-eliminaciones mono"[^>]*>2<\/span>/,
    );

    // 2) Encabezado, KPIs del último escaneo (1 antena eliminada, 1 frecuencia eliminada) y tabla #eliminaciones-table
    expect(html).toContain('<h1 class="page-h1">Eliminaciones</h1>');
    expect(html).toContain('id="eliminaciones-table"');
    expect(html).toContain(
      '<div class="metric-cell"><span class="metric-label">Antenas eliminadas</span><span class="metric-value">1</span></div>',
    );
    expect(html).toContain(
      '<div class="metric-cell"><span class="metric-label">Frecuencias eliminadas</span><span class="metric-value">1</span></div>',
    );

    // 3) Enlace de antena retirada con coordenadas -> eliminaciones-code-coords-link con lat y lon
    expect(html).toContain('eliminaciones-code-coords-link');
    expect(html).toContain('lat=40.416775');
    expect(html).toContain('lon=-3.70379');

    // 4) Enlace de antena aún activa -> gid=ACTIVE_1
    expect(html).toContain('gid=ACTIVE_1');

    // 5) Antena retirada sin coordenadas -> span estático
    expect(html).toContain(
      '<span class="eliminaciones-code-static mono" title="Antena retirada de MINETUR">HIST_NOCOORDS</span>',
    );
  });

  it('restaura filtros desde la URL en /eliminaciones y muestra estado vacío limpio en línea base', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['eliminaciones-dataset'], {
      updatedAt: '2026-11-22T12:00:00Z',
      scanId: 'baseline-scan',
      previousScanAt: null,
      isBaselineScan: true,
      total: 0,
      antenasEliminadas: 0,
      frecuenciasEliminadas: 0,
      eliminaciones: [],
    });

    const testRoot = createRootRoute({
      component: () => createElement(WorkspaceProvider, null, createElement(Outlet)),
    });
    const testMap = createRoute({
      getParentRoute: () => testRoot,
      path: '/',
      component: () => createElement('div', null, 'Mapa'),
    });
    const testElim = createRoute({
      getParentRoute: () => testRoot,
      path: '/eliminaciones',
      validateSearch: validateNovedadesSearch,
      component: EliminacionesView,
    });

    const testRouter = createRouter({
      routeTree: testRoot.addChildren([testMap, testElim]),
      history: createMemoryHistory({
        initialEntries: ['/eliminaciones?op=vodafone&tipo=frecuencia&q=valencia'],
      }),
    });
    await testRouter.load();

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(RouterProvider, { router: testRouter }),
      ),
    );

    expect(html).toContain(
      '0 eliminaciones registradas todavía (línea base activa)',
    );
    expect(html).toContain('value="valencia"');
    expect(html).toContain('id="eliminaciones-reset-filters-btn"');
  });

  it('elimina antenas y frecuencias retiradas de mapa, estadísticas derivadas y selección activa sin cruzar operadores por GID', () => {
    const baseDataset: AntenasDataset = {
      updatedAt: '2026-11-22T12:00:00Z',
      sourceUrl: 'https://geoportal.minetur.gob.es/VCTEL/vcne.do',
      total: 3,
      crawlStats: {
        requestsCount: 1,
        durationSeconds: 1,
        gridBoxesVisited: 1,
        subdividedBoxes: 0,
        zoomParam: 7,
        delaySeconds: 0.02,
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
          name: 'Orange',
          count: 1,
          legalEntities: ['ORANGE ESPAGNE, S.A.U.'],
        },
        vodafone: {
          key: 'vodafone',
          name: 'Vodafone',
          count: 1,
          legalEntities: ['VODAFONE ESPAÑA, S.A.U.'],
        },
        digi: { key: 'digi', name: 'DIGI', count: 0, legalEntities: [] },
        otros: { key: 'otros', name: 'Otros', count: 0, legalEntities: [] },
      },
      provinces: [
        {
          provincia: 'MADRID',
          count: 2,
          byOperator: { movistar: 1, orange: 1 },
        },
        {
          provincia: 'SEVILLA',
          count: 1,
          byOperator: { vodafone: 1 },
        },
      ],
      antenas: [
        {
          id: 'ORANGE ESPAGNE, S.A.U. - SHARED_77',
          gid: 'SHARED_77',
          op: 'orange',
          opRaw: 'ORANGE ESPAGNE, S.A.U.',
          lat: 40.41,
          lon: -3.7,
          dir: 'CL A',
          mun: 'MADRID',
          prov: 'MADRID',
          bandas: ['700 MHz', '3500 MHz'],
          frecuencias: ['758.00 - 768.00', '3600.00 - 3710.00'],
          concesiones: [
            { ref: 'OR-700', freq: '758.00 - 768.00' },
            { ref: 'OR-3500', freq: '3600.00 - 3710.00' },
          ],
          bandsScannedAt: '2026-11-22T12:00:00Z',
        },
        {
          id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - SHARED_77',
          gid: 'SHARED_77',
          op: 'movistar',
          opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
          lat: 40.41,
          lon: -3.7,
          dir: 'CL A',
          mun: 'MADRID',
          prov: 'MADRID',
          bandas: ['800 MHz', '1800 MHz'],
          frecuencias: ['852.00 - 862.00', '1805.10 - 1825.10'],
          concesiones: [
            { ref: 'MV-800', freq: '852.00 - 862.00' },
            { ref: 'MV-1800', freq: '1805.10 - 1825.10' },
          ],
          bandsScannedAt: '2026-11-22T12:00:00Z',
        },
        {
          id: 'VODAFONE ESPAÑA, S.A.U. - 9001',
          gid: '9001',
          mergedGids: ['9001', 'SHARED_77'],
          op: 'vodafone',
          opRaw: 'VODAFONE ESPAÑA, S.A.U.',
          lat: 37.38,
          lon: -5.99,
          dir: 'CL S',
          mun: 'SEVILLA',
          prov: 'SEVILLA',
          bandas: ['900 MHz'],
          frecuencias: ['945.00 - 955.00'],
          concesiones: [{ ref: 'VF-900', freq: '945.00 - 955.00' }],
          bandsScannedAt: '2026-11-22T12:00:00Z',
        },
      ],
    };

    const chunk: LiveScanDeltaChunk = {
      schemaVersion: 2,
      scanId: 'scan-cleanup-1',
      seq: 1,
      chunkIndex: 0,
      isTail: true,
      previousScanAt: '2026-11-22T12:00:00Z',
      recordNovedades: true,
      updatedAt: '2026-11-23T12:00:00Z',
      newAntennas: [],
      // Movistar pierde 1800 MHz (queda solo 800 MHz); ese parche en SHARED_77 NO debe contaminar a Vodafone
      bandPatches: [
        {
          id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - SHARED_77',
          gid: 'SHARED_77',
          bandas: ['800 MHz'],
          frecuencias: ['852.00 - 862.00'],
          concesiones: [{ ref: 'MV-800', freq: '852.00 - 862.00' }],
          bandsScannedAt: '2026-11-23T12:00:00Z',
        },
      ],
      novedades: [],
      // Orange desaparece por completo de MINETUR
      removedAntennaIds: ['ORANGE ESPAGNE, S.A.U. - SHARED_77'],
      eliminaciones: [],
    };

    const mergedDelta = accumulateLiveDeltaChunks([chunk], 'scan-cleanup-1');
    const updatedDataset = mergeLiveDeltaIntoAntenasDataset(
      baseDataset,
      mergedDelta,
    );
    const derived = buildDerivedAntenasStructures(updatedDataset);

    // 1) Estadísticas y mapa ya no cuentan la antena de Orange retirada ni la banda 1800 MHz retirada de Movistar
    expect(updatedDataset.total).toBe(2);
    expect(derived.operatorCounts.orange).toBe(0);
    expect(derived.operatorCounts.movistar).toBe(1);
    expect(derived.operatorCounts.vodafone).toBe(1);
    expect(derived.provincesByCount.find((p) => p.provincia === 'MADRID')?.count).toBe(1);

    const bandCounts = Object.fromEntries(
      derived.availableBands.map((b) => [b.band, b.count]),
    );
    expect(bandCounts['N28']).toBe(0);
    expect(bandCounts['N78']).toBe(0);
    expect(bandCounts['B3']).toBe(0);
    expect(bandCounts['B20']).toBe(1);
    expect(bandCounts['G9']).toBe(1);

    // 2) Vodafone (con mergedGids incluyendo SHARED_77) NO se contamina con el parche de Movistar
    const vodaAfter = derived.byId.get('VODAFONE ESPAÑA, S.A.U. - 9001');
    expect(vodaAfter?.bandas).toEqual(['900 MHz']);

    // 3) resolveLiveSelectedAntenna devuelve null para la antena retirada (sin saltar a Movistar con mismo GID)
    const removedOrange = baseDataset.antenas[0];
    expect(resolveLiveSelectedAntenna(removedOrange, derived)).toBeNull();

    // 4) Para una antena que sigue activa pero perdió una frecuencia, devuelve el registro actualizado
    const oldMovistar = baseDataset.antenas[1];
    const liveMovistar = resolveLiveSelectedAntenna(oldMovistar, derived);
    expect(liveMovistar?.id).toBe(oldMovistar.id);
    expect(liveMovistar?.bandas).toEqual(['800 MHz']);
    expect(liveMovistar?.frecuencias).toEqual(['852.00 - 862.00']);
  });
});

