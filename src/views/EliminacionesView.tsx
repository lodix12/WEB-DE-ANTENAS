import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { Link, useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Clock,
  MapPin,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import { useAntenasData } from '../hooks/useAntenasData';
import {
  STANDARD_ELIMINACIONES_BANDS,
  computeLatestScanEliminacionesCounts,
  filterEliminaciones,
  getEliminacionAntennaGroupKey,
  getEliminacionScanBatchKey,
  orderEliminacionesGroupedByRemovedAntenna,
  resolveEliminacionesTableStateFromSearch,
  serializeEliminacionesTableStateToSearch,
  useEliminacionesData,
} from '../hooks/useEliminacionesData';
import {
  NOVEDADES_PAGE_SIZE_OPTIONS,
  NOVEDADES_SPANISH_COMUNIDADES,
  buildPaginationTokens,
  extractScanDayDmy,
  formatScanDateTimeDmyHms,
  getNovedadesOperatorLabel,
  getNovedadesProvincesForComunidad,
  getOperatorRowBackground,
  isValidNovedadesPageSize,
  paginateNovedades,
  resolveNovedadComunidad,
  resolveNovedadProvince,
  splitFrequencyRangeLines,
  splitScanDateTimeLines,
  type NovedadesTableViewState,
} from '../hooks/useNovedadesData';
import { useScanProgress } from '../hooks/useScanProgress';
import {
  OPERATOR_META,
  OPERATOR_ORDER,
  type EliminacionTipo,
  type OperatorKey,
} from '../types/antena';

export function EliminacionesView() {
  const navigate = useNavigate();
  const router = useRouter();
  const rawSearch = useSearch({ strict: false });
  const urlState = useMemo(
    () => resolveEliminacionesTableStateFromSearch(rawSearch),
    [rawSearch],
  );

  const {
    data: dataset,
    isLoading,
    isError,
    error,
    refetch,
  } = useEliminacionesData();
  const { derived } = useAntenasData();
  const scanProgress = useScanProgress(derived?.dataset.total ?? 62230);

  const pageInputRef = useRef<HTMLInputElement | null>(null);
  const searchSyncTimerRef = useRef<number | null>(null);
  const pendingSearchQueryRef = useRef<string | null>(null);
  const latestCommittedStateRef = useRef<NovedadesTableViewState>(urlState);
  const pendingCommitCountRef = useRef(0);

  const [localSearchQuery, setLocalSearchQuery] = useState(
    urlState.searchQuery,
  );
  const [pageInputDraft, setPageInputDraft] = useState<{
    key: string;
    value: string;
  } | null>(null);

  useEffect(() => {
    document.title =
      'Eliminaciones · Censo de Antenas y Frecuencias Móviles en España';
  }, []);

  useEffect(() => {
    return () => {
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
    () => computeLatestScanEliminacionesCounts(dataset),
    [dataset],
  );

  const orderedEliminaciones = useMemo(
    () =>
      dataset
        ? orderEliminacionesGroupedByRemovedAntenna(dataset.eliminaciones)
        : [],
    [dataset],
  );

  const availableComunidades = useMemo(() => {
    const comunidades = new Set<string>(NOVEDADES_SPANISH_COMUNIDADES);
    for (let i = 0; i < orderedEliminaciones.length; i++) {
      const comunidad = resolveNovedadComunidad(orderedEliminaciones[i]).trim();
      if (comunidad) {
        comunidades.add(comunidad);
      }
    }
    return Array.from(comunidades).sort((a, b) => a.localeCompare(b, 'es'));
  }, [orderedEliminaciones]);

  const availableProvinces = useMemo(() => {
    const provinces = new Set<string>(
      getNovedadesProvincesForComunidad(comunidadFilter),
    );
    for (let i = 0; i < orderedEliminaciones.length; i++) {
      const row = orderedEliminaciones[i];
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
  }, [comunidadFilter, orderedEliminaciones]);

  const availableScanDates = useMemo(() => {
    const dates = new Set<string>();
    for (let i = 0; i < orderedEliminaciones.length; i++) {
      const row = orderedEliminaciones[i];
      const day = extractScanDayDmy(row.scannedAt, row.fecha);
      if (day && day !== '—') {
        dates.add(day);
      }
    }
    return Array.from(dates);
  }, [orderedEliminaciones]);

  const removedAntennaKeys = useMemo(() => {
    const keys = new Set<string>();
    for (let i = 0; i < orderedEliminaciones.length; i++) {
      const r = orderedEliminaciones[i];
      if (r.tipo === 'antena') {
        keys.add(
          `${getEliminacionScanBatchKey(r)}@@${getEliminacionAntennaGroupKey(r)}`,
        );
      }
    }
    return keys;
  }, [orderedEliminaciones]);

  const filteredRows = useMemo(() => {
    if (orderedEliminaciones.length === 0) return [];
    return filterEliminaciones({
      eliminaciones: orderedEliminaciones,
      tipoFilter,
      operatorFilter,
      bandFilter,
      comunidadFilter,
      provinceFilter,
      dateFilter,
      searchQuery,
    });
  }, [
    orderedEliminaciones,
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
      to: '/eliminaciones',
      search: serializeEliminacionesTableStateToSearch(nextState),
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

  function handleTipoChange(nextTipo: 'all' | EliminacionTipo) {
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
        const inDatasetRows = orderedEliminaciones.some(
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
      <main className="page-container novedades-page eliminaciones-page">
        <div className="state-center-box">
          <div className="spinner-ring" aria-hidden="true" />
          <p style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
            Cargando registro de eliminaciones de antenas y frecuencias…
          </p>
        </div>
      </main>
    );
  }

  if (isError || !dataset) {
    return (
      <main className="page-container novedades-page eliminaciones-page">
        <div className="state-center-box">
          <h1
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: 'var(--text-primary)',
            }}
          >
            Error al cargar las eliminaciones del censo
          </h1>
          <p style={{ maxWidth: 460 }}>
            {error instanceof Error
              ? error.message
              : 'No se pudo descargar data/eliminaciones.json.'}
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

  function flushEliminacionesStateBeforeLeaving() {
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
      to: '/eliminaciones',
      search: serializeEliminacionesTableStateToSearch(stateToPersist),
    });

    if (router.history.location.href !== targetLocation.href) {
      router.history.replace(
        targetLocation.href,
        router.history.location.state,
      );
    }
    router.history.flush();
  }

  function goToPage(nextPage: number) {
    const clamped = Math.min(Math.max(1, Math.trunc(nextPage)), totalPages);
    updateViewState((prev) => ({
      ...prev,
      page: clamped,
    }));
  }

  function handlePageSizeChange(rawValue: string) {
    const parsed = Number.parseInt(rawValue, 10);
    if (isValidNovedadesPageSize(parsed)) {
      updateViewState((prev) => ({
        ...prev,
        pageSize: parsed,
        page: 1,
      }));
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
    inputEl.focus({ preventScroll: true });
    inputEl.select();
  }

  return (
    <main className="page-container novedades-page eliminaciones-page">
      <header className="page-hero novedades-hero">
        <h1 className="page-h1">Eliminaciones</h1>
      </header>

      <section
        className="metrics-strip novedades-metrics-strip"
        aria-label="Resumen del último escaneo de eliminaciones"
      >
        <div
          id="eliminaciones-scan-monitor"
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
              id="eliminaciones-scan-percent"
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
          <span className="metric-label">Antenas eliminadas</span>
          <span className="metric-value">
            {latestScanCounts.antena.toLocaleString('es-ES')}
          </span>
        </div>

        <div className="metric-cell">
          <span className="metric-label">Frecuencias eliminadas</span>
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
              ? 'Línea base inicial · Próximo ciclo de escaneo'
              : 'Día/Mes/Año y hora exacta (Europe/Madrid)'}
          </span>
        </div>
      </section>

      <section
        className="section-block novedades-table-section"
        aria-labelledby="eliminaciones-section-h2"
      >
        <h2 id="eliminaciones-section-h2" className="sr-only">
          Tabla histórica acumulativa de antenas y frecuencias eliminadas de
          MINETUR
        </h2>

        <div
          className="novedades-filters-panel"
          role="region"
          aria-label="Opciones de filtro de eliminaciones"
        >
          <div className="novedades-filters-top-row">
            <div className="novedades-filters-heading">
              <SlidersHorizontal size={14} aria-hidden="true" />
              <span>Filtros</span>
            </div>

            {hasActiveFilters && (
              <button
                type="button"
                id="eliminaciones-reset-filters-btn"
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
            aria-label="Filtrar por tipo de eliminación"
          >
            <button
              type="button"
              id="eliminaciones-filter-antenas"
              className={`novedades-filter-pill${
                tipoFilter === 'antena' ? ' is-active is-eliminaciones' : ''
              }`}
              onClick={() =>
                handleTipoChange(tipoFilter === 'antena' ? 'all' : 'antena')
              }
              aria-pressed={tipoFilter === 'antena'}
            >
              <RadioTower size={13} aria-hidden="true" />
              <span>Antenas Eliminadas</span>
              <span className="novedades-pill-count mono">
                {latestScanCounts.antena.toLocaleString('es-ES')}
              </span>
            </button>

            <button
              type="button"
              id="eliminaciones-filter-frecuencias"
              className={`novedades-filter-pill${
                tipoFilter === 'frecuencia' ? ' is-active is-eliminaciones' : ''
              }`}
              onClick={() =>
                handleTipoChange(
                  tipoFilter === 'frecuencia' ? 'all' : 'frecuencia',
                )
              }
              aria-pressed={tipoFilter === 'frecuencia'}
            >
              <span>Frecuencias Eliminadas</span>
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
              id="eliminaciones-op-chip-all"
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
                  id={`eliminaciones-op-chip-${opKey}`}
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
                htmlFor="eliminaciones-search-input"
                className="novedades-filter-label"
              >
                Búsqueda libre
              </label>
              <div className="search-input-wrap">
                <span className="search-input-icon" aria-hidden="true">
                  <Search size={14} />
                </span>
                <input
                  id="eliminaciones-search-input"
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
                    aria-label="Limpiar búsqueda de eliminaciones"
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
                  htmlFor="eliminaciones-band-filter"
                  className="novedades-filter-label"
                >
                  Frecuencia
                </label>
                <select
                  id="eliminaciones-band-filter"
                  className="select-control"
                  value={bandFilter}
                  onChange={(e) => handleBandChange(e.target.value)}
                >
                  <option value="all">Todas las bandas</option>
                  {STANDARD_ELIMINACIONES_BANDS.map((band) => (
                    <option key={band} value={band}>
                      {band}
                    </option>
                  ))}
                </select>
              </div>

              <div className="novedades-filter-field">
                <label
                  htmlFor="eliminaciones-date-filter"
                  className="novedades-filter-label"
                >
                  Fecha
                </label>
                <select
                  id="eliminaciones-date-filter"
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
                  htmlFor="eliminaciones-ccaa-filter"
                  className="novedades-filter-label"
                >
                  Comunidad Autónoma
                </label>
                <select
                  id="eliminaciones-ccaa-filter"
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
                  htmlFor="eliminaciones-province-filter"
                  className="novedades-filter-label"
                >
                  Provincia
                </label>
                <select
                  id="eliminaciones-province-filter"
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

        {hasActiveFilters && dataset.eliminaciones.length > 0 && (
          <div className="novedades-results-status" aria-live="polite">
            Coinciden{' '}
            <strong className="mono">
              {filteredRows.length.toLocaleString('es-ES')}
            </strong>{' '}
            de{' '}
            <span className="mono">
              {dataset.eliminaciones.length.toLocaleString('es-ES')}
            </span>{' '}
            eliminaciones registradas
          </div>
        )}

        <div className="novedades-table-wrap">
          <table className="novedades-table" id="eliminaciones-table">
            <thead>
              <tr>
                <th scope="col" className="novedades-col-novedad">
                  Baja
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
                  const batchAntKey = `${getEliminacionScanBatchKey(row)}@@${getEliminacionAntennaGroupKey(row)}`;
                  const isAssociatedRemovedAntFreq =
                    isFrecuencia && removedAntennaKeys.has(batchAntKey);
                  const isWholeAntennaRemoved =
                    !isFrecuencia || isAssociatedRemovedAntFreq;
                  const formattedFecha = formatScanDateTimeDmyHms(
                    row.scannedAt,
                    row.fecha,
                  );
                  const dateLines = splitScanDateTimeLines(formattedFecha);
                  const freqLines = isFrecuencia
                    ? splitFrequencyRangeLines(row.frecuencia)
                    : null;
                  const rowBgColor = getOperatorRowBackground(row.op, 0.5);
                  const hasCoords =
                    typeof row.lat === 'number' &&
                    Number.isFinite(row.lat) &&
                    typeof row.lon === 'number' &&
                    Number.isFinite(row.lon);
                  const stillExistsInCensus = Boolean(
                    derived &&
                      ((row.antennaId && derived.byId.has(row.antennaId)) ||
                        (row.codigo && derived.byGid.has(row.codigo))),
                  );

                  return (
                    <tr
                      key={row.id}
                      className={`novedades-row${
                        isAssociatedRemovedAntFreq ? ' is-associated-freq' : ''
                      }`}
                      data-operator={row.op}
                      style={{ backgroundColor: rowBgColor }}
                    >
                      <td className="novedades-col-novedad">
                        <div className="novedades-cell-novedad">
                          <span
                            className={`novedades-badge eliminaciones-badge ${
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
                        {!isWholeAntennaRemoved || stillExistsInCensus ? (
                          <Link
                            to="/"
                            search={{
                              gid: row.codigo,
                              id: row.antennaId || undefined,
                              ...(hasCoords
                                ? { lat: row.lat, lon: row.lon }
                                : {}),
                            }}
                            onClick={flushEliminacionesStateBeforeLeaving}
                            className="novedades-code-link mono"
                            title="Ver esta antena en el mapa interactivo"
                          >
                            {row.codigo}
                          </Link>
                        ) : hasCoords ? (
                          <Link
                            to="/"
                            search={{
                              lat: row.lat,
                              lon: row.lon,
                            }}
                            onClick={flushEliminacionesStateBeforeLeaving}
                            className="novedades-code-link eliminaciones-code-coords-link mono"
                            title="Antena retirada de MINETUR · Ver su último emplazamiento en el mapa"
                          >
                            <MapPin size={10} aria-hidden="true" />
                            <span>{row.codigo}</span>
                          </Link>
                        ) : (
                          <span
                            className="eliminaciones-code-static mono"
                            title="Antena retirada de MINETUR"
                          >
                            {row.codigo}
                          </span>
                        )}
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
                            className="novedades-antena-cell-icon eliminaciones-antena-cell-icon"
                            role="img"
                            aria-label="Antena eliminada"
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
                            className="novedades-antena-cell-icon eliminaciones-antena-cell-icon"
                            role="img"
                            aria-label="Antena eliminada"
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
                    {dataset.eliminaciones.length === 0 ? (
                      <div className="novedades-empty-box">
                        <div
                          className="novedades-empty-icon is-eliminaciones"
                          aria-hidden="true"
                        >
                          {dataset.isBaselineScan ? (
                            <Clock size={20} />
                          ) : (
                            <Trash2 size={20} />
                          )}
                        </div>
                        <p className="novedades-empty-title">
                          {dataset.isBaselineScan
                            ? '0 eliminaciones registradas todavía (línea base activa)'
                            : '0 antenas o frecuencias eliminadas registradas todavía'}
                        </p>
                        <p className="novedades-empty-desc">
                          {dataset.isBaselineScan ? (
                            <>
                              El escaneo base actual (
                              <span className="mono">{lastScanFormatted}</span>)
                              sirve de referencia inicial. Cuando una operadora
                              retire realmente una antena o banda en MINETUR (sin
                              errores de servidor), se eliminará del mapa y
                              quedará registrada aquí de forma permanente.
                            </>
                          ) : (
                            <>
                              Aún no se han detectado bajas reales de antenas ni
                              retiradas verificadas de frecuencias hasta el
                              último escaneo del{' '}
                              <span className="mono">{lastScanFormatted}</span>.
                              Las eliminaciones reales confirmadas en MINETUR se
                              borran automáticamente del mapa y quedan guardadas
                              aquí de forma permanente.
                            </>
                          )}
                        </p>
                      </div>
                    ) : (
                      <div className="novedades-empty-box">
                        <p className="novedades-empty-title">
                          Ninguna eliminación coincide con los filtros aplicados
                        </p>
                        <p className="novedades-empty-desc">
                          Prueba con otro término de búsqueda, operadora,
                          frecuencia, fecha, comunidad autónoma, provincia o tipo
                          de eliminación.
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
          id="eliminaciones-pagination-bar"
          className="novedades-pagination-bar"
          role="region"
          aria-label="Controles de paginación de la tabla de eliminaciones"
        >
          <div className="novedades-pagination-left">
            <div className="novedades-page-size-group">
              <label
                htmlFor="eliminaciones-page-size-select"
                className="novedades-pagination-label"
              >
                Filas por página
              </label>
              <select
                id="eliminaciones-page-size-select"
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
              aria-label="Selector de páginas de eliminaciones"
            >
              <button
                type="button"
                id="eliminaciones-page-first"
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
                id="eliminaciones-page-prev"
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
                id="eliminaciones-page-next"
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
                id="eliminaciones-page-last"
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
                htmlFor="eliminaciones-page-input"
                className="novedades-pagination-label"
              >
                Ir a página
              </label>
              <input
                ref={pageInputRef}
                id="eliminaciones-page-input"
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
                    nextFocused.id === 'eliminaciones-page-jump-btn'
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
                id="eliminaciones-page-jump-btn"
                className="btn btn-secondary btn-sm novedades-page-jump-btn"
                disabled={totalPages <= 1}
              >
                Ir
              </button>
            </form>
          </div>
        </div>
      </section>
    </main>
  );
}
