import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { NotFoundView, RootLayout } from './components/ui/RootLayout';
import { EstadisticasView } from './views/EstadisticasView';
import { MapaView } from './views/MapaView';

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
  validateSearch: (search: Record<string, unknown>): MapaRouteSearch => {
    const raw = search.gid;
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return { gid: raw.trim() };
    }
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return { gid: String(raw) };
    }
    return { gid: undefined };
  },
  component: MapaView,
});

const estadisticasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/estadisticas',
  component: EstadisticasView,
});

const routeTree = rootRoute.addChildren([
  mapaRoute,
  estadisticasRoute,
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
