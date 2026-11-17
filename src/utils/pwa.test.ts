import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import appHeaderRawSource from '../components/ui/AppHeader.tsx?raw';
import { RootLayout } from '../components/ui/RootLayout';
import usePwaInstallRawSource from '../hooks/usePwaInstall.ts?raw';
import {
  detectInstallPlatformHint,
  detectStandaloneMode,
} from '../hooks/usePwaInstall';
import { WorkspaceProvider } from '../hooks/WorkspaceProvider';
import mainRawSource from '../main.tsx?raw';
import type { AntenasDataset } from '../types/antena';
import { EstadisticasView } from '../views/EstadisticasView';
import {
  registerServiceWorker,
  shouldRegisterServiceWorker,
} from './registerSW';

function createMinimalDataset(): AntenasDataset {
  return {
    updatedAt: '2026-11-16T04:00:00Z',
    sourceUrl: 'https://geoportal.minetur.gob.es/VCTEL/vcne.do',
    total: 1,
    crawlStats: {
      requestsCount: 1,
      durationSeconds: 1,
      gridBoxesVisited: 1,
      subdividedBoxes: 0,
      zoomParam: 7,
      delaySeconds: 0.5,
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
        count: 0,
        legalEntities: [],
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
        provincia: 'MADRID',
        count: 1,
        byOperator: { movistar: 1 },
      },
    ],
    antenas: [
      {
        id: 'TELEFONICA MOVILES ESPAÑA, S.A.U. - 2800001',
        gid: '2800001',
        op: 'movistar',
        opRaw: 'TELEFONICA MOVILES ESPAÑA, S.A.U.',
        lat: 40.4168,
        lon: -3.7038,
        dir: 'GRAN VIA 28',
        mun: 'MADRID',
        prov: 'MADRID',
      },
    ],
  };
}

async function renderAppHeaderMarkup(): Promise<string> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(['antenas-dataset'], createMinimalDataset());
  queryClient.setQueryData(['novedades-dataset'], {
    updatedAt: '2026-11-16T04:00:00Z',
    previousUpdatedAt: '2026-11-15T04:00:00Z',
    total: 0,
    nuevasAntenasCount: 0,
    nuevasFrecuenciasCount: 0,
    items: [],
  });
  queryClient.setQueryData(['scan-status'], null);

  const root = createRootRoute({ component: RootLayout });
  const statsRoute = createRoute({
    getParentRoute: () => root,
    path: '/estadisticas',
    component: EstadisticasView,
  });
  const router = createRouter({
    routeTree: root.addChildren([statsRoute]),
    history: createMemoryHistory({ initialEntries: ['/estadisticas'] }),
  });
  await router.load();

  return renderToStaticMarkup(
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
}

describe('Service Worker Registration (registerSW.ts & main.tsx)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shouldRegisterServiceWorker solo devuelve true con soporte SW, protocolo HTTP/HTTPS y fuera de test', () => {
    expect(
      shouldRegisterServiceWorker({
        hasSW: true,
        protocol: 'https:',
        isTest: false,
      }),
    ).toBe(true);
    expect(
      shouldRegisterServiceWorker({
        hasSW: true,
        protocol: 'http:',
        isTest: false,
      }),
    ).toBe(true);

    expect(
      shouldRegisterServiceWorker({
        hasSW: false,
        protocol: 'https:',
        isTest: false,
      }),
    ).toBe(false);
    expect(
      shouldRegisterServiceWorker({
        hasSW: true,
        protocol: 'https:',
        isTest: true,
      }),
    ).toBe(false);
    expect(
      shouldRegisterServiceWorker({
        hasSW: true,
        protocol: 'file:',
        isTest: false,
      }),
    ).toBe(false);
    expect(
      shouldRegisterServiceWorker({
        hasSW: true,
        protocol: 'chrome-extension:',
        isTest: false,
      }),
    ).toBe(false);
  });

  it('registerServiceWorker registra ./sw.js con scope ./ y actualiza en segundo plano en visibilitychange', async () => {
    const updateMock = vi.fn().mockResolvedValue(undefined);
    const registerMock = vi.fn().mockResolvedValue({ update: updateMock });
    let visibilityHandler: (() => void) | null = null;
    let currentVisibilityState: DocumentVisibilityState = 'hidden';

    vi.stubGlobal('window', {
      location: { protocol: 'https:' },
      addEventListener: vi.fn(),
    });
    vi.stubGlobal('navigator', {
      serviceWorker: {
        register: registerMock,
      },
    });
    vi.stubGlobal('document', {
      readyState: 'complete',
      get visibilityState() {
        return currentVisibilityState;
      },
      addEventListener: vi.fn((event: string, cb: () => void) => {
        if (event === 'visibilitychange') {
          visibilityHandler = cb;
        }
      }),
    });

    registerServiceWorker({
      hasSW: true,
      protocol: 'https:',
      isTest: false,
    });

    expect(registerMock).toHaveBeenCalledWith('./sw.js', { scope: './' });

    await Promise.resolve();
    expect(visibilityHandler).toBeTypeOf('function');

    // Oculto -> no dispara update
    visibilityHandler!();
    expect(updateMock).not.toHaveBeenCalled();

    // Visible en Android standalone -> dispara registration.update()
    currentVisibilityState = 'visible';
    visibilityHandler!();
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('registerServiceWorker espera al evento load de window cuando document.readyState aún está cargando', () => {
    const registerMock = vi.fn().mockResolvedValue({
      update: vi.fn().mockResolvedValue(undefined),
    });
    let loadHandler: (() => void) | null = null;

    vi.stubGlobal('window', {
      location: { protocol: 'https:' },
      addEventListener: vi.fn((event: string, cb: () => void) => {
        if (event === 'load') {
          loadHandler = cb;
        }
      }),
    });
    vi.stubGlobal('navigator', {
      serviceWorker: {
        register: registerMock,
      },
    });
    vi.stubGlobal('document', {
      readyState: 'loading',
      visibilityState: 'visible',
      addEventListener: vi.fn(),
    });

    registerServiceWorker({
      hasSW: true,
      protocol: 'https:',
      isTest: false,
    });

    expect(registerMock).not.toHaveBeenCalled();
    expect(loadHandler).toBeTypeOf('function');

    loadHandler!();
    expect(registerMock).toHaveBeenCalledWith('./sw.js', { scope: './' });
  });

  it('main.tsx invoca registerServiceWorker() en el arranque de la aplicación', () => {
    expect(mainRawSource).toContain(
      "import { registerServiceWorker } from './utils/registerSW';",
    );
    expect(mainRawSource).toContain('registerServiceWorker();');
  });
});

describe('Detección Standalone Android/iOS y plataforma de instalación (usePwaInstall.ts)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('detectStandaloneMode detecta standalone, fullscreen, minimal-ui y navigator.standalone', () => {
    expect(detectStandaloneMode(null, null)).toBe(false);

    const makeWin = (activeQuery: string): Pick<Window, 'matchMedia'> => ({
      matchMedia: ((query: string) => ({
        matches: query === activeQuery,
      })) as Window['matchMedia'],
    });

    expect(detectStandaloneMode(makeWin('(display-mode: browser)'), {})).toBe(
      false,
    );
    expect(
      detectStandaloneMode(makeWin('(display-mode: standalone)'), {}),
    ).toBe(true);
    expect(
      detectStandaloneMode(makeWin('(display-mode: fullscreen)'), {}),
    ).toBe(true);
    expect(
      detectStandaloneMode(makeWin('(display-mode: minimal-ui)'), {}),
    ).toBe(true);
    expect(
      detectStandaloneMode(makeWin('(display-mode: browser)'), {
        standalone: true,
      }),
    ).toBe(true);
  });

  it('detectInstallPlatformHint distingue Android, iOS y escritorio', () => {
    expect(
      detectInstallPlatformHint(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe('android');
    expect(
      detectInstallPlatformHint(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('ios');
    expect(
      detectInstallPlatformHint(
        'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15',
      ),
    ).toBe('ios');
    expect(
      detectInstallPlatformHint(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
      ),
    ).toBe('desktop');
    expect(detectInstallPlatformHint('')).toBe('desktop');
  });

  it('usePwaInstall no bloquea beforeinstallprompt con preventDefault() para preservar el banner nativo de Android Chrome', () => {
    expect(usePwaInstallRawSource).toContain("'beforeinstallprompt'");
    expect(usePwaInstallRawSource).not.toContain('preventDefault()');
  });
});

describe('Sección "Aplicación móvil" en AppHeader (#sections-drawer) y CSS Standalone/Safe-Area', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('muestra la sección "Aplicación móvil" entre "Apariencia" y "Estado del censo oficial" cuando no está en modo standalone', async () => {
    vi.stubGlobal('window', {
      localStorage: { getItem: () => null, setItem: () => {} },
      matchMedia: () => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const html = await renderAppHeaderMarkup();

    expect(html).toContain('Aplicación móvil');
    expect(html).toContain('id="pwa-install-btn"');
    expect(html).toContain('sections-pwa-install-btn');
    expect(html).toContain('Instalar aplicación');
    expect(html).toContain('Abrir como app sin barra de navegación');

    const aparienciaIdx = html.indexOf('Apariencia');
    const appMovilIdx = html.indexOf('Aplicación móvil');
    const censoIdx = html.indexOf('Estado del censo oficial');
    expect(aparienciaIdx).toBeGreaterThan(-1);
    expect(appMovilIdx).toBeGreaterThan(aparienciaIdx);
    expect(censoIdx).toBeGreaterThan(appMovilIdx);
  });

  it('oculta la sección "Aplicación móvil" cuando la app ya corre instalada en modo standalone', async () => {
    vi.stubGlobal('window', {
      localStorage: { getItem: () => null, setItem: () => {} },
      matchMedia: (query: string) => ({
        matches: query === '(display-mode: standalone)',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const html = await renderAppHeaderMarkup();

    expect(html).not.toContain('id="pwa-install-btn"');
    expect(html).not.toContain('Aplicación móvil');
    expect(html).toContain('Apariencia');
    expect(html).toContain('Estado del censo oficial');
  });

  it('AppHeader incluye los textos de instalación nativa Android y ayuda manual para Android e iOS', () => {
    expect(appHeaderRawSource).toContain(
      'Acceso directo en Android a pantalla completa',
    );
    expect(appHeaderRawSource).toContain('id="pwa-install-help"');
    expect(appHeaderRawSource).toContain('sections-pwa-help-note');
    expect(appHeaderRawSource).toContain(
      'En Safari pulsa el icono Compartir y selecciona «Añadir a pantalla de inicio» para abrir RadioMapa a pantalla completa sin barra de navegación.',
    );
    expect(appHeaderRawSource).toContain(
      'En Android (Chrome, Brave o Edge), toca el menú ⋮ del navegador y pulsa «Instalar aplicación» o «Añadir a pantalla de inicio» para instalarla sin barra de navegación.',
    );
  });

  it('index.css aplica safe-area-inset-* en controles flotantes/cajones y reglas display-mode: standalone', async () => {
    const fsSpecifier = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFileSync: (path: URL, encoding: string) => string;
    };
    const indexCssRawSource = readFileSync(
      new URL('../styles/index.css', import.meta.url),
      'utf-8',
    );

    expect(indexCssRawSource).toContain('env(safe-area-inset-top, 0px)');
    expect(indexCssRawSource).toContain('env(safe-area-inset-bottom, 0px)');
    expect(indexCssRawSource).toContain('env(safe-area-inset-left, 0px)');
    expect(indexCssRawSource).toContain('env(safe-area-inset-right, 0px)');

    expect(indexCssRawSource).toContain('.page-floating-sections-btn');
    expect(indexCssRawSource).toContain('.desktop-floating-controls');
    expect(indexCssRawSource).toContain('.map-overlay-top-stack');
    expect(indexCssRawSource).toContain('.mobile-controls-bar');
    expect(indexCssRawSource).toContain('.sections-drawer .sidebar-header');
    expect(indexCssRawSource).toContain('.sections-drawer .sidebar-scroll');
    expect(indexCssRawSource).toContain('.station-drawer .drawer-body');
    expect(indexCssRawSource).toContain('.sections-pwa-install-btn');
    expect(indexCssRawSource).toContain('.sections-pwa-help-note');

    expect(indexCssRawSource).toContain(
      '@media (display-mode: standalone), (display-mode: fullscreen)',
    );
    expect(indexCssRawSource).toContain('overscroll-behavior-y: none;');
    expect(indexCssRawSource).toContain(
      '-webkit-tap-highlight-color: transparent;',
    );
  });
});

describe('Manifiesto WebAPK, Iconos PNG y Service Worker (public/ e index.html)', () => {
  it('index.html enlaza manifest.webmanifest, apple-touch-icon, viewport-fit=cover y metadatos standalone', async () => {
    const fsSpecifier = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFileSync: (path: URL, encoding: string) => string;
    };
    const indexHtml = readFileSync(
      new URL('../../index.html', import.meta.url),
      'utf-8',
    );

    expect(indexHtml).toContain(
      '<link rel="manifest" href="./manifest.webmanifest" />',
    );
    expect(indexHtml).toContain(
      '<link rel="apple-touch-icon" sizes="180x180" href="./icons/apple-touch-icon.png" />',
    );
    expect(indexHtml).toContain('viewport-fit=cover');
    expect(indexHtml).toContain(
      '<meta name="mobile-web-app-capable" content="yes" />',
    );
    expect(indexHtml).toContain(
      '<meta name="apple-mobile-web-app-capable" content="yes" />',
    );
    expect(indexHtml).toContain('<meta name="theme-color" content="#0b1120" />');
  });

  it('manifest.webmanifest declara display: standalone, iconos any y maskable separados (192 y 512 px) y accesos directos', async () => {
    const fsSpecifier = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFileSync: (path: URL, encoding?: string) => string | Uint8Array;
    };
    const manifestRaw = readFileSync(
      new URL('../../public/manifest.webmanifest', import.meta.url),
      'utf-8',
    ) as string;
    const manifest = JSON.parse(manifestRaw) as {
      display: string;
      start_url: string;
      scope: string;
      short_name: string;
      icons: Array<{
        src: string;
        sizes: string;
        type: string;
        purpose: string;
      }>;
      shortcuts: Array<{ name: string; url: string }>;
    };

    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
    expect(manifest.short_name).toBe('RadioMapa');

    const purposesAndSizes = manifest.icons.map(
      (icon) => `${icon.purpose}:${icon.sizes}:${icon.type}`,
    );
    expect(purposesAndSizes).toContain('any:192x192:image/png');
    expect(purposesAndSizes).toContain('any:512x512:image/png');
    expect(purposesAndSizes).toContain('maskable:192x192:image/png');
    expect(purposesAndSizes).toContain('maskable:512x512:image/png');
    // Prohibido combinar "any maskable" en el mismo objeto según guía WebAPK / Lighthouse
    for (const icon of manifest.icons) {
      expect(icon.purpose).not.toContain(' ');
    }

    expect(manifest.shortcuts.length).toBeGreaterThanOrEqual(3);

    // Verificar cabecera binaria PNG (firma + IHDR width/height) de cada icono generado
    const expectedPngDimensions: Array<[string, number, number]> = [
      ['../../public/icons/pwa-192x192.png', 192, 192],
      ['../../public/icons/pwa-512x512.png', 512, 512],
      ['../../public/icons/pwa-maskable-192x192.png', 192, 192],
      ['../../public/icons/pwa-maskable-512x512.png', 512, 512],
      ['../../public/icons/apple-touch-icon.png', 180, 180],
    ];

    for (const [relPath, expectedWidth, expectedHeight] of expectedPngDimensions) {
      const bytes = readFileSync(new URL(relPath, import.meta.url)) as Uint8Array;
      expect(bytes[0]).toBe(0x89);
      expect(bytes[1]).toBe(0x50);
      expect(bytes[2]).toBe(0x4e);
      expect(bytes[3]).toBe(0x47);
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      expect(view.getUint32(16, false)).toBe(expectedWidth);
      expect(view.getUint32(20, false)).toBe(expectedHeight);
    }
  });

  it('public/sw.js implementa install, activate y fetch con respaldo offline para navegación sin cachear /data/', async () => {
    const fsSpecifier = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFileSync: (path: URL, encoding: string) => string;
    };
    const swSource = readFileSync(
      new URL('../../public/sw.js', import.meta.url),
      'utf-8',
    );

    expect(swSource).toContain("self.addEventListener('install'");
    expect(swSource).toContain("self.addEventListener('activate'");
    expect(swSource).toContain("self.addEventListener('fetch'");
    expect(swSource).toContain('self.skipWaiting()');
    expect(swSource).toContain('self.clients.claim()');
    expect(swSource).toContain("request.mode === 'navigate'");
    expect(swSource).toContain("url.pathname.includes('/data/')");
    expect(swSource).toContain('url.origin !== self.location.origin');
  });
});

