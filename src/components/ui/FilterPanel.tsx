import { useMemo } from 'react';
import {
  MapPin,
  PanelLeftClose,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import type { DerivedAntenasStructures } from '../../hooks/useAntenasData';
import {
  OPERATOR_META,
  OPERATOR_ORDER,
  type AntennaRecord,
  type OperatorKey,
} from '../../types/antena';
import type { RadarPoint } from '../../types/map';
import { parseCoordinateInput } from '../../utils/export';
import { SPAIN_REGION_PRESETS } from '../../utils/geo';
import { ExportMenu } from './ExportMenu';
import { NearestAntennasCard } from './NearestAntennasCard';

export interface FilterPanelProps {
  derived: DerivedAntenasStructures | null;
  filteredAntenas: AntennaRecord[];
  collapsed: boolean;
  mobileOpen: boolean;
  onCollapseDesktop: () => void;
  onCloseMobile: () => void;

  searchQuery: string;
  onSearchChange: (q: string) => void;
  selectedProvince: string;
  onProvinceChange: (prov: string) => void;
  selectedMunicipality: string;
  onMunicipalityChange: (mun: string) => void;
  activeOperators: OperatorKey[];
  onToggleOperator: (op: OperatorKey) => void;
  onSelectAllOperators: () => void;
  onClearAllOperators: () => void;
  hasActiveFilters: boolean;
  onResetFilters: () => void;

  selectedAntenna: AntennaRecord | null;
  onSelectAntenna: (ant: AntennaRecord) => void;
  onFlyTo: (lat: number, lon: number, zoom?: number) => void;
  onJumpToCoordinates: (lat: number, lon: number) => void;

  radarPoint: RadarPoint | null;
  onClearRadar: () => void;
  radarRadiusKm: number;
  onRadiusChange: (km: number) => void;
  radarModeActive: boolean;
  onToggleRadarMode: () => void;
  gpsLoading: boolean;
  gpsError: string | null;
  onRequestGps: () => void;
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
  selectedProvince,
  onProvinceChange,
  selectedMunicipality,
  onMunicipalityChange,
  activeOperators,
  onToggleOperator,
  onSelectAllOperators,
  onClearAllOperators,
  hasActiveFilters,
  onResetFilters,
  selectedAntenna,
  onSelectAntenna,
  onFlyTo,
  onJumpToCoordinates,
  radarPoint,
  onClearRadar,
  radarRadiusKm,
  onRadiusChange,
  radarModeActive,
  onToggleRadarMode,
  gpsLoading,
  gpsError,
  onRequestGps,
}: FilterPanelProps) {
  const parsedCoords = useMemo(
    () => parseCoordinateInput(searchQuery),
    [searchQuery],
  );

  const municipalities = useMemo(() => {
    if (!derived || !selectedProvince) return [];
    return derived.municipalitiesByProvince.get(selectedProvince) ?? [];
  }, [derived, selectedProvince]);

  const totalStations = derived?.dataset.total ?? 0;

  function handleProvinceSelect(prov: string) {
    onProvinceChange(prov);
    if (prov && derived) {
      const centroid = derived.provinceCentroids.get(prov);
      if (centroid) {
        onFlyTo(centroid.lat, centroid.lon, 8.3);
      }
    }
  }

  function handleMunicipalitySelect(mun: string) {
    onMunicipalityChange(mun);
    if (mun && derived) {
      const match = derived.dataset.antenas.find(
        (a) =>
          (!selectedProvince || a.prov === selectedProvince) && a.mun === mun,
      );
      if (match) {
        onFlyTo(match.lat, match.lon, 13.2);
      }
    }
  }

  return (
    <aside
      className={`filter-sidebar ${collapsed ? 'is-collapsed' : ''} ${
        mobileOpen ? 'is-mobile-open' : ''
      }`}
      aria-label="Panel de filtros y orientación RF"
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
            radarPoint={radarPoint}
            align="right"
            idPrefix="map-sidebar-export"
          />

          <button
            type="button"
            className="icon-btn"
            onClick={() => {
              onCollapseDesktop();
              onCloseMobile();
            }}
            id="sidebar-collapse-btn"
            title="Ocultar panel lateral"
            aria-label="Ocultar panel lateral"
            style={{ padding: '0 8px' }}
          >
            <PanelLeftClose size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="sidebar-scroll">
        {/* Búsqueda instantánea + Coordenadas WGS84 + Regiones */}
        <section className="panel-section">
          <div className="field-label">
            <label htmlFor="map-search-input">
              Búsqueda o Coordenadas WGS84
            </label>
            {hasActiveFilters && (
              <button
                type="button"
                className="text-link-btn"
                onClick={onResetFilters}
                id="map-reset-filters-btn"
              >
                <RotateCcw
                  size={11}
                  style={{ verticalAlign: '-1px', marginRight: 3 }}
                  aria-hidden="true"
                />
                Restablecer
              </button>
            )}
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
                  onJumpToCoordinates(parsedCoords.lat, parsedCoords.lon);
                  onCloseMobile();
                }
              }}
              placeholder="Municipio, calle, Gis_ID o 40.4168, -3.7038"
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
                  onJumpToCoordinates(parsedCoords.lat, parsedCoords.lon);
                  onCloseMobile();
                }}
              >
                <MapPin size={13} aria-hidden="true" />
                <span>Ir y fijar radar</span>
              </button>
            </div>
          )}

          <div className="region-presets-row" aria-label="Accesos rápidos territoriales">
            {SPAIN_REGION_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="preset-chip"
                onClick={() => {
                  onFlyTo(preset.lat, preset.lon, preset.zoom);
                  onCloseMobile();
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </section>

        {/* Provincia y Municipio en cascada */}
        <section className="panel-section">
          <div className="field-label">
            <span>Ámbito Territorial</span>
          </div>
          <div className="form-grid-2">
            <div>
              <select
                id="map-province-select"
                aria-label="Filtrar por provincia"
                className="select-control"
                value={selectedProvince}
                onChange={(e) => handleProvinceSelect(e.target.value)}
              >
                <option value="">
                  Todas ({derived?.provincesByAlpha.length ?? 52} prov.)
                </option>
                {derived?.provincesByAlpha.map((p) => (
                  <option key={p.provincia} value={p.provincia}>
                    {p.provincia} ({p.count.toLocaleString('es-ES')})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <select
                id="map-municipality-select"
                aria-label="Filtrar por municipio"
                className="select-control"
                value={selectedMunicipality}
                disabled={!selectedProvince}
                onChange={(e) => handleMunicipalitySelect(e.target.value)}
              >
                <option value="">
                  {selectedProvince
                    ? `Todos (${municipalities.length} mun.)`
                    : 'Elige provincia'}
                </option>
                {municipalities.map((m) => (
                  <option key={m.mun} value={m.mun}>
                    {m.mun} ({m.count})
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

        {/* Radar de Cercanía y Orientación 4G/5G */}
        <section className="panel-section">
          <NearestAntennasCard
            antenas={filteredAntenas}
            selectedAntenna={selectedAntenna}
            onSelectAntenna={(ant) => {
              onSelectAntenna(ant);
              onCloseMobile();
            }}
            onFlyToAntenna={(ant) => onFlyTo(ant.lat, ant.lon, 15.8)}
            radarPoint={radarPoint}
            onClearRadar={onClearRadar}
            radarRadiusKm={radarRadiusKm}
            onRadiusChange={onRadiusChange}
            radarModeActive={radarModeActive}
            onToggleRadarMode={() => {
              onToggleRadarMode();
              onCloseMobile();
            }}
            gpsLoading={gpsLoading}
            gpsError={gpsError}
            onRequestGps={() => {
              onRequestGps();
              onCloseMobile();
            }}
          />
        </section>
      </div>
    </aside>
  );
}
