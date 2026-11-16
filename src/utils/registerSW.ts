export interface ServiceWorkerRegistrationEnv {
  hasSW?: boolean;
  protocol?: string;
  isTest?: boolean;
}

export function shouldRegisterServiceWorker(
  env?: ServiceWorkerRegistrationEnv,
): boolean {
  const hasSW =
    env?.hasSW ??
    (typeof navigator !== 'undefined' && 'serviceWorker' in navigator);
  const protocol =
    env?.protocol ??
    (typeof window !== 'undefined' ? window.location.protocol : '');
  const isTest = env?.isTest ?? Boolean(import.meta.env.VITEST);

  return (
    hasSW === true &&
    isTest === false &&
    (protocol === 'https:' || protocol === 'http:')
  );
}

export function registerServiceWorker(
  env?: ServiceWorkerRegistrationEnv,
): void {
  if (
    typeof window === 'undefined' ||
    typeof document === 'undefined' ||
    typeof navigator === 'undefined'
  ) {
    return;
  }

  if (!shouldRegisterServiceWorker(env) || !('serviceWorker' in navigator)) {
    return;
  }

  const performRegistration = () => {
    navigator.serviceWorker
      .register('./sw.js', { scope: './' })
      .then((registration) => {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') {
            registration.update().catch(() => {});
          }
        });
      })
      .catch(() => {});
  };

  if (document.readyState === 'complete') {
    performRegistration();
  } else {
    window.addEventListener('load', performRegistration, { once: true });
  }
}
