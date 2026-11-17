import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { Link } from '@tanstack/react-router';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Clock,
  Radio,
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
  DEFAULT_NOVEDADES_PAGE_SIZE,
  NOVEDADES_PAGE_SIZE_OPTIONS,
  NOVEDADES_SPANISH_COMUNIDADES,
  STANDARD_NOVEDADES_BANDS,
  buildPaginationTokens,
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
  splitFrequencyRangeLines,
  splitScanDateTimeLines,
  useNovedadesData,
  type NovedadesPageSize,
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

  const [isDispatching, setIsDispatching] = useState(false);
  const [cornerFeedback, setCornerFeedback] = useState<'ok' | 'err' | null>(
    null,
  );
  const [keyPopoverOpen, setKeyPopoverOpen] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [keyError, setKeyError] = useState(false);

  const [tipoFilter, setTipoFilter] = useState<'all' | NovedadTipo>('all');
  const [operatorFilter, setOperatorFilter] = useState<'all' | OperatorKey>(
    'all',
  );
  const [bandFilter, setBandFilter] = useState<string>('all');
  const [comunidadFilter, setComunidadFilter] = useState<string>('all');
  const [provinceFilter, setProvinceFilter] = useState<string>('all');
  const [dateFilter, setDateFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [pageSize, setPageSize] = useState<NovedadesPageSize>(
    DEFAULT_NOVEDADES_PAGE_SIZE,
  );
  const [pageState, setPageState] = useState<{
    key: string;
    page: number;
    draftInput: string | null;
  }>({
    key: '',
    page: 1,
    draftInput: null,
  });

  useEffect(() => {
    document.title =
      'Novedades · Censo de Antenas y Frecuencias Móviles en España';
  }, []);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current !== null) {
        window.clearTimeout(feedbackTimerRef.current);
      }
    };
  }, []);

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

  const filterKey = `${tipoFilter}|${operatorFilter}|${bandFilter}|${comunidadFilter}|${provinceFilter}|${dateFilter}|${searchQuery}|${pageSize}`;
  const requestedPage = pageState.key === filterKey ? pageState.page : 1;

  const summaryCounts = useMemo(() => {
    const byOp: Record<OperatorKey, number> = {
      movistar: 0,
      orange: 0,
      vodafone: 0,
      masmovil: 0,
      digi: 0,
      otros: 0,
    };
    if (!dataset) {
      return { all: 0, antena: 0, frecuencia: 0, byOp };
    }
    let antena = 0;
    let frecuencia = 0;
    for (let i = 0; i < dataset.novedades.length; i++) {
      const item = dataset.novedades[i];
      if (item.tipo === 'antena') {
        antena += 1;
      } else {
        frecuencia += 1;
      }
      if (item.op in byOp) {
        byOp[item.op] += 1;
      }
    }
    return {
      all: dataset.novedades.length,
      antena: dataset.antenasNuevas ?? antena,
      frecuencia: dataset.frecuenciasNuevas ?? frecuencia,
      byOp,
    };
  }, [dataset]);

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

  function handleComunidadChange(nextComunidad: string) {
    setComunidadFilter(nextComunidad);
    if (nextComunidad !== 'all' && provinceFilter !== 'all') {
      const inStaticProvinces =
        getNovedadesProvincesForComunidad(nextComunidad).includes(
          provinceFilter,
        );
      const inDatasetRows = orderedNovedades.some(
        (row) =>
          resolveNovedadProvince(row) === provinceFilter &&
          resolveNovedadComunidad(row) === nextComunidad,
      );
      if (!inStaticProvinces && !inDatasetRows) {
        setProvinceFilter('all');
      }
    }
  }

  function handleResetFilters() {
    setTipoFilter('all');
    setOperatorFilter('all');
    setBandFilter('all');
    setComunidadFilter('all');
    setProvinceFilter('all');
    setDateFilter('all');
    setSearchQuery('');
    setPageState({ key: '', page: 1, draftInput: null });
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
  const displayedPageInput =
    pageState.key === filterKey && pageState.draftInput !== null
      ? pageState.draftInput
      : String(currentPage);

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
    setPageState({ key: filterKey, page: clamped, draftInput: null });
    if (clamped !== currentPage) {
      scrollTableTopIfNeeded();
    }
  }

  function handlePageSizeChange(rawValue: string) {
    const parsed = Number.parseInt(rawValue, 10);
    if (isValidNovedadesPageSize(parsed)) {
      setPageSize(parsed);
      setPageState({ key: '', page: 1, draftInput: null });
      scrollTableTopIfNeeded();
    }
  }

  function handlePageJumpSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = displayedPageInput.trim();
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
      setPageState({ key: filterKey, page: currentPage, draftInput: null });
      return;
    }
    goToPage(parsed);
  }

  function handlePageInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      setPageState({ key: filterKey, page: currentPage, draftInput: null });
      event.currentTarget.blur();
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const base = Number.parseInt(displayedPageInput, 10);
      const start = Number.isFinite(base) ? base : currentPage;
      const delta = event.key === 'ArrowUp' ? 1 : -1;
      const next = Math.min(Math.max(1, start + delta), totalPages);
      setPageState({
        key: filterKey,
        page: currentPage,
        draftInput: String(next),
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
      <header className="page-hero">
        <span className="page-eyebrow">
          Monitorización Diaria del Espectro · 18:00 h
        </span>
        <h1 className="page-h1">Novedades de Antenas y Frecuencias</h1>
        <p className="page-lead">
          Registro permanente y acumulativo de nuevas antenas y concesiones de
          frecuencia detectadas en cada escaneo (programado todos los días a las
          18:00 h).
        </p>
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
                    ? 'Diario · 18:00'
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
                  ? 'Último escaneo completado (100 %) · Diario 18:00 h'
                  : 'Último escaneo forzado completado (100 %)'
                : scanProgress.status?.state === 'stopped'
                  ? 'Último escaneo interrumpido · Listo para reintentar'
                  : 'Se activa durante el escaneo diario (18:00) o forzado'}
          </span>
        </div>

        <div className="metric-cell">
          <span className="metric-label">Antenas nuevas</span>
          <span className="metric-value">
            {dataset.antenasNuevas.toLocaleString('es-ES')}
          </span>
          <span className="metric-sub">
            Nuevos emplazamientos incorporados al censo
          </span>
        </div>

        <div className="metric-cell">
          <span className="metric-label">Frecuencias nuevas</span>
          <span className="metric-value">
            {dataset.frecuenciasNuevas.toLocaleString('es-ES')}
          </span>
          <span className="metric-sub">
            Nuevas concesiones de banda asignadas en MINETUR
          </span>
        </div>

        <div className="metric-cell">
          <span className="metric-label">Último escaneo</span>
          <span className="metric-value novedades-metric-datetime">
            {lastScanFormatted}
          </span>
          <span className="metric-sub">
            {dataset.isBaselineScan
              ? 'Línea base inicial · Próximo ciclo diario 18:00 h'
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

            <div
              className="novedades-type-pills"
              role="group"
              aria-label="Filtrar por tipo de novedad"
            >
              <button
                type="button"
                id="novedades-filter-all"
                className={`novedades-filter-pill${
                  tipoFilter === 'all' ? ' is-active' : ''
                }`}
                onClick={() => setTipoFilter('all')}
                aria-pressed={tipoFilter === 'all'}
              >
                <span>Todas</span>
                <span className="novedades-pill-count mono">
                  {summaryCounts.all.toLocaleString('es-ES')}
                </span>
              </button>

              <button
                type="button"
                id="novedades-filter-antenas"
                className={`novedades-filter-pill${
                  tipoFilter === 'antena' ? ' is-active' : ''
                }`}
                onClick={() => setTipoFilter('antena')}
                aria-pressed={tipoFilter === 'antena'}
              >
                <RadioTower size={13} aria-hidden="true" />
                <span>Antenas nuevas</span>
                <span className="novedades-pill-count mono">
                  {summaryCounts.antena.toLocaleString('es-ES')}
                </span>
              </button>

              <button
                type="button"
                id="novedades-filter-frecuencias"
                className={`novedades-filter-pill${
                  tipoFilter === 'frecuencia' ? ' is-active' : ''
                }`}
                onClick={() => setTipoFilter('frecuencia')}
                aria-pressed={tipoFilter === 'frecuencia'}
              >
                <Radio size={13} aria-hidden="true" />
                <span>Frecuencias nuevas</span>
                <span className="novedades-pill-count mono">
                  {summaryCounts.frecuencia.toLocaleString('es-ES')}
                </span>
              </button>
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
              onClick={() => setOperatorFilter('all')}
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
                    setOperatorFilter(isActive ? 'all' : opKey)
                  }
                  aria-pressed={isActive}
                >
                  <span
                    className="operator-dot"
                    style={{ backgroundColor: meta.color }}
                    aria-hidden="true"
                  />
                  <span>{getNovedadesOperatorLabel(opKey)}</span>
                  {summaryCounts.byOp[opKey] > 0 && (
                    <span className="novedades-pill-count mono">
                      {summaryCounts.byOp[opKey].toLocaleString('es-ES')}
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
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Código antena, código banda, MHz o ciudad…"
                />
                {searchQuery && (
                  <button
                    type="button"
                    className="search-clear-btn"
                    onClick={() => setSearchQuery('')}
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
                  onChange={(e) => setBandFilter(e.target.value)}
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
                  onChange={(e) => setDateFilter(e.target.value)}
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
                  onChange={(e) => setProvinceFilter(e.target.value)}
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
                <th scope="col">Novedad</th>
                <th scope="col" className="novedades-col-codigo">
                  Código
                </th>
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
                      <td>
                        <div className="novedades-cell-novedad">
                          <span
                            className={`novedades-badge ${
                              isFrecuencia ? 'is-frecuencia' : 'is-antena'
                            }`}
                          >
                            {isFrecuencia ? (
                              <Radio size={11} aria-hidden="true" />
                            ) : (
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

                      <td className="novedades-col-codigo">
                        <Link
                          to="/"
                          search={{
                            gid: row.codigo,
                            id: row.antennaId || undefined,
                          }}
                          className="novedades-code-link mono"
                          title="Ver esta antena en el mapa interactivo"
                        >
                          {row.codigo}
                        </Link>
                      </td>

                      <td>
                        {isFrecuencia ? (
                          <span className="mono novedades-band-code">
                            {row.codigoBanda || 'Sin código'}
                          </span>
                        ) : (
                          <span
                            className="novedades-empty-cell"
                            aria-label="No aplica para antena nueva"
                          >
                            —
                          </span>
                        )}
                      </td>

                      <td>
                        {isFrecuencia && freqLines ? (
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
                            aria-label="No aplica para antena nueva"
                          >
                            —
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
                              <strong>18:00 h</strong> o forzado.
                            </>
                          ) : (
                            <>
                              Aún no se han registrado altas de nuevas antenas ni
                              nuevas concesiones de frecuencia hasta el último
                              escaneo del{' '}
                              <span className="mono">{lastScanFormatted}</span>.
                              Las novedades que se detecten quedarán guardadas de
                              forma permanente tras cada escaneo automático de las{' '}
                              <strong>18:00 h</strong>.
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
                  setPageState({
                    key: filterKey,
                    page: currentPage,
                    draftInput: digitsOnly,
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
                  setPageState((prev) => ({
                    ...prev,
                    draftInput: null,
                  }));
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
