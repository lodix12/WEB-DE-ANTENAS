import { useMemo } from 'react';
import {
  MapPin,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import {
  bandCodeToDomId,
  type DerivedAntenasStructures,
} from '../../hooks/useAntenasData';
import { formatUnicoInt } from '../../hooks/useUnico5gData';
import {
  OPERATOR_META,
  OPERATOR_ORDER,
  type AntennaRecord,
  type OperatorKey,
} from '../../types/antena';
import { parseCoordinateInput } from '../../utils/export';
import { ExportMenu } from './ExportMenu';

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
}: FilterPanelProps) {
  const parsedCoords = useMemo(
    () => parseCoordinateInput(searchQuery),
    [searchQuery],
  );

  const availableProvinces = useMemo(() => {
    if (!derived) return [];
    if (selectedComunidad) {
      return derived.provincesByComunidad.get(selectedComunidad) ?? [];
    }
    return derived.provincesByAlpha;
  }, [derived, selectedComunidad]);

  const totalStations = derived?.dataset.total ?? 0;

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
        onClick={onResetFilters}
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
      <div className="sidebar-header">
        <div className="sidebar-header-stats">
          <span className="sidebar-header-title">Control Cartográfico</span>
          <span className="sidebar-header-sub">
            Mostrando{' '}
            <strong className="mono" style={{ color: 'var(--text-primary)' }}>
              {filteredAntenas.length.toLocaleString('es-ES')}
            </strong>{' '}
            de{' '}
            <span className="mono">
              {totalStations.toLocaleString('es-ES')}
            </span>{' '}
            estaciones
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <ExportMenu
            antenas={filteredAntenas}
            radarPoint={null}
            align="right"
            idPrefix="map-sidebar-export"
          />
        </div>
      </div>

      <div className="sidebar-scroll">
        {/* Búsqueda instantánea + Coordenadas WGS84 */}
        <section className="panel-section">
          <div className="field-label">
            <label htmlFor="map-search-input">
              Búsqueda o Coordenadas WGS84
            </label>
          </div>

          <div className="search-input-wrap">
            <span className="search-input-icon" aria-hidden="true">
              <Search size={14} />
            </span>
            <input
              id="map-search-input"
              type="search"
              className="search-input"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && parsedCoords) {
                  e.preventDefault();
                  onFlyTo(parsedCoords.lat, parsedCoords.lon, 15);
                  onCloseMobile();
                }
              }}
              placeholder="Municipio, calle, Gis_ID, B3, N78 o 40.4168, -3.7038"
              autoComplete="off"
            />
            {searchQuery && (
              <button
                type="button"
                className="search-clear-btn"
                onClick={() => onSearchChange('')}
                aria-label="Limpiar búsqueda"
              >
                <X size={14} />
              </button>
            )}
          </div>

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
