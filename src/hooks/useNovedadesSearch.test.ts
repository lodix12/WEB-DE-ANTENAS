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
import type {
  AntenasDataset,
  NovedadRecord,
  NovedadesDataset,
} from '../types/antena';
import { NovedadesView } from '../views/NovedadesView';
import {
  DEFAULT_NOVEDADES_PAGE_SIZE,
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
        banda: '3500 MHz',
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
      banda: '3500 MHz',
      ccaa: 'Andalucía',
      prov: 'SEVILLA',
      fecha: '18/11/2026',
      q: '4100012',
      filas: 50,
      pagina: 4,
    });
  });

  it('serializa y reconstruye con fidelidad total cualquier combinación de filtros, filas y página a través de TanStack Router', () => {
    const state: NovedadesTableViewState = {
      tipoFilter: 'frecuencia',
      operatorFilter: 'vodafone',
      bandFilter: '3500 MHz',
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
      banda: '3500 MHz',
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

    // Estado por defecto debe producir URL limpia sin parámetros redundantes
    const defaultState = resolveNovedadesTableStateFromSearch({});
    expect(serializeNovedadesTableStateToSearch(defaultState)).toEqual({});
  });

  it('restaura en NovedadesView exactamente los filtros activos, filas por página y página exacta desde la URL al volver del mapa', async () => {
    const dataset = createPaginatedNovedadesDataset();
    const search = serializeNovedadesTableStateToSearch({
      tipoFilter: 'frecuencia',
      operatorFilter: 'vodafone',
      bandFilter: '3500 MHz',
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
    expect(html).toMatch(
      /<option value="3500 MHz" selected="">3500 MHz<\/option>/,
    );
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
});
