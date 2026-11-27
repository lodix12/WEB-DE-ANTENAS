import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  Crosshair,
  LocateFixed,
  MapPin,
  RadioTower,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import {
  bandCodeToDomId,
  computeMapFilterFacetCounts,
  findAntennasByCode,
  normalizeAntennaCodeInput,
  type AntennaCodeMatch,
  type DerivedAntenasStructures,
  type MapFilterFacetCounts,
} from '../../hooks/useAntenasData';
import { formatUnicoInt } from '../../hooks/useUnico5gData';
import {
  OPERATOR_META,
  OPERATOR_ORDER,
  type AntennaRecord,
  type OperatorKey,
} from '../../types/antena';
import {
  CODE_HIGHLIGHT_DURATION_MS,
  type HighlightedAntennaTarget,
} from '../../types/map';
import { parseCoordinateInput } from '../../utils/export';

const EU_FLAG_STARS_PATH =
  'M12.00,1.65L12.26,2.44L13.09,2.44L12.43,2.94L12.68,3.73L12.00,3.25L11.32,3.73L11.57,2.94L10.91,2.44L11.74,2.44Z ' +
  'M14.60,2.35L14.86,3.13L15.69,3.14L15.03,3.64L15.28,4.43L14.60,3.95L13.92,4.43L14.17,3.64L13.51,3.14L14.34,3.13Z ' +
  'M16.50,4.25L16.77,5.04L17.60,5.04L16.93,5.54L17.18,6.33L16.50,5.85L15.83,6.33L16.08,5.54L15.41,5.04L16.24,5.04Z ' +
  'M17.20,6.85L17.46,7.64L18.29,7.64L17.63,8.14L17.88,8.93L17.20,8.45L16.52,8.93L16.77,8.14L16.11,7.64L16.94,7.64Z ' +
  'M16.50,9.45L16.77,10.24L17.60,10.24L16.93,10.74L17.18,11.53L16.50,11.05L15.83,11.53L16.08,10.74L15.41,10.24L16.24,10.24Z ' +
  'M14.60,11.35L14.86,12.14L15.69,12.15L15.03,12.64L15.28,13.43L14.60,12.95L13.92,13.43L14.17,12.64L13.51,12.15L14.34,12.14Z ' +
  'M12.00,12.05L12.26,12.84L13.09,12.84L12.43,13.34L12.68,14.13L12.00,13.65L11.32,14.13L11.57,13.34L10.91,12.84L11.74,12.84Z ' +
  'M9.40,11.35L9.66,12.14L10.49,12.15L9.83,12.64L10.08,13.43L9.40,12.95L8.72,13.43L8.97,12.64L8.31,12.15L9.14,12.14Z ' +
  'M7.50,9.45L7.76,10.24L8.59,10.24L7.92,10.74L8.17,11.53L7.50,11.05L6.82,11.53L7.07,10.74L6.40,10.24L7.23,10.24Z ' +
  'M6.80,6.85L7.06,7.64L7.89,7.64L7.23,8.14L7.48,8.93L6.80,8.45L6.12,8.93L6.37,8.14L5.71,7.64L6.54,7.64Z ' +
  'M7.50,4.25L7.76,5.04L8.59,5.04L7.92,5.54L8.17,6.33L7.50,5.85L6.82,6.33L7.07,5.54L6.40,5.04L7.23,5.04Z ' +
  'M9.40,2.35L9.66,3.13L10.49,3.14L9.83,3.64L10.08,4.43L9.40,3.95L8.72,4.43L8.97,3.64L8.31,3.14L9.14,3.13Z';

export interface FilterPanelProps {
  derived: DerivedAntenasStructures | null;
  filteredAntenas: AntennaRecord[];
  facetCounts?: MapFilterFacetCounts;
  collapsed: boolean;
  mobileOpen: boolean;
  onCollapseDesktop: () => void;
  onCloseMobile: () => void;

  searchQuery: string;
  onSearchChange: (q: string) => void;
  selectedComunidad: string;
  onComunidadChange: (ccaa: string) => void;
  selectedProvince: string;
  onProvinceChange: (prov: string) => void;
  selectedBands: string[];
  onToggleBand: (band: string) => void;
  onClearBands: () => void;
  exclusiveBands: boolean;
  onExclusiveBandsChange: (exclusive: boolean) => void;
  onlyUnicoDeclared?: boolean;
  onOnlyUnicoDeclaredChange?: (only: boolean) => void;
  unicoDeclaredCount?: number;
  unicoStatus?: 'ready' | 'loading' | 'error';
  highlightUnicoDeclared?: boolean;
  activeOperators: OperatorKey[];
  onToggleOperator: (op: OperatorKey) => void;
  onSelectAllOperators: () => void;
  onClearAllOperators: () => void;
  hasActiveFilters: boolean;
  onResetFilters: () => void;

  onFlyTo: (lat: number, lon: number, zoom?: number) => void;
  onLocateAntennaByCode?: (antenna: AntennaRecord, matchedCode: string) => void;
  highlightedAntenna?: HighlightedAntennaTarget | null;
  onClearHighlightedAntenna?: () => void;
}

export function FilterPanel({
  derived,
  filteredAntenas,
  facetCounts,
  collapsed,
  mobileOpen,
  onCollapseDesktop,
  onCloseMobile,
  searchQuery,
  onSearchChange,
  selectedComunidad,
  onComunidadChange,
  selectedProvince,
  onProvinceChange,
  selectedBands,
  onToggleBand,
  onClearBands,
  exclusiveBands,
  onExclusiveBandsChange,
  onlyUnicoDeclared = false,
  onOnlyUnicoDeclaredChange,
  unicoDeclaredCount = 0,
  unicoStatus = 'ready',
  activeOperators,
  onToggleOperator,
  onSelectAllOperators,
  onClearAllOperators,
  hasActiveFilters,
  onResetFilters,
  onFlyTo,
  onLocateAntennaByCode,
  highlightedAntenna = null,
  onClearHighlightedAntenna,
}: FilterPanelProps) {
  const [codeQuery, setCodeQuery] = useState('');
  const [codeDropdownOpen, setCodeDropdownOpen] = useState(false);
  const [activeCodeMatchIdx, setActiveCodeMatchIdx] = useState(0);
  const [notFoundCode, setNotFoundCode] = useState<string | null>(null);
  const [highlightRemainingSec, setHighlightRemainingSec] = useState<
    number | null
  >(null);
  const codeSearchSectionRef = useRef<HTMLElement | null>(null);

  const parsedCoords = useMemo(
    () => parseCoordinateInput(searchQuery),
    [searchQuery],
  );

  const normalizedCodeQuery = useMemo(
    () => normalizeAntennaCodeInput(codeQuery),
    [codeQuery],
  );

  const preferredVisibleIds = useMemo<ReadonlySet<string> | undefined>(() => {
    if (!derived || !normalizedCodeQuery) {
      return undefined;
    }
    if (filteredAntenas.length >= derived.dataset.antenas.length) {
      return undefined;
    }
    const ids = new Set<string>();
    for (let i = 0; i < filteredAntenas.length; i++) {
      ids.add(filteredAntenas[i].id);
    }
    return ids;
  }, [derived, normalizedCodeQuery, filteredAntenas]);

  const codeMatches = useMemo(
    () =>
      findAntennasByCode(derived, codeQuery, {
        limit: 6,
        preferredIds: preferredVisibleIds,
      }),
    [derived, codeQuery, preferredVisibleIds],
  );

  const safeActiveCodeIdx =
    codeMatches.length > 0
      ? Math.min(activeCodeMatchIdx, codeMatches.length - 1)
      : 0;
  const activeCodeMatch = codeMatches[safeActiveCodeIdx];
  const showCodeResults =
    codeDropdownOpen &&
    normalizedCodeQuery.length > 0 &&
    codeMatches.length > 0;
  const showNotFoundNotice =
    !showCodeResults &&
    (notFoundCode !== null ||
      (codeDropdownOpen &&
        derived !== null &&
        normalizedCodeQuery.length >= 3 &&
        codeMatches.length === 0));
  const notFoundDisplayCode =
    notFoundCode ?? (normalizedCodeQuery || codeQuery.trim());

  useEffect(() => {
    if (!codeDropdownOpen) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (
        codeSearchSectionRef.current &&
        event.target instanceof Node &&
        !codeSearchSectionRef.current.contains(event.target)
      ) {
        setCodeDropdownOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [codeDropdownOpen]);

  useEffect(() => {
    if (!highlightedAntenna) {
      return;
    }
    const updateRemaining = () => {
      const remainingMs = highlightedAntenna.expiresAt - Date.now();
      setHighlightRemainingSec(
        remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0,
      );
    };
    updateRemaining();
    const timer = window.setInterval(updateRemaining, 250);
    return () => {
      window.clearInterval(timer);
    };
  }, [highlightedAntenna]);

  const displayedRemainingSec = highlightedAntenna
    ? highlightRemainingSec !== null &&
      highlightRemainingSec > 0 &&
      highlightRemainingSec <= Math.ceil(CODE_HIGHLIGHT_DURATION_MS / 1000)
      ? highlightRemainingSec
      : Math.max(
          1,
          Math.ceil(
            Math.max(
              0,
              highlightedAntenna.expiresAt - highlightedAntenna.startedAt,
            ) / 1000,
          ),
        )
    : 0;

  function locateCodeMatch(match: AntennaCodeMatch) {
    setCodeQuery(match.matchedCode);
    setCodeDropdownOpen(false);
    setNotFoundCode(null);
    setActiveCodeMatchIdx(0);
    if (onLocateAntennaByCode) {
      onLocateAntennaByCode(match.antenna, match.matchedCode);
    } else {
      onFlyTo(match.antenna.lat, match.antenna.lon, 16);
    }
    onCloseMobile();
  }

  function handleSubmitCodeSearch() {
    const trimmed = codeQuery.trim();
    if (!trimmed) {
      return;
    }
    if (codeMatches.length > 0) {
      locateCodeMatch(codeMatches[safeActiveCodeIdx] ?? codeMatches[0]);
      return;
    }
    setCodeDropdownOpen(false);
    setNotFoundCode(normalizedCodeQuery || trimmed);
  }

  function handleClearCodeSearch() {
    setCodeQuery('');
    setCodeDropdownOpen(false);
    setNotFoundCode(null);
    setActiveCodeMatchIdx(0);
  }

  function handleCodeInputKeyDown(
    event: ReactKeyboardEvent<HTMLInputElement>,
  ) {
    if (event.key === 'ArrowDown') {
      if (codeMatches.length > 0) {
        event.preventDefault();
        setCodeDropdownOpen(true);
        setActiveCodeMatchIdx((prev) =>
          codeDropdownOpen ? (prev + 1) % codeMatches.length : 0,
        );
      }
      return;
    }
    if (event.key === 'ArrowUp') {
      if (codeMatches.length > 0) {
        event.preventDefault();
        setCodeDropdownOpen(true);
        setActiveCodeMatchIdx((prev) =>
          codeDropdownOpen
            ? (prev - 1 + codeMatches.length) % codeMatches.length
            : codeMatches.length - 1,
        );
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      handleSubmitCodeSearch();
      return;
    }
    if (event.key === 'Escape' && codeDropdownOpen) {
      event.preventDefault();
      event.stopPropagation();
      setCodeDropdownOpen(false);
    }
  }

  const availableProvinces = useMemo(() => {
    if (!derived) return [];
    if (selectedComunidad) {
      return derived.provincesByComunidad.get(selectedComunidad) ?? [];
    }
    return derived.provincesByAlpha;
  }, [derived, selectedComunidad]);

  const fallbackFacetCounts = useMemo(
    () =>
      facetCounts
        ? null
        : computeMapFilterFacetCounts({
            derived,
            searchQuery,
            selectedComunidad,
            selectedProvince,
            activeOperators,
            selectedBands,
            exclusiveBands,
          }),
    [
      facetCounts,
      derived,
      searchQuery,
      selectedComunidad,
      selectedProvince,
      activeOperators,
      selectedBands,
      exclusiveBands,
    ],
  );
  const resolvedFacetCounts = facetCounts ?? fallbackFacetCounts;
  const displayedBands = resolvedFacetCounts
    ? resolvedFacetCounts.availableBands
    : (derived?.availableBands ?? []);
  const allOperatorsActive =
    activeOperators.length === OPERATOR_ORDER.length &&
    OPERATOR_ORDER.every((key) => activeOperators.includes(key));

  const totalStations = derived?.dataset.total ?? 0;
  const visibleCount = filteredAntenas.length;
  const isLoaded = derived !== null;
  const isSubset = isLoaded && totalStations > 0 && visibleCount < totalStations;
  const isEmptyResult = isLoaded && totalStations > 0 && visibleCount === 0;
  const isFilteredHighlight =
    !isEmptyResult &&
    (isSubset || (hasActiveFilters && isLoaded && totalStations > 0));

  const visibleFormatted = visibleCount.toLocaleString('es-ES');
  const totalFormatted = totalStations.toLocaleString('es-ES');
  const unitLabel = visibleCount === 1 ? 'antena' : 'antenas';

  let shareLabel = '—';
  let meterWidthPercent = 0;
  if (isLoaded && totalStations > 0) {
    if (visibleCount <= 0) {
      shareLabel = '0%';
      meterWidthPercent = 0;
    } else if (visibleCount >= totalStations) {
      shareLabel = '100%';
      meterWidthPercent = 100;
    } else {
      const pct = (visibleCount / totalStations) * 100;
      meterWidthPercent = Math.max(2, Math.min(100, pct));
      if (pct < 0.1) {
        shareLabel = '< 0,1%';
      } else if (pct >= 99.95) {
        shareLabel = '> 99,9%';
      } else if (pct < 10) {
        shareLabel = `${pct.toLocaleString('es-ES', {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        })}%`;
      } else {
        shareLabel = `${pct.toLocaleString('es-ES', {
          minimumFractionDigits: 0,
          maximumFractionDigits: 1,
        })}%`;
      }
    }
  }

  function handleClosePanel() {
    if (
      typeof window !== 'undefined' &&
      window.matchMedia?.('(max-width: 860px)').matches
    ) {
      onCloseMobile();
    } else {
      onCollapseDesktop();
      onCloseMobile();
    }
  }

  function handleResetAll() {
    handleClearCodeSearch();
    onClearHighlightedAntenna?.();
    onResetFilters();
  }

  function handleComunidadSelect(ccaa: string) {
    onComunidadChange(ccaa);
    if (ccaa && derived) {
      const centroid = derived.comunidadCentroids.get(ccaa);
      if (centroid) {
        const zoom =
          ccaa === 'Canarias'
            ? 7.3
            : (derived.provincesByComunidad.get(ccaa)?.length ?? 1) > 1
              ? 7.2
              : 8.2;
        onFlyTo(centroid.lat, centroid.lon, zoom);
      }
    }
  }

  function handleProvinceSelect(prov: string) {
    onProvinceChange(prov);
    if (prov && derived) {
      const centroid = derived.provinceCentroids.get(prov);
      if (centroid) {
        onFlyTo(centroid.lat, centroid.lon, 8.3);
      }
    }
  }

  const unicoCountDisplay =
    unicoStatus === 'loading'
      ? '…'
      : unicoStatus === 'error'
        ? '—'
        : formatUnicoInt(unicoDeclaredCount);

  const unicoFilterTitle =
    unicoStatus === 'loading'
      ? 'Sincronizando declaraciones UNICO 5G…'
      : unicoStatus === 'error'
        ? 'No se pudo cargar el catálogo UNICO 5G'
        : onlyUnicoDeclared
          ? `Mostrando solo antenas declaradas UNICO 5G (${formatUnicoInt(unicoDeclaredCount)})`
          : `Filtrar solo antenas declaradas UNICO 5G (${formatUnicoInt(unicoDeclaredCount)} actuales)`;

  const unicoDeclaredControl = onOnlyUnicoDeclaredChange ? (
    <label
      htmlFor="filter-unico-declared-checkbox"
      className={`bands-exclusive-row bands-exclusive-compact unico-filter-row unico-filter-compact${onlyUnicoDeclared ? ' is-active' : ''}${unicoStatus !== 'ready' ? ' is-disabled' : ''}`}
      title={unicoFilterTitle}
    >
      <input
        id="filter-unico-declared-checkbox"
        type="checkbox"
        className="bands-exclusive-checkbox unico-filter-checkbox"
        checked={onlyUnicoDeclared}
        disabled={unicoStatus !== 'ready'}
        onChange={(e) => onOnlyUnicoDeclaredChange(e.target.checked)}
      />
      <span className="unico-filter-compact-copy">
        <span className="unico-filter-compact-head">
          <span className="bands-exclusive-title unico-filter-compact-title">
            UNICO 5G
          </span>
          <svg
            className="unico-filter-eu-flag"
            viewBox="0 0 24 16"
            width="15"
            height="10"
            role="img"
            aria-label="Unión Europea"
          >
            <rect width="24" height="16" rx="2" fill="#003399" />
            <path d={EU_FLAG_STARS_PATH} fill="#FFCC00" />
          </svg>
        </span>
        <span className="unico-filter-count-badge">
          {unicoStatus === 'ready' ? (
            <>
              <span className="unico-filter-count-number mono">
                {unicoCountDisplay}
              </span>{' '}
              Proyectos declarados.
            </>
          ) : (
            <span className="unico-filter-count-number mono">
              {unicoCountDisplay}
            </span>
          )}
        </span>
      </span>
    </label>
  ) : null;

  const panelActionButtons = (
    <>
      <button
        type="button"
        id="map-reset-filters-btn"
        className={`filter-reset-btn${hasActiveFilters ? ' has-active-filters' : ''}`}
        onClick={handleResetAll}
        title="Restablecer todos los filtros"
        aria-label="Restablecer filtros"
      >
        <RotateCcw size={15} strokeWidth={2.2} aria-hidden="true" />
      </button>

      <button
        type="button"
        id="sidebar-collapse-btn"
        className="filter-close-btn"
        onClick={handleClosePanel}
        title="Cerrar filtros"
        aria-label="Cerrar panel de filtros"
      >
        <X size={16} strokeWidth={2.25} aria-hidden="true" />
      </button>
    </>
  );

  return (
    <aside
      className={`filter-sidebar ${collapsed ? 'is-collapsed' : ''} ${
        mobileOpen ? 'is-mobile-open' : ''
      }`}
      aria-label="Panel de filtros cartográficos"
    >
      <div className="sidebar-header filter-sidebar-header">
        <div
          id="map-filter-antennas-summary"
          className={`filter-count-showcase${
            isEmptyResult
              ? ' is-empty'
              : isFilteredHighlight
                ? ' is-filtered'
                : ''
          }`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <div className="filter-count-top">
            <span className="filter-count-prefix">
              <RadioTower
                size={16}
                strokeWidth={2.15}
                className="filter-count-prefix-icon"
                aria-hidden="true"
              />
              <span>Mostrando</span>
            </span>
            <span
              className="filter-count-share mono"
              title={
                isLoaded && totalStations > 0
                  ? `${shareLabel} del censo total (${totalFormatted} antenas)`
                  : 'Cargando censo de antenas'
              }
            >
              {shareLabel}
            </span>
          </div>

          <div className="filter-count-figure">
            <strong className="filter-count-current mono">
              {visibleFormatted}
            </strong>
            <span className="filter-count-context">
              <span className="filter-count-unit">{unitLabel}</span>{' '}
              <span className="filter-count-of">de</span>{' '}
              <strong className="filter-count-total mono">
                {totalFormatted}
              </strong>
            </span>
          </div>

          <div className="filter-count-meter" aria-hidden="true">
            <div
              className="filter-count-meter-fill"
              style={{ width: `${meterWidthPercent}%` }}
            />
          </div>
        </div>
      </div>

      <div className="sidebar-scroll">
        {/* Búsqueda instantánea + Coordenadas WGS84 + Buscador específico por código */}
        <section className="panel-section" ref={codeSearchSectionRef}>
          <div className="field-label">
            <span>Búsqueda o Coordenadas WGS84</span>
          </div>

          <div className="search-inputs-row">
            <div className="search-input-field">
              <label htmlFor="map-search-input" className="sub-field-label">
                Buscador general
              </label>
              <div className="search-input-wrap">
                <span className="search-input-icon" aria-hidden="true">
                  <Search size={13} />
                </span>
                <input
                  id="map-search-input"
                  type="search"
                  className="search-input search-input-compact"
                  value={searchQuery}
                  onChange={(e) => onSearchChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && parsedCoords) {
                      e.preventDefault();
                      onFlyTo(parsedCoords.lat, parsedCoords.lon, 15);
                      onCloseMobile();
                    }
                  }}
                  placeholder="Municipio, calle…"
                  title="Filtrar por municipio, calle, banda o saltar a coordenadas WGS84"
                  autoComplete="off"
                />
                {searchQuery && (
                  <button
                    type="button"
                    className="search-clear-btn"
                    onClick={() => onSearchChange('')}
                    aria-label="Limpiar búsqueda"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            </div>

            <div className="search-input-field">
              <label
                htmlFor="map-code-search-input"
                className="sub-field-label"
              >
                Código antena
              </label>
              <div className="search-input-wrap search-code-input-wrap">
                <span
                  className="search-input-icon search-code-icon"
                  aria-hidden="true"
                >
                  <Crosshair size={13} />
                </span>
                <input
                  id="map-code-search-input"
                  type="text"
                  inputMode="search"
                  enterKeyHint="search"
                  className={`search-input search-input-compact search-code-input mono${
                    codeQuery ? ' has-value' : ''
                  }`}
                  value={codeQuery}
                  onChange={(e) => {
                    const nextVal = e.target.value;
                    setCodeQuery(nextVal);
                    setNotFoundCode(null);
                    setActiveCodeMatchIdx(0);
                    setCodeDropdownOpen(nextVal.trim().length > 0);
                  }}
                  onFocus={() => {
                    if (codeQuery.trim().length > 0) {
                      setCodeDropdownOpen(true);
                    }
                  }}
                  onKeyDown={handleCodeInputKeyDown}
                  placeholder="Ej. 3600449"
                  title="Ir a una antena por su código sin ocultar las demás (resaltado 10 s)"
                  autoComplete="off"
                  spellCheck={false}
                  role="combobox"
                  aria-label="Buscar antena por código"
                  aria-autocomplete="list"
                  aria-controls="map-code-search-results"
                  aria-expanded={showCodeResults}
                  aria-activedescendant={
                    showCodeResults && activeCodeMatch
                      ? `map-code-result-${safeActiveCodeIdx}`
                      : undefined
                  }
                />
                {codeQuery && (
                  <button
                    type="button"
                    id="map-code-search-clear-btn"
                    className="search-clear-btn search-code-clear-btn"
                    onClick={handleClearCodeSearch}
                    aria-label="Limpiar código de antena"
                    title="Limpiar código"
                  >
                    <X size={12} />
                  </button>
                )}
                <button
                  type="button"
                  id="map-code-search-submit-btn"
                  className={`search-code-go-btn${codeQuery.trim() ? ' is-ready' : ''}`}
                  onClick={handleSubmitCodeSearch}
                  disabled={!codeQuery.trim()}
                  aria-label="Localizar antena por código en el mapa"
                  title="Ir a la antena y resaltarla 10 s (Enter)"
                >
                  <LocateFixed size={13} aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>

          {showCodeResults && (
            <div
              id="map-code-search-results"
              className="code-search-results"
              role="listbox"
              aria-label="Coincidencias por código de antena"
            >
              {codeMatches.map((match, idx) => {
                const opMeta =
                  OPERATOR_META[match.antenna.op] ?? OPERATOR_META.otros;
                const isSelected = idx === safeActiveCodeIdx;
                const locationText = [match.antenna.mun, match.antenna.prov]
                  .filter(Boolean)
                  .join(', ');
                return (
                  <button
                    key={`${match.antenna.id}-${match.matchedCode}`}
                    id={`map-code-result-${idx}`}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`code-search-result-item${isSelected ? ' is-active' : ''}`}
                    onMouseEnter={() => setActiveCodeMatchIdx(idx)}
                    onClick={() => locateCodeMatch(match)}
                  >
                    <span
                      className="operator-dot"
                      style={{ backgroundColor: opMeta.color }}
                      aria-hidden="true"
                    />
                    <span className="code-search-result-body">
                      <span className="code-search-result-top">
                        <strong className="code-search-result-code mono">
                          #{match.matchedCode}
                        </strong>
                        {match.isMergedCode && (
                          <span className="code-search-result-tag">
                            → #{match.antenna.gid}
                          </span>
                        )}
                        {match.matchType === 'exact' && (
                          <span className="code-search-result-tag is-exact">
                            Exacto
                          </span>
                        )}
                      </span>
                      <span className="code-search-result-meta">
                        {opMeta.shortName}
                        {locationText ? ` · ${locationText}` : ''}
                      </span>
                    </span>
                    <LocateFixed
                      size={13}
                      className="code-search-result-go"
                      aria-hidden="true"
                    />
                  </button>
                );
              })}
            </div>
          )}

          {showNotFoundNotice && (
            <div
              id="map-code-search-empty"
              className="code-search-empty"
              role="status"
              aria-live="polite"
            >
              <span>
                No se encontró ninguna antena con el código{' '}
                <strong className="mono">{notFoundDisplayCode}</strong>.
              </span>
            </div>
          )}

          {highlightedAntenna && !showCodeResults && (
            <div
              id="map-code-highlight-banner"
              className="code-highlight-banner"
              role="status"
              aria-live="polite"
            >
              <button
                type="button"
                className="code-highlight-banner-main"
                onClick={() => {
                  if (onLocateAntennaByCode) {
                    onLocateAntennaByCode(
                      highlightedAntenna.antenna,
                      highlightedAntenna.matchedCode,
                    );
                  } else {
                    onFlyTo(
                      highlightedAntenna.antenna.lat,
                      highlightedAntenna.antenna.lon,
                      16,
                    );
                  }
                  onCloseMobile();
                }}
                title="Volver a centrar en el mapa y reiniciar resaltado de 10 s"
              >
                <span className="code-highlight-pulse-dot" aria-hidden="true" />
                <span className="code-highlight-banner-copy">
                  <span className="code-highlight-banner-title">
                    <strong className="mono">
                      #{highlightedAntenna.matchedCode}
                    </strong>{' '}
                    ·{' '}
                    {OPERATOR_META[highlightedAntenna.antenna.op]?.shortName ??
                      'Antena'}
                  </span>
                  {highlightedAntenna.antenna.mun && (
                    <span className="code-highlight-banner-loc">
                      {highlightedAntenna.antenna.mun}
                    </span>
                  )}
                </span>
              </button>
              <span
                className="code-highlight-countdown mono"
                title="Tiempo restante de resaltado en el mapa"
              >
                {displayedRemainingSec} s
              </span>
              {onClearHighlightedAntenna && (
                <button
                  type="button"
                  id="map-code-highlight-dismiss-btn"
                  className="code-highlight-dismiss-btn"
                  onClick={onClearHighlightedAntenna}
                  aria-label="Quitar resaltado"
                  title="Quitar resaltado"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          )}

          {parsedCoords && (
            <div className="coord-jump-banner">
              <div className="coord-jump-info">
                <span className="coord-jump-title">Coordenadas detectadas</span>
                <span className="coord-jump-coords">
                  {parsedCoords.lat.toFixed(5)}, {parsedCoords.lon.toFixed(5)}
                </span>
              </div>
              <button
                type="button"
                id="coord-jump-action-btn"
                className="btn btn-primary btn-sm"
                onClick={() => {
                  onFlyTo(parsedCoords.lat, parsedCoords.lon, 15);
                  onCloseMobile();
                }}
              >
                <MapPin size={13} aria-hidden="true" />
                <span>Ir a coordenadas</span>
              </button>
            </div>
          )}
        </section>

        {/* Comunidad Autónoma y Provincia */}
        <section className="panel-section">
          <div className="field-label">
            <span>Ámbito Territorial</span>
          </div>
          <div className="territorial-selects-stack">
            <div className="territorial-select-field">
              <label htmlFor="map-ccaa-select" className="sub-field-label">
                Comunidad autónoma
              </label>
              <select
                id="map-ccaa-select"
                aria-label="Filtrar por comunidad autónoma"
                className="select-control territorial-select-control"
                value={selectedComunidad}
                onChange={(e) => handleComunidadSelect(e.target.value)}
              >
                <option value="">
                  Todas las comunidades ({derived?.comunidadesByAlpha.length ?? 19})
                </option>
                {derived?.comunidadesByAlpha.map((c) => {
                  const count = resolvedFacetCounts
                    ? (resolvedFacetCounts.comunidadCounts.get(c.comunidad) ?? 0)
                    : c.count;
                  return (
                    <option key={c.comunidad} value={c.comunidad}>
                      {c.comunidad} ({count.toLocaleString('es-ES')})
                    </option>
                  );
                })}
              </select>
            </div>

            <div className="territorial-select-field">
              <label htmlFor="map-province-select" className="sub-field-label">
                Provincia
              </label>
              <select
                id="map-province-select"
                aria-label="Filtrar por provincia"
                className="select-control territorial-select-control"
                value={selectedProvince}
                onChange={(e) => handleProvinceSelect(e.target.value)}
              >
                <option value="">
                  {selectedComunidad
                    ? `Todas en ${selectedComunidad} (${availableProvinces.length})`
                    : `Todas las provincias (${availableProvinces.length || 52})`}
                </option>
                {availableProvinces.map((p) => {
                  const count = resolvedFacetCounts
                    ? (resolvedFacetCounts.provinceCounts.get(p.provincia) ?? 0)
                    : p.count;
                  return (
                    <option key={p.provincia} value={p.provincia}>
                      {p.provincia} ({count.toLocaleString('es-ES')})
                    </option>
                  );
                })}
              </select>
            </div>
          </div>
        </section>

        {/* Operadores */}
        <section className="panel-section">
          <div className="field-label">
            <span>Operadores de Red</span>
            <span style={{ display: 'inline-flex', gap: 4 }}>
              <button
                type="button"
                className="text-link-btn"
                onClick={onSelectAllOperators}
                id="ops-select-all-btn"
              >
                Todos
              </button>
              <span style={{ color: 'var(--border-default)' }}>/</span>
              <button
                type="button"
                className="text-link-btn"
                onClick={onClearAllOperators}
                id="ops-select-none-btn"
              >
                Ninguno
              </button>
            </span>
          </div>

          <div className="operator-pills-grid">
            {OPERATOR_ORDER.map((opKey) => {
              const meta = OPERATOR_META[opKey];
              const isActive = activeOperators.includes(opKey);
              const isSelected = isActive && !allOperatorsActive;
              const count = resolvedFacetCounts
                ? (resolvedFacetCounts.operatorCounts[opKey] ?? 0)
                : (derived?.operatorCounts[opKey] ?? 0);
              const pillTitle = allOperatorsActive
                ? `Seleccionar solo ${meta.shortName}`
                : isActive
                  ? activeOperators.length === 1
                    ? 'Mostrar todos los operadores'
                    : `Quitar ${meta.shortName}`
                  : `Añadir ${meta.shortName}`;
              return (
                <button
                  key={opKey}
                  type="button"
                  id={`filter-op-${opKey}`}
                  className={`operator-pill ${
                    isSelected
                      ? 'is-active is-selected'
                      : isActive
                        ? 'is-active'
                        : 'is-inactive'
                  }`}
                  onClick={() => onToggleOperator(opKey)}
                  aria-pressed={isActive}
                  title={pillTitle}
                >
                  <span className="operator-pill-left">
                    <span
                      className="operator-dot"
                      style={{ backgroundColor: meta.color }}
                      aria-hidden="true"
                    />
                    <span className="operator-pill-name">{meta.shortName}</span>
                  </span>
                  <span className="operator-pill-count">
                    {count.toLocaleString('es-ES')}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Filtro por Bandas de Frecuencia */}
        {derived && displayedBands.length > 0 && (
          <section className="panel-section">
            <div className="field-label">
              <span>
                Bandas
                {selectedBands.length > 0 ? ` · ${selectedBands.length}` : ''}
              </span>
              {selectedBands.length > 0 && (
                <button
                  type="button"
                  className="text-link-btn"
                  onClick={onClearBands}
                  id="bands-select-all-btn"
                >
                  Limpiar
                </button>
              )}
            </div>

            <div
              className="band-pills-grid"
              role="group"
              aria-label="Filtrar por bandas"
            >
              {displayedBands.map((item) => {
                const isSelected = selectedBands.includes(item.band);
                return (
                  <button
                    key={item.band}
                    type="button"
                    id={bandCodeToDomId(item.band)}
                    className={`band-filter-pill ${
                      isSelected ? 'is-active' : ''
                    }`}
                    onClick={() => onToggleBand(item.band)}
                    aria-pressed={isSelected}
                  >
                    <span className="band-filter-pill-label mono">
                      {item.band}
                    </span>
                    <span className="band-filter-pill-count mono">
                      {item.count.toLocaleString('es-ES')}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="bands-actions-row">
              <label
                htmlFor="filter-bands-exclusive-checkbox"
                className={`bands-exclusive-row bands-exclusive-compact${exclusiveBands ? ' is-active' : ''}`}
                title="Solo antenas con exactamente las bandas marcadas"
              >
                <input
                  id="filter-bands-exclusive-checkbox"
                  type="checkbox"
                  className="bands-exclusive-checkbox"
                  checked={exclusiveBands}
                  onChange={(e) => onExclusiveBandsChange(e.target.checked)}
                />
                <span className="bands-exclusive-title">Exclusivamente</span>
              </label>

              {unicoDeclaredControl}

              <div className="bands-actions-buttons">{panelActionButtons}</div>
            </div>
          </section>
        )}

        {(!derived || displayedBands.length === 0) && (
          <section className="panel-section">
            <div className="bands-actions-row bands-actions-fallback">
              {unicoDeclaredControl}
              <div className="bands-actions-buttons">{panelActionButtons}</div>
            </div>
          </section>
        )}
      </div>
    </aside>
  );
}
