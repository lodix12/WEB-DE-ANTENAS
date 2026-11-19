import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { Link, useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Clock,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import { useAntenasData } from '../hooks/useAntenasData';
import {
  NOVEDADES_PAGE_SIZE_OPTIONS,
  NOVEDADES_SPANISH_COMUNIDADES,
  STANDARD_NOVEDADES_BANDS,
  buildPaginationTokens,
  computeLatestScanNovedadesCounts,
  extractScanDayDmy,
  filterNovedades,
  formatScanDateTimeDmyHms,
  getNovedadAntennaGroupKey,
  getNovedadScanBatchKey,
  getNovedadesOperatorLabel,
  getNovedadesProvincesForComunidad,
  getOperatorRowBackground,
  isValidNovedadesPageSize,
  orderNovedadesGroupedByNewAntenna,
  paginateNovedades,
  resolveNovedadComunidad,
  resolveNovedadProvince,
  resolveNovedadesTableStateFromSearch,
  serializeNovedadesTableStateToSearch,
  splitFrequencyRangeLines,
  splitScanDateTimeLines,
  useNovedadesData,
  type NovedadesTableViewState,
} from '../hooks/useNovedadesData';
import {
  useScanProgress,
  type ForceScanDispatchResult,
} from '../hooks/useScanProgress';
import {
  OPERATOR_META,
  OPERATOR_ORDER,
  type NovedadTipo,
  type OperatorKey,
} from '../types/antena';

export function NovedadesView() {
  const navigate = useNavigate();
  const router = useRouter();
  const rawSearch = useSearch({ strict: false });
  const urlState = useMemo(
    () => resolveNovedadesTableStateFromSearch(rawSearch),
    [rawSearch],
  );

  const {
    data: dataset,
    isLoading,
    isError,
    error,
    refetch,
  } = useNovedadesData();
  const { derived } = useAntenasData();
  const scanProgress = useScanProgress(derived?.dataset.total ?? 62230);

  const tableSectionRef = useRef<HTMLElement | null>(null);
  const pageInputRef = useRef<HTMLInputElement | null>(null);
  const cornerPopoverRef = useRef<HTMLDivElement | null>(null);
  const cornerKeyInputRef = useRef<HTMLInputElement | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);
  const searchSyncTimerRef = useRef<number | null>(null);
  const pendingSearchQueryRef = useRef<string | null>(null);
  const latestCommittedStateRef = useRef<NovedadesTableViewState>(urlState);
  const pendingCommitCountRef = useRef(0);

  const [isDispatching, setIsDispatching] = useState(false);
  const [cornerFeedback, setCornerFeedback] = useState<'ok' | 'err' | null>(
    null,
  );
  const [keyPopoverOpen, setKeyPopoverOpen] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [keyError, setKeyError] = useState(false);

  const [localSearchQuery, setLocalSearchQuery] = useState(
    urlState.searchQuery,
  );
  const [pageInputDraft, setPageInputDraft] = useState<{
    key: string;
    value: string;
  } | null>(null);

  useEffect(() => {
    document.title =
      'Novedades · Censo de Antenas y Frecuencias Móviles en España';
  }, []);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current !== null) {
        window.clearTimeout(feedbackTimerRef.current);
      }
      if (searchSyncTimerRef.current !== null) {
        window.clearTimeout(searchSyncTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    return router.history.subscribe(({ action }) => {
      if (
        action.type === 'BACK' ||
        action.type === 'FORWARD' ||
        action.type === 'GO'
      ) {
        if (searchSyncTimerRef.current !== null) {
          window.clearTimeout(searchSyncTimerRef.current);
          searchSyncTimerRef.current = null;
        }
        pendingCommitCountRef.current = 0;
        pendingSearchQueryRef.current = null;
      }
    });
  }, [router]);

  useEffect(() => {
    if (pendingSearchQueryRef.current !== null) {
      if (urlState.searchQuery === pendingSearchQueryRef.current) {
        pendingSearchQueryRef.current = null;
      }
      return;
    }
    setLocalSearchQuery(urlState.searchQuery);
  }, [urlState.searchQuery]);

  useEffect(() => {
    if (!keyPopoverOpen) {
      return;
    }
    const focusFrame = window.requestAnimationFrame(() => {
      const inputEl =
        cornerKeyInputRef.current ??
        (document.getElementById(
          'novedades-corner-key-input',
        ) as HTMLInputElement | null);
      inputEl?.focus();
    });

    const handleOutsideMouseDown = (event: globalThis.MouseEvent) => {
      const wrapEl = cornerPopoverRef.current;
      if (
        wrapEl &&
        event.target instanceof Node &&
        !wrapEl.contains(event.target)
      ) {
        setKeyPopoverOpen(false);
        setKeyError(false);
      }
    };

    const handleGlobalKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setKeyPopoverOpen(false);
        setKeyError(false);
      }
    };

    document.addEventListener('mousedown', handleOutsideMouseDown);
    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('mousedown', handleOutsideMouseDown);
      document.removeEventListener('keydown', handleGlobalKeyDown);
    };
  }, [keyPopoverOpen]);

  const {
    tipoFilter,
    operatorFilter,
    bandFilter,
    comunidadFilter,
    provinceFilter,
    dateFilter,
    pageSize,
  } = urlState;
  const searchQuery = localSearchQuery;
  const isSearchQueryDirty = localSearchQuery !== urlState.searchQuery;
  const filterKey = `${tipoFilter}|${operatorFilter}|${bandFilter}|${comunidadFilter}|${provinceFilter}|${dateFilter}|${searchQuery}|${pageSize}`;
  const requestedPage = isSearchQueryDirty ? 1 : urlState.page;

  const latestScanCounts = useMemo(
    () => computeLatestScanNovedadesCounts(dataset),
    [dataset],
  );

  const orderedNovedades = useMemo(
    () => (dataset ? orderNovedadesGroupedByNewAntenna(dataset.novedades) : []),
    [dataset],
  );

  const availableComunidades = useMemo(() => {
    const comunidades = new Set<string>(NOVEDADES_SPANISH_COMUNIDADES);
    for (let i = 0; i < orderedNovedades.length; i++) {
      const comunidad = resolveNovedadComunidad(orderedNovedades[i]).trim();
      if (comunidad) {
        comunidades.add(comunidad);
      }
    }
    return Array.from(comunidades).sort((a, b) => a.localeCompare(b, 'es'));
  }, [orderedNovedades]);

  const availableProvinces = useMemo(() => {
    const provinces = new Set<string>(
      getNovedadesProvincesForComunidad(comunidadFilter),
    );
    for (let i = 0; i < orderedNovedades.length; i++) {
      const row = orderedNovedades[i];
      if (
        comunidadFilter === 'all' ||
        resolveNovedadComunidad(row) === comunidadFilter
      ) {
        const province = resolveNovedadProvince(row).trim();
        if (province) {
          provinces.add(province);
        }
      }
    }
    return Array.from(provinces).sort((a, b) => a.localeCompare(b, 'es'));
  }, [comunidadFilter, orderedNovedades]);

  const availableScanDates = useMemo(() => {
    const dates = new Set<string>();
    for (let i = 0; i < orderedNovedades.length; i++) {
      const row = orderedNovedades[i];
      const day = extractScanDayDmy(row.scannedAt, row.fecha);
      if (day && day !== '—') {
        dates.add(day);
      }
    }
    return Array.from(dates);
  }, [orderedNovedades]);

  const newAntennaKeys = useMemo(() => {
    const keys = new Set<string>();
    for (let i = 0; i < orderedNovedades.length; i++) {
      const r = orderedNovedades[i];
      if (r.tipo === 'antena') {
        keys.add(
          `${getNovedadScanBatchKey(r)}@@${getNovedadAntennaGroupKey(r)}`,
        );
      }
    }
    return keys;
  }, [orderedNovedades]);

  const filteredRows = useMemo(() => {
    if (orderedNovedades.length === 0) return [];
    return filterNovedades({
      novedades: orderedNovedades,
      tipoFilter,
      operatorFilter,
      bandFilter,
      comunidadFilter,
      provinceFilter,
      dateFilter,
      searchQuery,
    });
  }, [
    orderedNovedades,
    tipoFilter,
    operatorFilter,
    bandFilter,
    comunidadFilter,
    provinceFilter,
    dateFilter,
    searchQuery,
  ]);

  const hasActiveFilters =
    tipoFilter !== 'all' ||
    operatorFilter !== 'all' ||
    bandFilter !== 'all' ||
    comunidadFilter !== 'all' ||
    provinceFilter !== 'all' ||
    dateFilter !== 'all' ||
    searchQuery.trim().length > 0;

  function clearSearchSyncTimer() {
    if (searchSyncTimerRef.current !== null) {
      window.clearTimeout(searchSyncTimerRef.current);
      searchSyncTimerRef.current = null;
    }
  }

  function getCurrentBaseState(): NovedadesTableViewState {
    if (pendingCommitCountRef.current > 0) {
      return {
        ...latestCommittedStateRef.current,
        searchQuery: localSearchQuery,
      };
    }
    return {
      ...urlState,
      searchQuery: localSearchQuery,
    };
  }

  function dispatchUrlState(nextState: NovedadesTableViewState) {
    latestCommittedStateRef.current = nextState;
    pendingCommitCountRef.current += 1;
    void navigate({
      to: '/novedades',
      search: serializeNovedadesTableStateToSearch(nextState),
      replace: true,
      resetScroll: false,
    }).finally(() => {
      pendingCommitCountRef.current = Math.max(
        0,
        pendingCommitCountRef.current - 1,
      );
    });
  }

  function updateViewState(
    updater: (prev: NovedadesTableViewState) => NovedadesTableViewState,
  ) {
    clearSearchSyncTimer();
    const nextState = updater(getCurrentBaseState());
    setLocalSearchQuery(nextState.searchQuery);
    pendingSearchQueryRef.current =
      nextState.searchQuery !== urlState.searchQuery
        ? nextState.searchQuery
        : null;
    setPageInputDraft(null);
    dispatchUrlState(nextState);
  }

  function handleTipoChange(nextTipo: 'all' | NovedadTipo) {
    updateViewState((prev) => ({
      ...prev,
      tipoFilter: nextTipo,
      page: 1,
    }));
  }

  function handleOperatorChange(nextOperator: 'all' | OperatorKey) {
    updateViewState((prev) => ({
      ...prev,
      operatorFilter: nextOperator,
      page: 1,
    }));
  }

  function handleBandChange(nextBand: string) {
    updateViewState((prev) => ({
      ...prev,
      bandFilter: nextBand,
      page: 1,
    }));
  }

  function handleDateChange(nextDate: string) {
    updateViewState((prev) => ({
      ...prev,
      dateFilter: nextDate,
      page: 1,
    }));
  }

  function handleProvinceChange(nextProvince: string) {
    updateViewState((prev) => ({
      ...prev,
      provinceFilter: nextProvince,
      page: 1,
    }));
  }

  function handleComunidadChange(nextComunidad: string) {
    updateViewState((prev) => {
      let nextProvince = prev.provinceFilter;
      if (nextComunidad !== 'all' && prev.provinceFilter !== 'all') {
        const inStaticProvinces =
          getNovedadesProvincesForComunidad(nextComunidad).includes(
            prev.provinceFilter,
          );
        const inDatasetRows = orderedNovedades.some(
          (row) =>
            resolveNovedadProvince(row) === prev.provinceFilter &&
            resolveNovedadComunidad(row) === nextComunidad,
        );
        if (!inStaticProvinces && !inDatasetRows) {
          nextProvince = 'all';
        }
      }
      return {
        ...prev,
        comunidadFilter: nextComunidad,
        provinceFilter: nextProvince,
        page: 1,
      };
    });
  }

  function handleSearchQueryChange(nextQuery: string) {
    setLocalSearchQuery(nextQuery);
    setPageInputDraft(null);
    clearSearchSyncTimer();

    const baseState =
      pendingCommitCountRef.current > 0
        ? latestCommittedStateRef.current
        : urlState;

    if (
      nextQuery === baseState.searchQuery &&
      pendingCommitCountRef.current === 0
    ) {
      pendingSearchQueryRef.current = null;
      if (baseState.page !== 1) {
        updateViewState((prev) => ({
          ...prev,
          searchQuery: nextQuery,
          page: 1,
        }));
      }
      return;
    }

    pendingSearchQueryRef.current = nextQuery;
    const nextState: NovedadesTableViewState = {
      ...baseState,
      searchQuery: nextQuery,
      page: 1,
    };
    searchSyncTimerRef.current = window.setTimeout(() => {
      searchSyncTimerRef.current = null;
      dispatchUrlState(nextState);
    }, 150);
  }

  function handleSearchInputBlur() {
    if (searchSyncTimerRef.current === null) {
      return;
    }
    clearSearchSyncTimer();
    dispatchUrlState({
      ...getCurrentBaseState(),
      searchQuery: localSearchQuery,
      page: 1,
    });
  }

  function handleClearSearch() {
    updateViewState((prev) => ({
      ...prev,
      searchQuery: '',
      page: 1,
    }));
  }

  function handleResetFilters() {
    updateViewState((prev) => ({
      tipoFilter: 'all',
      operatorFilter: 'all',
      bandFilter: 'all',
      comunidadFilter: 'all',
      provinceFilter: 'all',
      dateFilter: 'all',
      searchQuery: '',
      pageSize: prev.pageSize,
      page: 1,
    }));
  }

  if (isLoading && !dataset) {
    return (
      <main className="page-container novedades-page">
        <div className="state-center-box">
          <div className="spinner-ring" aria-hidden="true" />
          <p style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
            Cargando registro de novedades de antenas y frecuencias…
          </p>
        </div>
      </main>
    );
  }

  if (isError || !dataset) {
    return (
      <main className="page-container novedades-page">
        <div className="state-center-box">
          <h1
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: 'var(--text-primary)',
            }}
          >
            Error al cargar las novedades del censo
          </h1>
          <p style={{ maxWidth: 460 }}>
            {error instanceof Error
              ? error.message
              : 'No se pudo descargar data/novedades.json.'}
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void refetch()}
          >
            <RefreshCw size={14} aria-hidden="true" />
            <span>Reintentar descarga</span>
          </button>
        </div>
      </main>
    );
  }

  const lastScanFormatted = formatScanDateTimeDmyHms(dataset.updatedAt);
  const pageSlice = paginateNovedades(filteredRows, requestedPage, pageSize);
  const {
    items: visibleRows,
    currentPage,
    totalItems,
    totalPages,
    startRow,
    endRow,
  } = pageSlice;
  const paginationTokens = buildPaginationTokens(currentPage, totalPages);
  const pageInputKey = `${filterKey}|${currentPage}`;
  const displayedPageInput =
    pageInputDraft !== null && pageInputDraft.key === pageInputKey
      ? pageInputDraft.value
      : String(currentPage);

  function flushNovedadesStateBeforeLeaving() {
    clearSearchSyncTimer();
    pendingSearchQueryRef.current = null;

    const stateToPersist: NovedadesTableViewState =
      pendingCommitCountRef.current > 0
        ? {
            ...latestCommittedStateRef.current,
            searchQuery,
          }
        : {
            tipoFilter,
            operatorFilter,
            bandFilter,
            comunidadFilter,
            provinceFilter,
            dateFilter,
            searchQuery,
            pageSize,
            page: currentPage,
          };

    const targetLocation = router.buildLocation({
      to: '/novedades',
      search: serializeNovedadesTableStateToSearch(stateToPersist),
    });

    if (router.history.location.href !== targetLocation.href) {
      router.history.replace(
        targetLocation.href,
        router.history.location.state,
      );
    }
    router.history.flush();
  }

  function scrollTableTopIfNeeded() {
    const sectionEl = tableSectionRef.current;
    if (!sectionEl) return;
    const rect = sectionEl.getBoundingClientRect();
    if (rect.top < 56) {
      sectionEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function goToPage(nextPage: number) {
    const clamped = Math.min(Math.max(1, Math.trunc(nextPage)), totalPages);
    updateViewState((prev) => ({
      ...prev,
      page: clamped,
    }));
    if (clamped !== currentPage) {
      scrollTableTopIfNeeded();
    }
  }

  function handlePageSizeChange(rawValue: string) {
    const parsed = Number.parseInt(rawValue, 10);
    if (isValidNovedadesPageSize(parsed)) {
      updateViewState((prev) => ({
        ...prev,
        pageSize: parsed,
        page: 1,
      }));
      scrollTableTopIfNeeded();
    }
  }

  function handlePageJumpSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = displayedPageInput.trim();
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
      setPageInputDraft(null);
      return;
    }
    goToPage(parsed);
  }

  function handlePageInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      setPageInputDraft(null);
      event.currentTarget.blur();
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const base = Number.parseInt(displayedPageInput, 10);
      const start = Number.isFinite(base) ? base : currentPage;
      const delta = event.key === 'ArrowUp' ? 1 : -1;
      const next = Math.min(Math.max(1, start + delta), totalPages);
      setPageInputDraft({
        key: pageInputKey,
        value: String(next),
      });
    }
  }

  function focusPageJumpInput() {
    const inputEl = pageInputRef.current;
    if (!inputEl || inputEl.disabled) return;
    inputEl.focus();
    inputEl.select();
  }

  function showCornerFeedback(kind: 'ok' | 'err', durationMs: number) {
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current);
    }
    setCornerFeedback(kind);
    feedbackTimerRef.current = window.setTimeout(() => {
      setCornerFeedback(null);
      feedbackTimerRef.current = null;
    }, durationMs);
  }

  function scrollScanMonitorIntoView() {
    document
      .getElementById('novedades-scan-monitor')
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function runForcedScanDispatch(tokenOverride?: string) {
    setIsDispatching(true);
    let res: ForceScanDispatchResult;
    try {
      res = await scanProgress.forceScan(tokenOverride);
    } catch {
      res = { status: 'error' };
    } finally {
      setIsDispatching(false);
    }

    if (res.status === 'dispatched' || res.status === 'already_scanning') {
      setKeyPopoverOpen(false);
      setKeyError(false);
      setTokenDraft('');
      showCornerFeedback('ok', 3500);
      scrollScanMonitorIntoView();
      return;
    }

    if (res.status === 'needs_token' || res.status === 'unauthorized') {
      setKeyError(res.status === 'unauthorized');
      setKeyPopoverOpen(true);
      window.requestAnimationFrame(() => {
        const inputEl =
          cornerKeyInputRef.current ??
          (document.getElementById(
            'novedades-corner-key-input',
          ) as HTMLInputElement | null);
        inputEl?.focus();
      });
      return;
    }

    showCornerFeedback('err', 3000);
  }

  function handleCornerScanClick(event: MouseEvent<HTMLButtonElement>) {
    if (event.shiftKey || event.altKey) {
      setKeyError(false);
      setKeyPopoverOpen((prev) => !prev);
      return;
    }
    if (scanProgress.isScanning || isDispatching) {
      scrollScanMonitorIntoView();
      return;
    }
    void runForcedScanDispatch();
  }

  function handleKeySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = tokenDraft.trim();
    if (!trimmed || isDispatching) {
      return;
    }
    void runForcedScanDispatch(trimmed);
  }

  return (
    <main className="page-container novedades-page">
      <header className="page-hero novedades-hero">
        <h1 className="page-h1">Novedades</h1>
      </header>

      <section
        className="metrics-strip novedades-metrics-strip"
        aria-label="Resumen del último escaneo de novedades"
      >
        <div
          id="novedades-scan-monitor"
          className={`metric-cell novedades-scan-monitor${
            scanProgress.isScanning ? ' is-scanning' : ''
          }`}
          aria-live="polite"
        >
          <div className="scan-monitor-header">
            <span className="metric-label">Escaneo en vivo</span>
            <span
              className={`scan-monitor-badge${
                scanProgress.isScanning ? ' is-live' : ' is-idle'
              }`}
            >
              <span className="scan-monitor-dot" aria-hidden="true" />
              <span>
                {scanProgress.isScanning
                  ? scanProgress.trigger === 'schedule'
                    ? 'Diario · 00:05'
                    : 'Forzado'
                  : 'En espera'}
              </span>
            </span>
          </div>

          <div className="scan-monitor-value-row">
            <span
              id="novedades-scan-percent"
              className={`metric-value scan-monitor-value${
                scanProgress.isScanning ? ' is-live' : ' is-idle'
              }`}
            >
              {scanProgress.isScanning
                ? scanProgress.formattedPercent
                : scanProgress.isLoadingInitial
                  ? 'Conectando…'
                  : 'En espera'}
            </span>
          </div>

          <div
            className="scan-monitor-progress-track"
            role="progressbar"
            aria-label="Porcentaje de antenas escaneadas en tiempo real"
            aria-valuenow={
              scanProgress.isScanning
                ? Number(scanProgress.percent.toFixed(2))
                : 0
            }
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={`scan-monitor-progress-fill${
                scanProgress.isScanning ? ' is-live' : ''
              }`}
              style={{
                width: `${
                  scanProgress.isScanning
                    ? Math.max(1.5, Math.min(100, scanProgress.percent))
                    : 0
                }%`,
              }}
            />
          </div>

          <span className="metric-sub scan-monitor-sub">
            {scanProgress.isScanning
              ? scanProgress.phase === 'censo'
                ? `Barrido inicial del censo (${scanProgress.censusBoxesVisited}/${scanProgress.estimatedCensusBoxes} cuadrículas)`
                : `${scanProgress.scannedAntennas.toLocaleString('es-ES')} / ${scanProgress.totalAntennas.toLocaleString('es-ES')} antenas${
                    scanProgress.part ? ` · Parte ${scanProgress.part}` : ''
                  }`
              : scanProgress.status?.state === 'completed'
                ? scanProgress.status.trigger === 'schedule'
                  ? 'Último escaneo completado (100 %) · Diario 00:05 h'
                  : 'Último escaneo forzado completado (100 %)'
                : scanProgress.status?.state === 'stopped'
                  ? 'Último escaneo interrumpido · Listo para reintentar'
                  : 'Se activa durante el escaneo diario (00:05) o forzado'}
          </span>
        </div>

        <div className="metric-cell">
          <span className="metric-label">Antenas nuevas</span>
          <span className="metric-value">
            {latestScanCounts.antena.toLocaleString('es-ES')}
          </span>
        </div>

        <div className="metric-cell">
          <span className="metric-label">Frecuencias nuevas</span>
          <span className="metric-value">
            {latestScanCounts.frecuencia.toLocaleString('es-ES')}
          </span>
        </div>

        <div className="metric-cell">
          <span className="metric-label">Último escaneo</span>
          <span className="metric-value novedades-metric-datetime">
            {lastScanFormatted}
          </span>
          <span className="metric-sub">
            {dataset.isBaselineScan
              ? 'Línea base inicial · Próximo ciclo diario 00:05 h'
              : 'Día/Mes/Año y hora exacta (Europe/Madrid)'}
          </span>
        </div>
      </section>

      <section
        ref={tableSectionRef}
        className="section-block novedades-table-section"
        aria-labelledby="novedades-section-h2"
      >
        <h2 id="novedades-section-h2" className="sr-only">
          Tabla histórica acumulativa de antenas y frecuencias nuevas detectadas
        </h2>

        <div
          className="novedades-filters-panel"
          role="region"
          aria-label="Opciones de filtro de novedades"
        >
          <div className="novedades-filters-top-row">
            <div className="novedades-filters-heading">
              <SlidersHorizontal size={14} aria-hidden="true" />
              <span>Filtros</span>
            </div>

            {hasActiveFilters && (
              <button
                type="button"
                id="novedades-reset-filters-btn"
                className="btn btn-subtle btn-sm novedades-reset-btn"
                onClick={handleResetFilters}
              >
                <RotateCcw size={12} aria-hidden="true" />
                <span>Limpiar filtros</span>
              </button>
            )}
          </div>

          <div
            className="novedades-type-pills"
            role="group"
            aria-label="Filtrar por tipo de novedad"
          >
            <button
              type="button"
              id="novedades-filter-antenas"
              className={`novedades-filter-pill${
                tipoFilter === 'antena' ? ' is-active' : ''
              }`}
              onClick={() =>
                handleTipoChange(tipoFilter === 'antena' ? 'all' : 'antena')
              }
              aria-pressed={tipoFilter === 'antena'}
            >
              <RadioTower size={13} aria-hidden="true" />
              <span>Antenas Nuevas</span>
              <span className="novedades-pill-count mono">
                {latestScanCounts.antena.toLocaleString('es-ES')}
              </span>
            </button>

            <button
              type="button"
              id="novedades-filter-frecuencias"
              className={`novedades-filter-pill${
                tipoFilter === 'frecuencia' ? ' is-active' : ''
              }`}
              onClick={() =>
                handleTipoChange(
                  tipoFilter === 'frecuencia' ? 'all' : 'frecuencia',
                )
              }
              aria-pressed={tipoFilter === 'frecuencia'}
            >
              <span>Frecuencias Nuevas</span>
              <span className="novedades-pill-count mono">
                {latestScanCounts.frecuencia.toLocaleString('es-ES')}
              </span>
            </button>
          </div>

          <div
            className="novedades-operator-chips"
            role="group"
            aria-label="Filtro rápido por operadora"
          >
            <button
              type="button"
              id="novedades-op-chip-all"
              className={`novedades-op-chip${
                operatorFilter === 'all' ? ' is-active' : ''
              }`}
              onClick={() => handleOperatorChange('all')}
              aria-pressed={operatorFilter === 'all'}
            >
              <span>Todas las operadoras</span>
            </button>
            {OPERATOR_ORDER.map((opKey) => {
              const meta = OPERATOR_META[opKey];
              const isActive = operatorFilter === opKey;
              return (
                <button
                  key={opKey}
                  type="button"
                  id={`novedades-op-chip-${opKey}`}
                  className={`novedades-op-chip${isActive ? ' is-active' : ''}`}
                  style={
                    isActive
                      ? {
                          backgroundColor: getOperatorRowBackground(opKey, 0.22),
                          borderColor: meta.color,
                        }
                      : undefined
                  }
                  onClick={() =>
                    handleOperatorChange(isActive ? 'all' : opKey)
                  }
                  aria-pressed={isActive}
                >
                  <span
                    className="operator-dot"
                    style={{ backgroundColor: meta.color }}
                    aria-hidden="true"
                  />
                  <span>{getNovedadesOperatorLabel(opKey)}</span>
                  {latestScanCounts.byOp[opKey] > 0 && (
                    <span className="novedades-pill-count mono">
                      {latestScanCounts.byOp[opKey].toLocaleString('es-ES')}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="novedades-filters-grid">
            <div className="novedades-filter-field novedades-filter-field-search">
              <label
                htmlFor="novedades-search-input"
                className="novedades-filter-label"
              >
                Búsqueda libre
              </label>
              <div className="search-input-wrap">
                <span className="search-input-icon" aria-hidden="true">
                  <Search size={14} />
                </span>
                <input
                  id="novedades-search-input"
                  type="search"
                  className="search-input"
                  value={searchQuery}
                  onChange={(e) => handleSearchQueryChange(e.target.value)}
                  onBlur={handleSearchInputBlur}
                  placeholder="Código antena, código banda, MHz o ciudad…"
                />
                {searchQuery && (
                  <button
                    type="button"
                    className="search-clear-btn"
                    onClick={handleClearSearch}
                    aria-label="Limpiar búsqueda de novedades"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            </div>

            <div
              className="novedades-filter-pair"
              role="group"
              aria-label="Filtros de frecuencia y fecha"
            >
              <div className="novedades-filter-field">
                <label
                  htmlFor="novedades-band-filter"
                  className="novedades-filter-label"
                >
                  Frecuencia
                </label>
                <select
                  id="novedades-band-filter"
                  className="select-control"
                  value={bandFilter}
                  onChange={(e) => handleBandChange(e.target.value)}
                >
                  <option value="all">Todas las bandas</option>
                  {STANDARD_NOVEDADES_BANDS.map((band) => (
                    <option key={band} value={band}>
                      {band}
                    </option>
                  ))}
                </select>
              </div>

              <div className="novedades-filter-field">
                <label
                  htmlFor="novedades-date-filter"
                  className="novedades-filter-label"
                >
                  Fecha
                </label>
                <select
                  id="novedades-date-filter"
                  className="select-control"
                  value={dateFilter}
                  onChange={(e) => handleDateChange(e.target.value)}
                >
                  <option value="all">Todas las fechas</option>
                  {availableScanDates.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div
              className="novedades-filter-pair"
              role="group"
              aria-label="Filtros de ubicación por comunidad autónoma y provincia"
            >
              <div className="novedades-filter-field">
                <label
                  htmlFor="novedades-ccaa-filter"
                  className="novedades-filter-label"
                >
                  Comunidad Autónoma
                </label>
                <select
                  id="novedades-ccaa-filter"
                  className="select-control"
                  value={comunidadFilter}
                  onChange={(e) => handleComunidadChange(e.target.value)}
                >
                  <option value="all">Todas las comunidades</option>
                  {availableComunidades.map((ccaa) => (
                    <option key={ccaa} value={ccaa}>
                      {ccaa}
                    </option>
                  ))}
                </select>
              </div>

              <div className="novedades-filter-field">
                <label
                  htmlFor="novedades-province-filter"
                  className="novedades-filter-label"
                >
                  Provincia
                </label>
                <select
                  id="novedades-province-filter"
                  className="select-control"
                  value={provinceFilter}
                  onChange={(e) => handleProvinceChange(e.target.value)}
                >
                  <option value="all">Todas las provincias</option>
                  {availableProvinces.map((prov) => (
                    <option key={prov} value={prov}>
                      {prov}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </div>

        {hasActiveFilters && dataset.novedades.length > 0 && (
          <div className="novedades-results-status" aria-live="polite">
            Coinciden{' '}
            <strong className="mono">
              {filteredRows.length.toLocaleString('es-ES')}
            </strong>{' '}
            de{' '}
            <span className="mono">
              {dataset.novedades.length.toLocaleString('es-ES')}
            </span>{' '}
            novedades registradas
          </div>
        )}

        <div className="novedades-table-wrap">
          <table className="novedades-table" id="novedades-table">
            <thead>
              <tr>
                <th scope="col" className="novedades-col-novedad">
                  Novedad
                </th>
                <th scope="col">Código</th>
                <th scope="col">Código Banda</th>
                <th scope="col">Frecuencia</th>
                <th scope="col">Ubicación</th>
                <th scope="col">Fecha</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.length > 0 ? (
                visibleRows.map((row) => {
                  const meta = OPERATOR_META[row.op];
                  const operatorDisplayName = getNovedadesOperatorLabel(
                    row.op,
                    row.opRaw,
                  );
                  const isFrecuencia = row.tipo === 'frecuencia';
                  const isAssociatedNewAntFreq =
                    isFrecuencia &&
                    newAntennaKeys.has(
                      `${getNovedadScanBatchKey(row)}@@${getNovedadAntennaGroupKey(row)}`,
                    );
                  const formattedFecha = formatScanDateTimeDmyHms(
                    row.scannedAt,
                    row.fecha,
                  );
                  const dateLines = splitScanDateTimeLines(formattedFecha);
                  const freqLines = isFrecuencia
                    ? splitFrequencyRangeLines(row.frecuencia)
                    : null;
                  const rowBgColor = getOperatorRowBackground(row.op, 0.5);

                  return (
                    <tr
                      key={row.id}
                      className={`novedades-row${
                        isAssociatedNewAntFreq ? ' is-associated-freq' : ''
                      }`}
                      data-operator={row.op}
                      style={{ backgroundColor: rowBgColor }}
                    >
                      <td className="novedades-col-novedad">
                        <div className="novedades-cell-novedad">
                          <span
                            className={`novedades-badge ${
                              isFrecuencia ? 'is-frecuencia' : 'is-antena'
                            }`}
                          >
                            {!isFrecuencia && (
                              <RadioTower size={11} aria-hidden="true" />
                            )}
                            <span>{isFrecuencia ? 'Frecuencia' : 'Antena'}</span>
                          </span>

                          <span
                            className="novedades-operator-tag"
                            title={row.opRaw || meta.description}
                          >
                            <span className="novedades-operator-name">
                              {operatorDisplayName}
                            </span>
                          </span>
                        </div>
                      </td>

                      <td>
                        <Link
                          to="/"
                          search={{
                            gid: row.codigo,
                            id: row.antennaId || undefined,
                          }}
                          onClick={flushNovedadesStateBeforeLeaving}
                          className="novedades-code-link mono"
                          title="Ver esta antena en el mapa interactivo"
                        >
                          {row.codigo}
                        </Link>
                      </td>

                      <td
                        className={
                          !isFrecuencia ? 'is-antena-placeholder' : undefined
                        }
                      >
                        {isFrecuencia ? (
                          <span className="mono novedades-band-code">
                            {row.codigoBanda || 'Sin código'}
                          </span>
                        ) : (
                          <span
                            className="novedades-antena-cell-icon"
                            role="img"
                            aria-label="Antena"
                          >
                            <RadioTower size={12} aria-hidden="true" />
                          </span>
                        )}
                      </td>

                      <td
                        className={
                          !isFrecuencia ? 'is-antena-placeholder' : undefined
                        }
                      >
                        {isFrecuencia ? (
                          freqLines ? (
                            <span
                              className="mono novedades-freq-exact novedades-freq-stack"
                              title={row.frecuencia || undefined}
                            >
                              <span className="novedades-freq-line novedades-freq-start">
                                {freqLines.start}
                              </span>
                              {freqLines.end && (
                                <span className="novedades-freq-line novedades-freq-end">
                                  {freqLines.end}
                                </span>
                              )}
                            </span>
                          ) : (
                            <span
                              className="novedades-empty-cell"
                              aria-label="Sin frecuencia registrada"
                            >
                              —
                            </span>
                          )
                        ) : (
                          <span
                            className="novedades-antena-cell-icon"
                            role="img"
                            aria-label="Antena"
                          >
                            <RadioTower size={12} aria-hidden="true" />
                          </span>
                        )}
                      </td>

                      <td>
                        <span
                          className="novedades-location-cell"
                          title={
                            row.prov && row.ubicacion
                              ? `${row.ubicacion} (${row.prov})`
                              : row.ubicacion || undefined
                          }
                        >
                          {row.ubicacion || '—'}
                        </span>
                      </td>

                      <td>
                        <span
                          className="mono novedades-date-cell"
                          title={
                            formattedFecha !== '—' ? formattedFecha : undefined
                          }
                        >
                          <span className="novedades-date-day">
                            {dateLines.datePart}
                          </span>
                          {dateLines.timePart && (
                            <span className="novedades-date-time">
                              {dateLines.timePart}
                            </span>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} className="novedades-empty-state-cell">
                    {dataset.novedades.length === 0 ? (
                      <div className="novedades-empty-box">
                        <div
                          className="novedades-empty-icon"
                          aria-hidden="true"
                        >
                          {dataset.isBaselineScan ? (
                            <Clock size={20} />
                          ) : (
                            <Sparkles size={20} />
                          )}
                        </div>
                        <p className="novedades-empty-title">
                          {dataset.isBaselineScan
                            ? '0 novedades registradas todavía (línea base activa)'
                            : '0 antenas o frecuencias nuevas registradas todavía'}
                        </p>
                        <p className="novedades-empty-desc">
                          {dataset.isBaselineScan ? (
                            <>
                              El escaneo base actual (
                              <span className="mono">{lastScanFormatted}</span>)
                              sirve de referencia inicial y no contabiliza
                              novedades. Las nuevas antenas y concesiones de
                              frecuencia se irán añadiendo de forma permanente a
                              esta tabla tras cada escaneo diario de las{' '}
                              <strong>00:05 h</strong> o forzado.
                            </>
                          ) : (
                            <>
                              Aún no se han registrado altas de nuevas antenas ni
                              nuevas concesiones de frecuencia hasta el último
                              escaneo del{' '}
                              <span className="mono">{lastScanFormatted}</span>.
                              Las novedades que se detecten quedarán guardadas de
                              forma permanente tras cada escaneo automático de las{' '}
                              <strong>00:05 h</strong>.
                            </>
                          )}
                        </p>
                      </div>
                    ) : (
                      <div className="novedades-empty-box">
                        <p className="novedades-empty-title">
                          Ninguna novedad coincide con los filtros aplicados
                        </p>
                        <p className="novedades-empty-desc">
                          Prueba con otro término de búsqueda, operadora,
                          frecuencia, fecha, comunidad autónoma, provincia o tipo
                          de novedad.
                        </p>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={handleResetFilters}
                        >
                          <RotateCcw size={13} aria-hidden="true" />
                          <span>Restablecer filtros</span>
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div
          id="novedades-pagination-bar"
          className="novedades-pagination-bar"
          role="region"
          aria-label="Controles de paginación de la tabla de novedades"
        >
          <div className="novedades-pagination-left">
            <div className="novedades-page-size-group">
              <label
                htmlFor="novedades-page-size-select"
                className="novedades-pagination-label"
              >
                Filas por página
              </label>
              <select
                id="novedades-page-size-select"
                className="select-control novedades-page-size-select"
                value={pageSize}
                onChange={(e) => handlePageSizeChange(e.target.value)}
              >
                {NOVEDADES_PAGE_SIZE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>

            <span className="novedades-pagination-info" aria-live="polite">
              {totalItems > 0 ? (
                <>
                  Mostrando{' '}
                  <strong className="mono">
                    {startRow.toLocaleString('es-ES')}–
                    {endRow.toLocaleString('es-ES')}
                  </strong>{' '}
                  de{' '}
                  <strong className="mono">
                    {totalItems.toLocaleString('es-ES')}
                  </strong>{' '}
                  {totalItems === 1 ? 'fila' : 'filas'}
                </>
              ) : (
                <>
                  Mostrando <strong className="mono">0</strong> filas
                </>
              )}
            </span>
          </div>

          <div className="novedades-pagination-right">
            <nav
              className="novedades-page-nav"
              aria-label="Selector de páginas de novedades"
            >
              <button
                type="button"
                id="novedades-page-first"
                className="novedades-page-btn novedades-page-step-btn"
                onClick={() => goToPage(1)}
                disabled={currentPage <= 1}
                title="Primera página"
                aria-label="Primera página"
              >
                <ChevronsLeft size={14} aria-hidden="true" />
              </button>

              <button
                type="button"
                id="novedades-page-prev"
                className="novedades-page-btn novedades-page-step-btn"
                onClick={() => goToPage(currentPage - 1)}
                disabled={currentPage <= 1}
                title="Página anterior"
                aria-label="Página anterior"
              >
                <ChevronLeft size={14} aria-hidden="true" />
              </button>

              <div className="novedades-page-numbers">
                {paginationTokens.map((token) =>
                  typeof token === 'number' ? (
                    <button
                      key={token}
                      type="button"
                      className={`novedades-page-btn mono${
                        token === currentPage ? ' is-active' : ''
                      }`}
                      onClick={() => goToPage(token)}
                      aria-label={`Ir a la página ${token}`}
                      aria-current={token === currentPage ? 'page' : undefined}
                    >
                      {token.toLocaleString('es-ES')}
                    </button>
                  ) : (
                    <button
                      key={token}
                      type="button"
                      className="novedades-page-ellipsis mono"
                      onClick={focusPageJumpInput}
                      disabled={totalPages <= 1}
                      title="Escribir número de página"
                      aria-label="Escribir número de página concreta"
                    >
                      …
                    </button>
                  ),
                )}
              </div>

              <button
                type="button"
                id="novedades-page-next"
                className="novedades-page-btn novedades-page-step-btn"
                onClick={() => goToPage(currentPage + 1)}
                disabled={currentPage >= totalPages}
                title="Página siguiente"
                aria-label="Página siguiente"
              >
                <ChevronRight size={14} aria-hidden="true" />
              </button>

              <button
                type="button"
                id="novedades-page-last"
                className="novedades-page-btn novedades-page-step-btn"
                onClick={() => goToPage(totalPages)}
                disabled={currentPage >= totalPages}
                title="Última página"
                aria-label="Última página"
              >
                <ChevronsRight size={14} aria-hidden="true" />
              </button>
            </nav>

            <form
              className="novedades-page-jump"
              onSubmit={handlePageJumpSubmit}
            >
              <label
                htmlFor="novedades-page-input"
                className="novedades-pagination-label"
              >
                Ir a página
              </label>
              <input
                ref={pageInputRef}
                id="novedades-page-input"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                className="novedades-page-input mono"
                value={displayedPageInput}
                onChange={(e) => {
                  const digitsOnly = e.target.value.replace(/\D+/g, '');
                  setPageInputDraft({
                    key: pageInputKey,
                    value: digitsOnly,
                  });
                }}
                onBlur={(e) => {
                  const nextFocused = e.relatedTarget;
                  if (
                    nextFocused instanceof HTMLElement &&
                    nextFocused.id === 'novedades-page-jump-btn'
                  ) {
                    return;
                  }
                  setPageInputDraft(null);
                }}
                onKeyDown={handlePageInputKeyDown}
                disabled={totalPages <= 1}
                aria-label={`Seleccionar página concreta (1 a ${totalPages})`}
              />
              <span className="novedades-page-total">
                de{' '}
                <strong className="mono">
                  {totalPages.toLocaleString('es-ES')}
                </strong>
              </span>
              <button
                type="submit"
                id="novedades-page-jump-btn"
                className="btn btn-secondary btn-sm novedades-page-jump-btn"
                disabled={totalPages <= 1}
              >
                Ir
              </button>
            </form>
          </div>
        </div>
      </section>

      <div className="novedades-corner-wrap" ref={cornerPopoverRef}>
        {keyPopoverOpen && (
          <form
            className="novedades-corner-key-popover"
            id="novedades-corner-key-popover"
            onSubmit={handleKeySubmit}
          >
            <input
              ref={cornerKeyInputRef}
              id="novedades-corner-key-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              className={`novedades-corner-key-input mono${
                keyError ? ' is-error' : ''
              }`}
              placeholder="ghp_…"
              value={tokenDraft}
              onChange={(e) => {
                setTokenDraft(e.target.value);
                if (keyError) {
                  setKeyError(false);
                }
              }}
              aria-label="Token"
            />
            <button
              id="novedades-corner-key-submit"
              type="submit"
              className="novedades-corner-key-submit"
              disabled={!tokenDraft.trim() || isDispatching}
              aria-label="OK"
            >
              <Check size={12} aria-hidden="true" />
            </button>
          </form>
        )}

        <button
          id="novedades-corner-scan-btn"
          type="button"
          className={`novedades-corner-scan-btn${
            isDispatching ? ' is-dispatching' : ''
          }${scanProgress.isScanning ? ' is-scanning' : ''}${
            cornerFeedback === 'ok' ? ' is-ok' : ''
          }${cornerFeedback === 'err' ? ' is-err' : ''}`}
          aria-label="Control"
          onClick={handleCornerScanClick}
        >
          <RefreshCw size={10} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
    </main>
  );
}
