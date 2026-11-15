import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { NotFoundView, RootLayout } from './components/ui/RootLayout';
import { EstadisticasView } from './views/EstadisticasView';
import { ExplorarView } from './views/ExplorarView';
import { MapaView } from './views/MapaView';
import { MetodologiaView } from './views/MetodologiaView';

export interface MapaRouteSearch {
  gid?: string;
}

const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundView,
});

const mapaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (search: Record<string, unknown>): MapaRouteSearch => ({
    gid:
      typeof search.gid === 'string' && search.gid.trim().length > 0
        ? search.gid.trim()
        : undefined,
  }),
  component: MapaView,
});

const explorarRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/explorar',
  component: ExplorarView,
});

const estadisticasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/estadisticas',
  component: EstadisticasView,
});

const metodologiaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/metodologia',
  component: MetodologiaView,
});

const routeTree = rootRoute.addChildren([
  mapaRoute,
  explorarRoute,
  estadisticasRoute,
  metodologiaRoute,
]);

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
