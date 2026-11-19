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
import { EstadisticasView } from './views/EstadisticasView';
import { MapaView } from './views/MapaView';
import { NovedadesView } from './views/NovedadesView';

export type { NovedadesRouteSearch };

export interface MapaRouteSearch {
  gid?: string;
  id?: string;
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

    const parsed: MapaRouteSearch = {};
    if (gid !== undefined) {
      parsed.gid = gid;
    }
    if (id !== undefined) {
      parsed.id = id;
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

const estadisticasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/estadisticas',
  component: EstadisticasView,
});

const routeTree = rootRoute.addChildren([
  mapaRoute,
  novedadesRoute,
  estadisticasRoute,
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
