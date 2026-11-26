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
  findAntennasByCode,
  normalizeAntennaCodeInput,
  type AntennaCodeMatch,
  type DerivedAntenasStructures,
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

export interface FilterPanelProps {
  derived: DerivedAntenasStructures | null;
  filteredAntenas: AntennaRecord[];
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
  highlightUnicoDeclared = true,
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
        <RotateCcw size={13} aria-hidden="true" />
        <span>Reset</span>
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
                {derived?.comunidadesByAlpha.map((c) => (
                  <option key={c.comunidad} value={c.comunidad}>
                    {c.comunidad} ({c.count.toLocaleString('es-ES')})
                  </option>
                ))}
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
                {availableProvinces.map((p) => (
                  <option key={p.provincia} value={p.provincia}>
                    {p.provincia} ({p.count.toLocaleString('es-ES')})
                  </option>
                ))}
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
              const count = derived?.operatorCounts[opKey] ?? 0;
              return (
                <button
                  key={opKey}
                  type="button"
                  id={`filter-op-${opKey}`}
                  className={`operator-pill ${
                    isActive ? 'is-active' : 'is-inactive'
                  }`}
                  onClick={() => onToggleOperator(opKey)}
                  aria-pressed={isActive}
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
        {derived && derived.availableBands.length > 0 && (
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
              {derived.availableBands.map((item) => {
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

              <div className="bands-actions-buttons">{panelActionButtons}</div>
            </div>
          </section>
        )}

        {(!derived || derived.availableBands.length === 0) && (
          <section className="panel-section">
            <div className="bands-actions-buttons bands-actions-fallback">
              {panelActionButtons}
            </div>
          </section>
        )}

        {/* Declaración UNICO 5G */}
        {onOnlyUnicoDeclaredChange && (
          <section className="panel-section">
            <div className="field-label">
              <span className="unico-filter-legend-title">
                <span
                  className={`unico-filter-legend-swatch${highlightUnicoDeclared ? '' : ' is-muted'}`}
                  aria-hidden="true"
                />
                <span>UNICO 5G</span>
              </span>
              <span className="unico-filter-count-badge mono">
                {unicoStatus === 'loading'
                  ? 'Cargando…'
                  : unicoStatus === 'error'
                    ? 'No disponible'
                    : unicoDeclaredCount === 1
                      ? '1 declarada'
                      : `${formatUnicoInt(unicoDeclaredCount)} declaradas`}
              </span>
            </div>

            <label
              htmlFor="filter-unico-declared-checkbox"
              className={`bands-exclusive-row unico-filter-row${onlyUnicoDeclared ? ' is-active' : ''}${unicoStatus !== 'ready' ? ' is-disabled' : ''}`}
            >
              <input
                id="filter-unico-declared-checkbox"
                type="checkbox"
                className="bands-exclusive-checkbox unico-filter-checkbox"
                checked={onlyUnicoDeclared}
                disabled={unicoStatus !== 'ready'}
                onChange={(e) => onOnlyUnicoDeclaredChange(e.target.checked)}
              />
              <span className="bands-exclusive-copy">
                <span className="bands-exclusive-title">
                  Solo declaradas UNICO 5G
                </span>
                <span className="bands-exclusive-hint">
                  {unicoStatus === 'loading'
                    ? 'Sincronizando declaraciones UNICO 5G…'
                    : unicoStatus === 'error'
                      ? 'No se pudo cargar el catálogo UNICO 5G'
                      : onlyUnicoDeclared
                        ? 'Mostrando únicamente antenas seleccionadas como declaración UNICO 5G'
                        : highlightUnicoDeclared
                          ? 'Resaltadas con aro verde en el mapa (≤ 1.200 m con N28/N28+/N78)'
                          : 'Resaltado verde desactivado en opciones del mapa (≤ 1.200 m con N28/N28+/N78)'}
                </span>
              </span>
            </label>
          </section>
        )}
      </div>
    </aside>
  );
}
