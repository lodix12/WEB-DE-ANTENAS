import { useCallback, useEffect, useMemo, useState } from 'react';

export type InstallPlatformHint = 'ios' | 'android' | 'desktop';
export type InstallPromptOutcome = 'accepted' | 'dismissed' | 'manual';

export interface BeforeInstallPromptEvent extends Event {
  readonly platforms?: string[];
  prompt(): Promise<void>;
  userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
}

export function detectStandaloneMode(
  win?: Pick<Window, 'matchMedia'> | null,
  nav?: { standalone?: boolean } | null,
): boolean {
  const targetWin =
    win === undefined ? (typeof window !== 'undefined' ? window : null) : win;
  const targetNav =
    nav === undefined
      ? typeof navigator !== 'undefined'
        ? (navigator as Navigator & { standalone?: boolean })
        : null
      : nav;

  if (targetNav?.standalone === true) {
    return true;
  }

  if (typeof targetWin?.matchMedia === 'function') {
    if (targetWin.matchMedia('(display-mode: standalone)')?.matches) {
      return true;
    }
    if (targetWin.matchMedia('(display-mode: fullscreen)')?.matches) {
      return true;
    }
    if (targetWin.matchMedia('(display-mode: minimal-ui)')?.matches) {
      return true;
    }
  }

  return false;
}

export function detectInstallPlatformHint(
  userAgent: string,
): InstallPlatformHint {
  const normalized = userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(normalized)) {
    return 'ios';
  }
  if (/android/.test(normalized)) {
    return 'android';
  }
  return 'desktop';
}

export interface UsePwaInstallResult {
  isStandalone: boolean;
  canPromptInstall: boolean;
  installPlatform: InstallPlatformHint;
  promptInstall: () => Promise<InstallPromptOutcome>;
}

export function usePwaInstall(): UsePwaInstallResult {
  const [isStandalone, setIsStandalone] = useState<boolean>(() =>
    detectStandaloneMode(),
  );
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);

  const installPlatform = useMemo<InstallPlatformHint>(() => {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    return detectInstallPlatformHint(ua);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const mediaQuery =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(display-mode: standalone)')
        : null;

    const handleDisplayModeChange = () => {
      setIsStandalone(detectStandaloneMode());
    };

    const handleBeforeInstallPrompt = (event: Event) => {
      // Mantenemos intacto el flujo nativo de Chrome en Android para que muestre su chip/banner automático
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setIsStandalone(true);
      setDeferredPrompt(null);
    };

    if (mediaQuery && typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleDisplayModeChange);
    }
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      if (mediaQuery && typeof mediaQuery.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', handleDisplayModeChange);
      }
      window.removeEventListener(
        'beforeinstallprompt',
        handleBeforeInstallPrompt,
      );
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const promptInstall = useCallback(async (): Promise<InstallPromptOutcome> => {
    if (!deferredPrompt) {
      return 'manual';
    }

    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        setDeferredPrompt(null);
      }
      return choice.outcome;
    } catch {
      setDeferredPrompt(null);
      return 'manual';
    }
  }, [deferredPrompt]);

  return {
    isStandalone,
    canPromptInstall: !isStandalone && deferredPrompt !== null,
    installPlatform,
    promptInstall,
  };
}
