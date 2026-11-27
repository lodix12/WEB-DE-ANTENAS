import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  defaultParseSearch,
  defaultStringifySearch,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import routerRawSource from '../router.tsx?raw';
import novedadesViewRawSource from '../views/NovedadesView.tsx?raw';
import type {
  AntenasDataset,
  NovedadRecord,
  NovedadesDataset,
} from '../types/antena';
import { NovedadesView } from '../views/NovedadesView';
import { ALL_RF_BAND_CODES } from './useAntenasData';
import {
  STANDARD_ELIMINACIONES_BANDS,
  validateEliminacionesSearch,
} from './useEliminacionesData';
import {
  DEFAULT_NOVEDADES_PAGE_SIZE,
  STANDARD_NOVEDADES_BANDS,
  classifyNovedadFrequencyBandCode,
  filterNovedades,
  normalizeNovedadesBandFilter,
  resolveNovedadesTableStateFromSearch,
  serializeNovedadesTableStateToSearch,
  validateNovedadesSearch,
  type NovedadesTableViewState,
} from './useNovedadesData';

function createMinimalAntenasDataset(): AntenasDataset {
  return {
    updatedAt: '2026-11-18T18:00:00Z',
    sourceUrl: 'https://geoportal.minetur.gob.es/VCTEL/vcne.do',
    total: 1,
    crawlStats: {
      requestsCount: 1,
      durationSeconds: 1,
      gridBoxesVisited: 1,
      subdividedBoxes: 0,
      zoomParam: 12,
      delaySeconds: 0,
    },
    operators: {
      movistar: { key: 'movistar', name: 'Movistar', count: 0, legalEntities: [] },
      orange: { key: 'orange', name: 'Orange', count: 0, legalEntities: [] },
      vodafone: { key: 'vodafone', name: 'Vodafone', count: 1, legalEntities: ['VODAFONE ESPAÑA, S.A.U.'] },
      digi: { key: 'digi', name: 'DIGI', count: 0, legalEntities: [] },
      otros: { key: 'otros', name: 'Otros', count: 0, legalEntities: [] },
    },
    provinces: [
      {
        provincia: 'Sevilla',
        count: 1,
        byOperator: { vodafone: 1 },
      },
    ],
    antenas: [
      {
        id: 'VODAFONE ESPAÑA, S.A.U. - 4100001',
        gid: '4100001',
        op: 'vodafone',
        opRaw: 'VODAFONE ESPAÑA, S.A.U.',
        lat: 37.3891,
        lon: -5.9845,
        dir: 'AV. DE LA CONSTITUCION, 1',
        mun: 'SEVILLA',
        prov: 'Sevilla',
        bandas: ['3500 MHz'],
        frecuencias: ['3460.00 - 3560.00'],
      },
    ],
  };
}

function createPaginatedNovedadesDataset(): NovedadesDataset {
  const rows: NovedadRecord[] = [];

  // 25 filas de frecuencia Vodafone 3500 MHz en Sevilla el 18/11/2026 con código 4100001..4100025
  for (let i = 1; i <= 25; i++) {
    const code = `410${String(i).padStart(4, '0')}`;
    const seconds = String(59 - i).padStart(2, '0');
    rows.push({
      id: `nov-vf-${i}`,
      tipo: 'frecuencia',
      op: 'vodafone',
      opRaw: 'VODAFONE ESPAÑA, S.A.U.',
      codigo: code,
      antennaId: `VODAFONE ESPAÑA, S.A.U. - ${code}`,
      codigoBanda: `VF-N78-${String(i).padStart(3, '0')}`,
      frecuencia: '3460.00 - 3560.00 MHz',
      ubicacion: 'SEVILLA',
      prov: 'Sevilla',
      scanId: 'scan-2026-11-18',
      scannedAt: `2026-11-18T17:00:${seconds}Z`,
      fecha: `18/11/2026 18:00:${seconds}`,
    });
  }

  // 10 filas adicionales de antena nueva Movistar en Madrid el 17/11/2026
  for (let i = 1; i <= 10; i++) {
    const code = `280${String(i).padStart(4, '0')}`;
    const seconds = String(40 - i).padStart(2, '0');
    rows.push({
      id: `nov-mv-${i}`,
      tipo: 'antena',
      op: 'movistar',
      opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
      codigo: code,
      antennaId: `TELEFONICA MOVILES ESPAÑA, S.A.U. - ${code}`,
      codigoBanda: '',
      frecuencia: '',
      ubicacion: 'MADRID',
      prov: 'Madrid',
      scanId: 'scan-2026-11-17',
      scannedAt: `2026-11-17T17:00:${seconds}Z`,
      fecha: `17/11/2026 18:00:${seconds}`,
    });
  }

  return {
    updatedAt: '2026-11-18T17:05:00Z',
    scanId: 'scan-2026-11-18',
    previousScanAt: '2026-11-17T17:05:00Z',
    total: rows.length,
    antenasNuevas: 10,
    frecuenciasNuevas: 25,
    novedades: rows,
  };
}

async function renderNovedadesAtUrl(
  initialEntry: string,
  dataset: NovedadesDataset,
): Promise<string> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(['novedades-dataset'], dataset);
  queryClient.setQueryData(['antenas-dataset'], createMinimalAntenasDataset());
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
    validateSearch: validateNovedadesSearch,
    component: NovedadesView,
  });

  const testRouter = createRouter({
    routeTree: testRoot.addChildren([testMap, testNov]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
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

describe('Persistencia en URL de filtros y paginación en NovedadesView', () => {
  it('valida, normaliza y omite valores por defecto o inválidos en validateNovedadesSearch', () => {
    expect(validateNovedadesSearch({})).toEqual({});

    expect(
      validateNovedadesSearch({
        tipo: 'all',
        op: 'all',
        banda: 'all',
        ccaa: 'all',
        prov: 'all',
        fecha: 'all',
        q: '',
        filas: DEFAULT_NOVEDADES_PAGE_SIZE,
        pagina: 1,
      }),
    ).toEqual({});

    expect(
      validateNovedadesSearch({
        tipo: 'invalido',
        op: 'desconocido',
        banda: '9999 MHz',
        fecha: '2026-11-18',
        filas: 33,
        pagina: 0,
      }),
    ).toEqual({});

    expect(
      validateNovedadesSearch({
        tipo: 'frecuencia',
        op: 'masmovil',
        banda: 'N78',
        ccaa: 'Andalucía',
        prov: 'Sevilla',
        fecha: '18/11/2026',
        q: 4100012,
        filas: '50',
        pagina: '4',
      }),
    ).toEqual({
      tipo: 'frecuencia',
      op: 'orange',
      banda: 'N78',
      ccaa: 'Andalucía',
      prov: 'SEVILLA',
      fecha: '18/11/2026',
      q: '4100012',
      filas: 50,
      pagina: 4,
    });

    // Normaliza alias heredados en MHz/GHz y minúsculas/espacios en códigos RF
    expect(validateNovedadesSearch({ banda: '3500 MHz' })).toEqual({
      banda: 'N78',
    });
    expect(validateNovedadesSearch({ banda: '26 GHz' })).toEqual({
      banda: 'N258',
    });
    expect(validateNovedadesSearch({ banda: 'n28+' })).toEqual({
      banda: 'N28+',
    });
    expect(validateNovedadesSearch({ banda: 'b7 +' })).toEqual({
      banda: 'B7+',
    });
  });

  it('serializa y reconstruye con fidelidad total cualquier combinación de filtros, filas y página a través de TanStack Router', () => {
    const state: NovedadesTableViewState = {
      tipoFilter: 'frecuencia',
      operatorFilter: 'vodafone',
      bandFilter: 'N78',
      comunidadFilter: 'Andalucía',
      provinceFilter: 'SEVILLA',
      dateFilter: '18/11/2026',
      searchQuery: '41000',
      pageSize: 10,
      page: 3,
    };

    const searchObj = serializeNovedadesTableStateToSearch(state);
    expect(searchObj).toEqual({
      tipo: 'frecuencia',
      op: 'vodafone',
      banda: 'N78',
      ccaa: 'Andalucía',
      prov: 'SEVILLA',
      fecha: '18/11/2026',
      q: '41000',
      filas: 10,
      pagina: 3,
    });

    const queryString = defaultStringifySearch(searchObj);
    const parsedFromUrl = defaultParseSearch(queryString);
    const restored = resolveNovedadesTableStateFromSearch(parsedFromUrl);
    expect(restored).toEqual(state);

    // Roundtrip exacto para las 11 opciones de banda RF del Mapa, incluidas N28+ y B7+
    for (const bandCode of ALL_RF_BAND_CODES) {
      const bandState: NovedadesTableViewState = {
        ...state,
        bandFilter: bandCode,
      };
      const serialized = serializeNovedadesTableStateToSearch(bandState);
      expect(serialized.banda).toBe(bandCode);
      const roundtripped = resolveNovedadesTableStateFromSearch(
        defaultParseSearch(defaultStringifySearch(serialized)),
      );
      expect(roundtripped.bandFilter).toBe(bandCode);
    }

    // Estado por defecto debe producir URL limpia sin parámetros redundantes
    const defaultState = resolveNovedadesTableStateFromSearch({});
    expect(serializeNovedadesTableStateToSearch(defaultState)).toEqual({});
  });

  it('restaura en NovedadesView exactamente los filtros activos, filas por página y página exacta desde la URL al volver del mapa', async () => {
    const dataset = createPaginatedNovedadesDataset();
    const search = serializeNovedadesTableStateToSearch({
      tipoFilter: 'frecuencia',
      operatorFilter: 'vodafone',
      bandFilter: 'N78',
      comunidadFilter: 'Andalucía',
      provinceFilter: 'SEVILLA',
      dateFilter: '18/11/2026',
      searchQuery: '41000',
      pageSize: 10,
      page: 2,
    });
    const url = `/novedades${defaultStringifySearch(search)}`;
    const html = await renderNovedadesAtUrl(url, dataset);

    // Filtros activos restaurados en los controles de la interfaz
    expect(html).toContain('id="novedades-reset-filters-btn"');
    expect(html).toMatch(
      /id="novedades-filter-frecuencias"[^>]*is-active[^>]*aria-pressed="true"/,
    );
    expect(html).toMatch(
      /id="novedades-op-chip-vodafone"[^>]*is-active[^>]*aria-pressed="true"/,
    );
    expect(html).toMatch(/id="novedades-search-input"[^>]*value="41000"/);
    expect(html).toMatch(/<option value="N78" selected="">N78<\/option>/);
    expect(html).toMatch(
      /<option value="18\/11\/2026" selected="">18\/11\/2026<\/option>/,
    );
    expect(html).toMatch(
      /<option value="Andalucía" selected="">Andalucía<\/option>/,
    );
    expect(html).toMatch(
      /<option value="SEVILLA" selected="">SEVILLA<\/option>/,
    );
    expect(html).toMatch(/<option value="10" selected="">10<\/option>/);

    // Página 2 exacta restaurada: filas 11–20 de las 25 coincidencias (no página 1 ni página 3)
    expect(html).toContain('11–20');
    expect(html).toContain('4100011');
    expect(html).toContain('4100020');
    expect(html).not.toContain('4100001');
    expect(html).not.toContain('4100021');
    expect(html).not.toContain('2800001');

    // Control de página activa e input "Ir a página" reflejan página 2
    expect(html).toMatch(
      /aria-label="Ir a la página 2" aria-current="page">2<\/button>/,
    );
    expect(html).toMatch(/id="novedades-page-input"[^>]*value="2"/);
  });

  it('restaura una página concreta sin filtros activos y acota páginas fuera de rango de forma segura', async () => {
    const dataset = createPaginatedNovedadesDataset();

    // Página 3 sin filtros (35 filas totales, 10 por página => filas 21–30: 5 Vodafone + 5 Movistar)
    const page3Html = await renderNovedadesAtUrl(
      '/novedades?filas=10&pagina=3',
      dataset,
    );
    expect(page3Html).not.toContain('id="novedades-reset-filters-btn"');
    expect(page3Html).toContain('21–30');
    expect(page3Html).toContain('4100021');
    expect(page3Html).toContain('2800005');
    expect(page3Html).not.toContain('4100001');
    expect(page3Html).not.toContain('2800006');
    expect(page3Html).toMatch(
      /aria-label="Ir a la página 3" aria-current="page">3<\/button>/,
    );

    // Página fuera de rango (99) se acota limpiamente a la última página válida (4)
    const clampedHtml = await renderNovedadesAtUrl(
      '/novedades?filas=10&pagina=99',
      dataset,
    );
    expect(clampedHtml).toContain('31–35');
    expect(clampedHtml).toMatch(
      /aria-label="Ir a la página 4" aria-current="page">4<\/button>/,
    );
  });

  it('configura el router principal con scrollRestoration y validación de búsqueda en /novedades', () => {
    expect(routerRawSource).toContain('validateSearch: validateNovedadesSearch');
    expect(routerRawSource).toContain('scrollRestoration: true');

    const root = createRootRoute({ component: Outlet });
    const nov = createRoute({
      getParentRoute: () => root,
      path: '/novedades',
      validateSearch: validateNovedadesSearch,
      component: NovedadesView,
    });
    const memRouter = createRouter({
      routeTree: root.addChildren([nov]),
      history: createMemoryHistory({ initialEntries: ['/novedades'] }),
      scrollRestoration: true,
    });
    const built = memRouter.buildLocation({
      to: '/novedades',
      search: {
        op: 'vodafone',
        ccaa: 'Andalucía',
        filas: 50,
        pagina: 3,
      },
    });
    expect(built.pathname).toBe('/novedades');
    expect(built.search).toEqual({
      op: 'vodafone',
      ccaa: 'Andalucía',
      filas: 50,
      pagina: 3,
    });
  });

  it('no realiza ningún desplazamiento automático al cambiar de página en la tabla de novedades', () => {
    expect(novedadesViewRawSource).not.toContain('scrollTableTopIfNeeded');
    expect(novedadesViewRawSource).toContain('resetScroll: false');
    expect(novedadesViewRawSource).toContain(
      'inputEl.focus({ preventScroll: true })',
    );

    const goToPageMatch = novedadesViewRawSource.match(
      /function goToPage\([\s\S]*?\n  \}/,
    );
    expect(goToPageMatch).not.toBeNull();
    expect(goToPageMatch![0]).not.toMatch(/scroll/i);

    const pageSizeMatch = novedadesViewRawSource.match(
      /function handlePageSizeChange\([\s\S]*?\n  \}/,
    );
    expect(pageSizeMatch).not.toBeNull();
    expect(pageSizeMatch![0]).not.toMatch(/scroll/i);
  });
});

describe('Filtro de bandas en Novedades con las mismas 11 opciones que el Mapa', () => {
  function createAll11BandsNovedadesRows(): NovedadRecord[] {
    const cases: Array<{ id: string; codigo: string; freq: string }> = [
      { id: 'r-n28', codigo: '1001', freq: '758.00 - 768.00 MHz' },
      { id: 'r-n28-plus', codigo: '1002', freq: '758.00 - 788.00 MHz' },
      { id: 'r-b20', codigo: '1003', freq: '852.00 - 862.00 MHz' },
      { id: 'r-g9', codigo: '1004', freq: '935.10 - 949.90 MHz' },
      { id: 'r-b3', codigo: '1005', freq: '1855.10 - 1879.90 MHz' },
      { id: 'r-b1', codigo: '1006', freq: '2120.00 - 2140.00 MHz' },
      { id: 'r-b38', codigo: '1007', freq: '2575.00 - 2595.00 MHz' },
      { id: 'r-b7', codigo: '1008', freq: '2620.00 - 2640.00 MHz' },
      { id: 'r-b7-plus', codigo: '1009', freq: '2680.00 - 2690.00 MHz' },
      { id: 'r-n78', codigo: '1010', freq: '3460.00 - 3600.00 MHz' },
      { id: 'r-n258', codigo: '1011', freq: '25.70 - 26.70 MHz' },
    ];

    const rows: NovedadRecord[] = cases.map((item, idx) => ({
      id: item.id,
      tipo: 'frecuencia',
      op: 'movistar',
      opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
      codigo: item.codigo,
      antennaId: `TELEFONICA MOVILES ESPAÑA, S.A.U. - ${item.codigo}`,
      codigoBanda: `REF-${idx + 1}`,
      frecuencia: item.freq,
      ubicacion: 'MADRID',
      prov: 'MADRID',
      scanId: 'scan-11-bands',
      scannedAt: `2026-11-26T10:00:${String(10 + idx).padStart(2, '0')}Z`,
      fecha: `26/11/2026 11:00:${String(10 + idx).padStart(2, '0')}`,
    }));

    rows.push({
      id: 'r-antena',
      tipo: 'antena',
      op: 'movistar',
      opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
      codigo: '1099',
      antennaId: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 1099',
      codigoBanda: '',
      frecuencia: '',
      ubicacion: 'MADRID',
      prov: 'MADRID',
      scanId: 'scan-11-bands',
      scannedAt: '2026-11-26T10:00:59Z',
      fecha: '26/11/2026 11:00:59',
    });

    return rows;
  }

  it('expone en #novedades-band-filter exactamente las mismas 11 opciones en el mismo orden que el Mapa', async () => {
    expect(STANDARD_NOVEDADES_BANDS).toEqual(ALL_RF_BAND_CODES);
    expect(STANDARD_NOVEDADES_BANDS).toEqual([
      'N28',
      'N28+',
      'B20',
      'G9',
      'B3',
      'B1',
      'B38',
      'B7',
      'B7+',
      'N78',
      'N258',
    ]);

    const dataset = createPaginatedNovedadesDataset();
    const html = await renderNovedadesAtUrl('/novedades', dataset);
    const selectMatch = html.match(
      /<select[^>]*id="novedades-band-filter"[^>]*>([\s\S]*?)<\/select>/,
    );
    expect(selectMatch).not.toBeNull();

    const options = Array.from(
      (selectMatch?.[1] ?? '').matchAll(
        /<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g,
      ),
      (m) => ({ value: m[1], label: m[2] }),
    );

    expect(options).toEqual([
      { value: 'all', label: 'Todas las bandas' },
      ...ALL_RF_BAND_CODES.map((code) => ({ value: code, label: code })),
    ]);

    // No deben quedar opciones heredadas en MHz/GHz dentro del desplegable de Novedades
    expect(selectMatch?.[1]).not.toContain('700 MHz');
    expect(selectMatch?.[1]).not.toContain('2600 MHz');
    expect(selectMatch?.[1]).not.toContain('3500 MHz');
    expect(selectMatch?.[1]).not.toContain('26 GHz');
  });

  it('filtra estrictamente cada una de las 11 bandas RF separando N28/N28+ y B38/B7/B7+ igual que el Mapa', async () => {
    const rows = createAll11BandsNovedadesRows();

    const expectedByBand: Record<(typeof ALL_RF_BAND_CODES)[number], string[]> = {
      N28: ['r-n28'],
      'N28+': ['r-n28-plus'],
      B20: ['r-b20'],
      G9: ['r-g9'],
      B3: ['r-b3'],
      B1: ['r-b1'],
      B38: ['r-b38'],
      B7: ['r-b7'],
      'B7+': ['r-b7-plus'],
      N78: ['r-n78'],
      N258: ['r-n258'],
    };

    for (const bandCode of ALL_RF_BAND_CODES) {
      const filtered = filterNovedades({
        novedades: rows,
        tipoFilter: 'all',
        operatorFilter: 'all',
        bandFilter: bandCode,
        searchQuery: '',
      });
      expect(filtered.map((r) => r.id)).toEqual(expectedByBand[bandCode]);
    }

    // Búsqueda libre por códigos RF sin colisiones entre N28/N28+, B3/B38 y B7/B7+
    const bySearch = (q: string) =>
      filterNovedades({
        novedades: rows,
        tipoFilter: 'all',
        operatorFilter: 'all',
        searchQuery: q,
      }).map((r) => r.id);

    expect(bySearch('N28')).toEqual(['r-n28']);
    expect(bySearch('N28+')).toEqual(['r-n28-plus']);
    expect(bySearch('B3')).toEqual(['r-b3']);
    expect(bySearch('B38')).toEqual(['r-b38']);
    expect(bySearch('B7')).toEqual(['r-b7']);
    expect(bySearch('B7+')).toEqual(['r-b7-plus']);
    expect(bySearch('N258')).toEqual(['r-n258']);

    // Renderizado SSR con banda con signo '+' (N28+ y B7+) desde URL
    const dataset: NovedadesDataset = {
      updatedAt: '2026-11-26T10:05:00Z',
      scanId: 'scan-11-bands',
      previousScanAt: '2026-11-25T10:05:00Z',
      total: rows.length,
      antenasNuevas: 1,
      frecuenciasNuevas: 11,
      novedades: rows,
    };

    const n28PlusUrl = `/novedades${defaultStringifySearch({ banda: 'N28+' })}`;
    const n28PlusHtml = await renderNovedadesAtUrl(n28PlusUrl, dataset);
    expect(n28PlusHtml).toMatch(/<option value="N28\+" selected="">N28\+<\/option>/);
    expect(n28PlusHtml).toContain('1002');
    expect(n28PlusHtml).not.toContain('1001');

    const b7PlusUrl = `/novedades${defaultStringifySearch({ banda: 'B7+' })}`;
    const b7PlusHtml = await renderNovedadesAtUrl(b7PlusUrl, dataset);
    expect(b7PlusHtml).toMatch(/<option value="B7\+" selected="">B7\+<\/option>/);
    expect(b7PlusHtml).toContain('1009');
    expect(b7PlusHtml).not.toContain('1008');
    expect(b7PlusHtml).not.toContain('1007');
  });

  it('clasifica el 100 % de las frecuencias reales de public/data/novedades.json en los 11 códigos RF del Mapa y mantiene intacto Eliminaciones', async () => {
    const fsSpecifier = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFileSync: (path: URL, encoding: string) => string;
    };
    const rawDataset = JSON.parse(
      readFileSync(
        new URL('../../public/data/novedades.json', import.meta.url),
        'utf-8',
      ),
    ) as NovedadesDataset;

    const validCodes = new Set<string>(ALL_RF_BAND_CODES);
    let freqCount = 0;
    for (const row of rawDataset.novedades) {
      if (row.tipo !== 'frecuencia') continue;
      freqCount += 1;
      const code = classifyNovedadFrequencyBandCode(row.frecuencia);
      expect(code, `Frecuencia sin clasificar: ${row.frecuencia}`).not.toBeNull();
      expect(validCodes.has(code!)).toBe(true);
    }
    expect(freqCount).toBeGreaterThan(0);

    // Normalizador de Novedades rechaza valores inválidos y mantiene Eliminaciones independiente
    expect(normalizeNovedadesBandFilter('9999 MHz')).toBeNull();
    expect(normalizeNovedadesBandFilter('1500 MHz')).toBeNull();
    expect(STANDARD_ELIMINACIONES_BANDS).toContain('700 MHz');
    expect(validateEliminacionesSearch({ banda: '700 MHz' })).toEqual({
      banda: '700 MHz',
    });
  });
});
