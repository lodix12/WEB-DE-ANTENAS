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
import type { CnmcDatasetPayload, CnmcNormalizedRecord } from '../types/cnmc';
import {
  CNMC_LOCAL_CACHE_KEY,
  fetchCnmcAnnualDataset,
  fetchCnmcDatastoreRecords,
  parseCnmcStoredPayload,
  resolveCnmcAnnualResource,
  type FetchLike,
} from '../utils/cnmcApi';
import { CnmcView } from '../views/CnmcView';
import { WorkspaceProvider } from './WorkspaceProvider';
import {
  CNMC_ANNUAL_QUERY_KEY,
  buildCnmcCsvContent,
  buildCnmcJsonExportPayload,
  buildCnmcSeriesView,
  clampYearRange,
  getMetricAvailableYears,
  validateCnmcSearch,
} from './useCnmcData';

async function readDiskJsonFile(relativeUrlPath: string): Promise<unknown> {
  const fsSpecifier = 'node:fs';
  const { readFileSync } = (await import(/* @vite-ignore */ fsSpecifier)) as {
    readFileSync: (path: URL, encoding: string) => string;
  };
  return JSON.parse(
    readFileSync(new URL(relativeUrlPath, import.meta.url), 'utf-8'),
  ) as unknown;
}

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

function makeJsonResponse(
  body: unknown,
  status = 200,
): Pick<Response, 'ok' | 'status' | 'statusText' | 'json'> {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  };
}

let cachedFallbackDataset: CnmcDatasetPayload | null = null;

async function loadRealFallbackFromDisk(): Promise<CnmcDatasetPayload> {
  if (!cachedFallbackDataset) {
    const raw = await readDiskJsonFile('../../public/data/cnmc-anual.json');
    cachedFallbackDataset = parseCnmcStoredPayload(raw, 'fallback');
  }
  return cachedFallbackDataset;
}

describe('CNMC API CKAN en 2 pasos y cadena de respaldo', () => {
  it('resuelve el recurso datastore activo en el Paso 1 y pagina correctamente en el Paso 2', async () => {
    const calls: string[] = [];
    const fakeFetch: FetchLike = async (url) => {
      calls.push(url);
      if (url.includes('package_search')) {
        return makeJsonResponse({
          success: true,
          result: {
            count: 2,
            results: [
              {
                name: 'ds_old',
                title: 'Telecomunicaciones Anual Datos Generales',
                version: '15.0',
                metadata_modified: '2025-06-01T00:00:00',
                extras: [
                  { key: 'estado', value: 'borrador' },
                  { key: 'idTipoDataSetBD', value: '203' },
                ],
                resources: [{ id: 'old-id', format: 'CSV', datastore_active: true }],
              },
              {
                name: 'ds_24233_1',
                title: 'Telecomunicaciones Anual Datos Generales',
                version: '16.0',
                metadata_modified: '2026-06-22T07:11:00',
                license_title: 'Creative Commons Attribution Share-Alike 4.0',
                license_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
                extras: [
                  { key: 'estado', value: 'publicado' },
                  { key: 'idTipoDataSetBD', value: '203' },
                  { key: 'periodo', value: '1997 - 2025' },
                  { key: 'modified', value: '2026-06-22' },
                  { key: 'novedad', value: 'Se incorporan los datos de 2025.' },
                ],
                resources: [
                  { id: 'xml-id', format: 'XML', datastore_active: false },
                  {
                    id: 'res-active-2025',
                    format: 'CSV',
                    datastore_active: true,
                    url: 'https://catalogodatos.cnmc.es/datastore/dump/res-active-2025',
                  },
                ],
              },
            ],
          },
        });
      }
      if (url.includes('datastore_search') && url.includes('offset=0')) {
        return makeJsonResponse({
          success: true,
          result: {
            total: 3,
            records: [
              {
                anno: '2024',
                tipo_de_mercado: 'Servicio minorista',
                operador: 'Movistar',
                concepto: 'Ingresos',
                unidades: 'Millones de euros',
                ingresos_por_operador: 8500,
              },
              {
                anno: '2025',
                tipo_de_mercado: 'Servicio minorista',
                operador: 'Movistar',
                concepto: 'Ingresos',
                unidades: 'Millones de euros',
                ingresos_por_operador: 8712.71,
              },
            ],
          },
        });
      }
      if (url.includes('datastore_search') && url.includes('offset=2')) {
        return makeJsonResponse({
          success: true,
          result: {
            total: 3,
            records: [
              {
                anno: '2025',
                tipo_de_mercado: 'Servicio minorista',
                operador: 'DIGI',
                concepto: 'Ingresos',
                unidades: 'Millones de euros',
                ingresos_por_operador: 950.25,
              },
            ],
          },
        });
      }
      return makeJsonResponse({}, 404);
    };

    const meta = await resolveCnmcAnnualResource(fakeFetch);
    expect(meta.resourceId).toBe('res-active-2025');
    expect(meta.version).toBe('16.0');
    expect(meta.periodo).toBe('1997 - 2025');

    const { records, totalRecords } = await fetchCnmcDatastoreRecords(
      meta.resourceId,
      fakeFetch,
      { pageLimit: 2 },
    );
    expect(totalRecords).toBe(3);
    expect(records).toHaveLength(3);
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain('offset=0');
    expect(calls[2]).toContain('offset=2');
  });

  it('guarda en caché local tras lectura en directo y cae al respaldo estático si CNMC no responde', async () => {
    const storage = new MemoryStorage();
    const realFallbackRaw = await readDiskJsonFile(
      '../../public/data/cnmc-anual.json',
    );

    const failingLiveFetch: FetchLike = async (url) => {
      if (url.startsWith('https://catalogodatos.cnmc.es/')) {
        return makeJsonResponse({ success: false }, 503);
      }
      if (url === './data/cnmc-anual.json') {
        return makeJsonResponse(realFallbackRaw, 200);
      }
      return makeJsonResponse({}, 404);
    };

    const fallbackResult = await fetchCnmcAnnualDataset({
      fetchImpl: failingLiveFetch,
      storage,
      fallbackUrl: './data/cnmc-anual.json',
    });

    expect(fallbackResult.source).toBe('fallback');
    expect(fallbackResult.liveError).toContain('HTTP 503');
    expect(fallbackResult.records.length).toBeGreaterThan(1300);

    // Ahora simulamos una carga en directo exitosa con un nuevo año 2026
    const live2026Fetch: FetchLike = async (url) => {
      if (url.includes('package_search')) {
        return makeJsonResponse({
          success: true,
          result: {
            results: [
              {
                name: 'ds_25000_1',
                title: 'Telecomunicaciones Anual Datos Generales',
                version: '17.0',
                metadata_modified: '2027-06-20T09:00:00',
                extras: [
                  { key: 'estado', value: 'publicado' },
                  { key: 'idTipoDataSetBD', value: '203' },
                  { key: 'periodo', value: '1997 - 2026' },
                  { key: 'modified', value: '2027-06-20' },
                ],
                resources: [
                  { id: 'res-2026', format: 'CSV', datastore_active: true },
                ],
              },
            ],
          },
        });
      }
      if (url.includes('datastore_search')) {
        return makeJsonResponse({
          success: true,
          result: {
            total: 1,
            records: [
              {
                anno: '2026',
                tipo_de_mercado: 'Servicio minorista',
                operador: 'Movistar',
                concepto: 'Ingresos',
                unidades: 'Millones de euros',
                ingresos_por_operador: 9100,
              },
            ],
          },
        });
      }
      return makeJsonResponse({}, 404);
    };

    const liveResult = await fetchCnmcAnnualDataset({
      fetchImpl: live2026Fetch,
      storage,
    });
    expect(liveResult.source).toBe('live');
    expect(liveResult.metadata.version).toBe('17.0');
    expect(storage.getItem(CNMC_LOCAL_CACHE_KEY)).not.toBeNull();

    // Si vuelve a caer CNMC, debe preferir la caché local (2027) frente al respaldo estático antiguo (2026)
    const cachePreferred = await fetchCnmcAnnualDataset({
      fetchImpl: failingLiveFetch,
      storage,
      fallbackUrl: './data/cnmc-anual.json',
    });
    expect(cachePreferred.source).toBe('cache');
    expect(cachePreferred.metadata.version).toBe('17.0');
    expect(cachePreferred.records[0].anno).toBe(2026);
  });
});

describe('CNMC respaldo real (public/data/cnmc-anual.json) y motor de agregación fiel', () => {
  it('valida el respaldo real y conserva los datos exactos de la CNMC sin agrupaciones artificiales', async () => {
    const dataset = await loadRealFallbackFromDisk();
    expect(dataset.records).toHaveLength(1324);
    expect(dataset.metadata.datasetName).toBe('ds_24233_1');
    expect(dataset.metadata.periodo).toBe('1997 - 2025');

    // Ingresos por operador en 2025 (total minorista + mayorista)
    const ingOpView = buildCnmcSeriesView(dataset.records, {
      metric: 'ingresos_por_operador',
      market: 'all',
      fromYear: 2020,
      toYear: 2025,
    });
    expect(ingOpView.years).toEqual([2020, 2021, 2022, 2023, 2024, 2025]);
    expect(ingOpView.kpis.endTotal).toBeCloseTo(35670.49, 2);

    // Verificar fidelidad exacta: Orange, Grupo MASMOVIL y MASORANGE permanecen separados tal cual publica la CNMC
    const seriesKeys = ingOpView.allSeries.map((s) => s.key);
    expect(seriesKeys).toContain('Orange');
    expect(seriesKeys).toContain('Grupo MASMOVIL');
    expect(seriesKeys).toContain('MASORANGE');

    const orangeSeries = ingOpView.allSeries.find((s) => s.key === 'Orange')!;
    const masorangeSeries = ingOpView.allSeries.find(
      (s) => s.key === 'MASORANGE',
    )!;
    expect(orangeSeries.points.find((p) => p.year === 2024)?.value).toBeCloseTo(
      1778.92 + 3788.3,
      2,
    );
    expect(orangeSeries.points.find((p) => p.year === 2025)?.value).toBeNull();
    expect(
      masorangeSeries.points.find((p) => p.year === 2024)?.value,
    ).toBeNull();
    expect(
      masorangeSeries.points.find((p) => p.year === 2025)?.value,
    ).toBeCloseTo(2066.01 + 6518.33, 2);

    // Filtro minorista exacto en 2025
    const minoristaView = buildCnmcSeriesView(dataset.records, {
      metric: 'ingresos_por_operador',
      market: 'minorista',
      fromYear: 2023,
      toYear: 2025,
    });
    expect(minoristaView.kpis.endTotal).toBeCloseTo(24698.53, 2);

    // Paquetes en 2025
    const paquetesView = buildCnmcSeriesView(dataset.records, {
      metric: 'paquetes',
      market: 'all',
      fromYear: 2015,
      toYear: 2025,
    });
    expect(paquetesView.kpis.endTotal).toBe(18291625);

    // Inversiones en 1998..2025 incluyendo registros N/A (1998..2005)
    const inversionesView = buildCnmcSeriesView(dataset.records, {
      metric: 'inversiones_por_operador',
      market: 'all',
    });
    expect(inversionesView.fromYear).toBe(1998);
    expect(inversionesView.toYear).toBe(2025);
    expect(inversionesView.kpis.endTotal).toBeCloseTo(6073.85, 2);
    expect(inversionesView.totalPoints[0].value).toBeCloseTo(4581.86, 2);

    // Sin doble conteo en las 2 filas duales del año 2000 (ingresos vs ingresos_por_operador)
    const ing2000 = buildCnmcSeriesView(dataset.records, {
      metric: 'ingresos',
      market: 'all',
      fromYear: 2000,
      toYear: 2000,
    });
    expect(ing2000.kpis.endTotal).toBeCloseTo(20147 + 4636, 2);
  });

  it('soporta nuevos años y operadores futuros dinámicamente, recorte de rangos, Base 100 y exportación CSV/JSON', async () => {
    const dataset = await loadRealFallbackFromDisk();
    const futureRecord: CnmcNormalizedRecord = {
      anno: 2026,
      tipoDeMercado: 'Servicio minorista',
      concepto: 'Ingresos',
      operador: 'NuevoOperador2026',
      tipoDeIngreso: 'N/A',
      tipoDePaquete: 'N/A',
      unidades: 'Millones de euros',
      ingresos: null,
      ingresos_por_operador: 500,
      empleados_por_operador: null,
      paquetes: null,
      inversiones_por_operador: null,
      gastos_por_operador: null,
    };

    const extended = [...dataset.records, futureRecord];
    const years = getMetricAvailableYears(
      extended,
      'ingresos_por_operador',
      'minorista',
    );
    expect(years[years.length - 1]).toBe(2026);

    // clampYearRange intercambia años invertidos y recorta a los límites reales
    expect(clampYearRange(2030, 1990, [2000, 2025, 2026])).toEqual({
      fromYear: 2000,
      toYear: 2026,
    });

    const view = buildCnmcSeriesView(extended, {
      metric: 'ingresos_por_operador',
      market: 'minorista',
      fromYear: 2020,
      toYear: 2026,
    });
    expect(view.allSeries.some((s) => s.key === 'NuevoOperador2026')).toBe(true);

    // Base 100 para Movistar arranca en exactamente 100 en 2020
    const movistar = view.allSeries.find((s) => s.key === 'Movistar')!;
    expect(movistar.points[0].indexedValue).toBeCloseTo(100, 4);

    // Exportación CSV y JSON
    const csv = buildCnmcCsvContent(view);
    expect(csv.startsWith('\uFEFFAño;')).toBe(true);
    expect(csv).toContain('2025;');

    const exportedJson = buildCnmcJsonExportPayload(view, dataset);
    expect(exportedJson.parametro).toBe('ingresos_por_operador');
    expect(exportedJson.rangoAnual).toEqual({ inicio: 2020, fin: 2026 });
    expect(exportedJson.totalSector.length).toBe(view.years.length);
  });

  it('valida parámetros de búsqueda URL para #/cnmc', () => {
    expect(
      validateCnmcSearch({
        metric: 'paquetes',
        from: '2015',
        to: 2025,
        market: 'minorista',
        chart: 'indexed',
        series: 'Movistar|DIGI',
        total: '0',
      }),
    ).toEqual({
      metric: 'paquetes',
      from: 2015,
      to: 2025,
      market: 'minorista',
      chart: 'indexed',
      series: 'Movistar|DIGI',
      total: '0',
    });

    expect(
      validateCnmcSearch({
        metric: 'invalido',
        from: 'abc',
        to: 1800,
        market: 'otro',
        chart: 'pie',
      }),
    ).toEqual({});
  });
});

describe('CNMC — Renderizado SSR de AppHeader (#nav-tab-cnmc) y CnmcView', () => {
  it('renderiza enlace #nav-tab-cnmc en AppHeader y vista completa CnmcView con controles de año, gráfica SVG y tabla', async () => {
    const dataset = await loadRealFallbackFromDisk();
    const liveDataset: CnmcDatasetPayload = {
      ...dataset,
      source: 'live',
    };

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
      },
    });
    queryClient.setQueryData(CNMC_ANNUAL_QUERY_KEY, liveDataset);

    const rootRoute = createRootRoute({
      component: () =>
        createElement('div', null, createElement(AppHeader), createElement(Outlet)),
    });
    const mapRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => createElement('div', null, 'map'),
    });
    const cnmcRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/cnmc',
      validateSearch: validateCnmcSearch,
      component: CnmcView,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([mapRoute, cnmcRoute]),
      history: createMemoryHistory({ initialEntries: ['/cnmc'] }),
    });
    await router.load();

    const html = renderToStaticMarkup(
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

    expect(html).toContain('id="nav-tab-cnmc"');
    expect(html).toContain('>CNMC<');
    expect(html).toContain('>2025<');
    expect(html).toContain('CNMC · Telecomunicaciones Anual');
    expect(html).toContain('API CNMC en directo');
    expect(html).toContain('id="cnmc-year-from"');
    expect(html).toContain('id="cnmc-year-to"');
    expect(html).toContain('id="cnmc-annual-chart-svg"');
    expect(html).toContain('id="cnmc-metric-tab-ingresos_por_operador"');
    expect(html).toContain('id="cnmc-metric-tab-paquetes"');
    expect(html).toContain('id="cnmc-api-details"');
    expect(html).not.toContain('id="cnmc-fallback-banner"');
  });

  it('muestra el aviso no bloqueante de respaldo cuando CNMC no responde y se sirve el JSON estático', async () => {
    const dataset = await loadRealFallbackFromDisk();
    const fallbackDataset: CnmcDatasetPayload = {
      ...dataset,
      source: 'fallback',
      liveError: 'HTTP 503 al consultar catálogo CNMC',
    };

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
      },
    });
    queryClient.setQueryData(CNMC_ANNUAL_QUERY_KEY, fallbackDataset);

    const rootRoute = createRootRoute({
      component: () => createElement(Outlet),
    });
    const cnmcRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/cnmc',
      validateSearch: validateCnmcSearch,
      component: CnmcView,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([cnmcRoute]),
      history: createMemoryHistory({ initialEntries: ['/cnmc'] }),
    });
    await router.load();

    const html = renderToStaticMarkup(
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

    expect(html).toContain('id="cnmc-fallback-banner"');
    expect(html).toContain('Respaldo estático (CNMC sin respuesta)');
    expect(html).toContain('id="cnmc-annual-chart-svg"');
  });
});
