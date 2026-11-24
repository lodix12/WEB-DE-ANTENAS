import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { NotFoundView, RootLayout } from './components/ui/RootLayout';
import {
  validateNovedadesSearch,
  type NovedadesRouteSearch,
} from './hooks/useNovedadesData';
import { validateUnico5gSearch } from './hooks/useUnico5gData';
import type { UnicoRouteSearch } from './types/unico5g';
import { EliminacionesView } from './views/EliminacionesView';
import { EstadisticasView } from './views/EstadisticasView';
import { MapaView } from './views/MapaView';
import { NovedadesView } from './views/NovedadesView';
import { Unico5gView } from './views/Unico5gView';

export type { NovedadesRouteSearch, UnicoRouteSearch };

export interface MapaRouteSearch {
  gid?: string;
  id?: string;
  lat?: number;
  lon?: number;
}

function parseFiniteCoord(raw: unknown, min: number, max: number): number | undefined {
  let num: number | null = null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    num = raw;
  } else if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Number.parseFloat(raw.trim());
    if (Number.isFinite(parsed)) {
      num = parsed;
    }
  }
  if (num !== null && num >= min && num <= max) {
    return num;
  }
  return undefined;
}

const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundView,
});

const mapaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (search: Record<string, unknown>): MapaRouteSearch => {
    const rawGid = search.gid;
    let gid: string | undefined;
    if (typeof rawGid === 'string' && rawGid.trim().length > 0) {
      gid = rawGid.trim();
    } else if (typeof rawGid === 'number' && Number.isFinite(rawGid)) {
      gid = String(rawGid);
    }

    const rawId = search.id;
    let id: string | undefined;
    if (typeof rawId === 'string' && rawId.trim().length > 0) {
      id = rawId.trim();
    }

    const lat = parseFiniteCoord(search.lat, -90, 90);
    const lon = parseFiniteCoord(search.lon, -180, 180);

    const parsed: MapaRouteSearch = {};
    if (gid !== undefined) {
      parsed.gid = gid;
    }
    if (id !== undefined) {
      parsed.id = id;
    }
    if (lat !== undefined && lon !== undefined) {
      parsed.lat = lat;
      parsed.lon = lon;
    }
    return parsed;
  },
  component: MapaView,
});

const novedadesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/novedades',
  validateSearch: validateNovedadesSearch,
  component: NovedadesView,
});

const eliminacionesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/eliminaciones',
  validateSearch: validateNovedadesSearch,
  component: EliminacionesView,
});

const estadisticasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/estadisticas',
  component: EstadisticasView,
});

const unico5gRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/unico-5g',
  validateSearch: validateUnico5gSearch,
  component: Unico5gView,
});

const routeTree = rootRoute.addChildren([
  mapaRoute,
  novedadesRoute,
  eliminacionesRoute,
  estadisticasRoute,
  unico5gRoute,
]);

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultPreload: 'intent',
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
