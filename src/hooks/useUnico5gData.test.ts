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
import { UNICO_OPERATOR_ORDER, type UnicoDataset } from '../types/unico5g';
import { Unico5gView } from '../views/Unico5gView';
import { WorkspaceProvider } from './WorkspaceProvider';
import {
  UNICO_5G_QUERY_KEY,
  buildUnico5gCsvContent,
  buildUnicoCascadeOptions,
  buildUnicoSearchIndex,
  computeUnicoAnalytics,
  filterUnicoAntennas,
  formatUnicoPercent,
  normalizeUnicoOperatorInput,
  parseCustomUnico5gJson,
  validateUnico5gSearch,
} from './useUnico5gData';

async function loadRealUnicoDatasetFromDisk(): Promise<UnicoDataset> {
  const fsSpecifier = 'node:fs';
  const { readFileSync } = (await import(/* @vite-ignore */ fsSpecifier)) as {
    readFileSync: (path: URL, encoding: string) => string;
  };
  const rawJson = JSON.parse(
    readFileSync(
      new URL('../../public/data/unico-5g.json', import.meta.url),
      'utf-8',
    ),
  ) as unknown;
  return parseCustomUnico5gJson(rawJson);
}

describe('UNICO 5G — Datos Fase 1 (>7.000 descomprimidos) y Fase 2, agrupación Orange, filtros y cero rankings', () => {
  it('valida public/data/unico-5g.json con 7.330 antenas en Fase 1 + 1.961 en Fase 2 (9.291 totales), sin códigos de emplazamiento ni ID de propietario', async () => {
    const dataset = await loadRealUnicoDatasetFromDisk();

    expect(dataset.fase1Total).toBe(7330);
    expect(dataset.fase2Total).toBe(1961);
    expect(dataset.total).toBe(9291);
    expect(dataset.antenas.length).toBe(9291);

    // Agrupación de todos los proyectos de Orange dentro de Orange
    expect(
      normalizeUnicoOperatorInput(
        'UTE ORANGE ESPAGNE Y ORANGE COMUNICACIONES FIJAS',
      ),
    ).toBe('orange');
    expect(normalizeUnicoOperatorInput('ORANGE ESPAGNE S.A.')).toBe('orange');

    const orange = dataset.operators.orange;
    expect(orange.fase1).toBe(1505);
    expect(orange.fase2).toBe(845); // 445 UTE + 400 Orange Espagne
    expect(orange.total).toBe(2350);
    expect(orange.proyectosFase2).toBe(23);

    // Ningún registro ni exportación CSV contiene código de emplazamiento ni id de propietario
    const sampleCsv = buildUnico5gCsvContent(dataset.antenas.slice(0, 25));
    expect(sampleCsv).not.toMatch(/emplazamiento/i);
    expect(sampleCsv).not.toMatch(/propietario/i);
    expect(sampleCsv).not.toMatch(/0000000-\d+/);

    // Rechaza formato GeoJSON o campos prohibidos
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
  });

  it('filtra en cascada por Fase 1/2, Comunidad Autónoma, Provincia, Municipio y Operador manteniendo orden A–Z sin rankings', async () => {
    const dataset = await loadRealUnicoDatasetFromDisk();
    const searchIndex = buildUnicoSearchIndex(dataset.antenas);

    // Cascada de Comunidades Autónomas (17 CCAA ordenadas A–Z)
    const cascadeAll = buildUnicoCascadeOptions(dataset, {
      fase: 'all',
      operators: [...UNICO_OPERATOR_ORDER],
      ccaa: '',
      prov: '',
    });
    expect(cascadeAll.comunidades.length).toBe(17);
    expect(cascadeAll.provincias.length).toBe(50);

    const ccaaNames = cascadeAll.comunidades.map((c) => c.ccaa);
    const sortedCcaaNames = [...ccaaNames].sort((a, b) =>
      a.localeCompare(b, 'es'),
    );
    expect(ccaaNames).toEqual(sortedCcaaNames);

    // Filtrar Galicia en Fase 2 solo para Orange
    const galiciaOrangeF2 = filterUnicoAntennas(dataset.antenas, searchIndex, {
      fase: '2',
      operators: ['orange'],
      ccaa: 'Galicia',
      prov: '',
      mun: '',
      query: '',
    });
    // A Coruña (67) + Lugo (108) + Ourense (57) + Pontevedra (91 UTE) = 323
    expect(galiciaOrangeF2.length).toBe(323);

    const analyticsGlobal = computeUnicoAnalytics(dataset, dataset.antenas);
    expect(analyticsGlobal.totalSelected).toBe(9291);
    expect(formatUnicoPercent(analyticsGlobal.fase1Selected, 9291)).toBe(
      '78,9 %',
    );
    expect(formatUnicoPercent(analyticsGlobal.fase2Selected, 9291)).toBe(
      '21,1 %',
    );

    // Verificar orden no competitivo (sin rankings): operadores en orden fijo y CCAA en orden A–Z
    expect(analyticsGlobal.operatorStats.map((o) => o.key)).toEqual([
      ...UNICO_OPERATOR_ORDER,
    ]);
    const analyticsCcaas = analyticsGlobal.comunidadesAlpha.map((c) => c.ccaa);
    expect(analyticsCcaas).toEqual(sortedCcaaNames);
  });

  it('renderiza SSR de AppHeader y Unico5gView con estadísticas, porcentajes y filtros sin rankings ni códigos excluidos', async () => {
    const dataset = await loadRealUnicoDatasetFromDisk();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(UNICO_5G_QUERY_KEY, dataset);

    const rootRoute = createRootRoute({
      component: () =>
        createElement(
          'div',
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
    const unicoRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/unico-5g',
      validateSearch: validateUnico5gSearch,
      component: Unico5gView,
    });

    const memoryRouter = createRouter({
      routeTree: rootRoute.addChildren([mapStubRoute, unicoRoute]),
      history: createMemoryHistory({ initialEntries: ['/unico-5g'] }),
    });
    await memoryRouter.load();

    const html = renderToStaticMarkup(
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

    expect(html).toContain('UNICO 5G');
    expect(html).toContain('9.291');
    expect(html).toContain('7.330');
    expect(html).toContain('1.961');
    expect(html).toContain('Orange');
    expect(html).toContain('Comunidad Autónoma');
    expect(html).toContain('Provincia');
    expect(html).not.toMatch(/id de propietario/i);
    expect(html).not.toMatch(/código de emplazamiento/i);
    expect(html).not.toMatch(/operador líder/i);
    expect(html).not.toMatch(/ranking/i);
  });
});
