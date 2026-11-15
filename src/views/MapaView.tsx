import { useEffect, useRef, useState } from 'react';
import { useSearch } from '@tanstack/react-router';
import {
  PanelLeftOpen,
  RefreshCw,
  Ruler,
  SlidersHorizontal,
} from 'lucide-react';
import { AntenasMap } from '../components/map/AntenasMap';
import { FilterPanel } from '../components/ui/FilterPanel';
import { StationDetailDrawer } from '../components/ui/StationDetailDrawer';
import {
  useAntenasData,
  useFilteredAntenas,
} from '../hooks/useAntenasData';
import { useWorkspace } from '../hooks/useWorkspace';

export function MapaView() {
  const { derived, isLoading, isError, error, refetch } = useAntenasData();
  const {
    styleId,
    setStyleId,
    searchQuery,
    setSearchQuery,
    selectedProvince,
    setSelectedProvince,
    selectedMunicipality,
    setSelectedMunicipality,
    selectedBand,
    setSelectedBand,
    activeOperators,
    toggleOperator,
    selectAllOperators,
    clearAllOperators,
    hasActiveFilters,
    resetAllFilters,
    selectedAntenna,
    setSelectedAntenna,
    flyToTarget,
    triggerFlyTo,
    measurePoints,
    setMeasurePoints,
    measureModeActive,
    toggleMeasureMode,
    focusAntennaOnMap,
  } = useWorkspace();

  const searchParams = useSearch({ from: '/' });
  const appliedGidRef = useRef<string | null>(null);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);

  useEffect(() => {
    document.title =
      'RadioMapa España · Mapa Interactivo de Antenas de Redes Móviles';
  }, []);

  // Soporte de enlace directo #/?gid=3600449
  useEffect(() => {
    const targetGid = searchParams.gid;
    if (!targetGid || !derived) return;
    if (appliedGidRef.current === targetGid) return;

    const found = derived.byGid.get(targetGid);
    if (found) {
      appliedGidRef.current = targetGid;
      focusAntennaOnMap(found);
    }
  }, [searchParams.gid, derived, focusAntennaOnMap]);

  const filteredAntenas = useFilteredAntenas({
    derived,
    searchQuery,
    selectedProvince,
    selectedMunicipality,
    activeOperators,
    selectedBand,
  });

  if (isError) {
    return (
      <main className="mapa-workspace">
        <div className="state-center-box">
          <h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
            Error al cargar la cartografía de estaciones
          </h1>
          <p style={{ maxWidth: 460 }}>
            {error instanceof Error
              ? error.message
              : 'No se pudo descargar data/antenas.json.'}
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

  return (
    <main className="mapa-workspace">
      {/* Encabezado accesible para lectores de pantalla */}
      <h1
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0, 0, 0, 0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        Mapa Interactivo de Estaciones Base y Antenas Móviles en España
      </h1>

      {mobilePanelOpen && (
        <div
          className="mobile-backdrop"
          onClick={() => setMobilePanelOpen(false)}
          aria-hidden="true"
        />
      )}

      <FilterPanel
        derived={derived}
        filteredAntenas={filteredAntenas}
        collapsed={sidebarCollapsed}
        mobileOpen={mobilePanelOpen}
        onCollapseDesktop={() => setSidebarCollapsed(true)}
        onCloseMobile={() => setMobilePanelOpen(false)}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        selectedProvince={selectedProvince}
        onProvinceChange={setSelectedProvince}
        selectedMunicipality={selectedMunicipality}
        onMunicipalityChange={setSelectedMunicipality}
        selectedBand={selectedBand}
        onBandChange={setSelectedBand}
        activeOperators={activeOperators}
        onToggleOperator={toggleOperator}
        onSelectAllOperators={selectAllOperators}
        onClearAllOperators={clearAllOperators}
        hasActiveFilters={hasActiveFilters}
        onResetFilters={resetAllFilters}
        onFlyTo={triggerFlyTo}
      />

      <div className="map-stage">
        {/* Botón para reabrir panel en escritorio cuando está plegado */}
        {sidebarCollapsed && (
          <button
            type="button"
            id="sidebar-reopen-btn"
            className="btn btn-secondary sidebar-reopen-btn"
            onClick={() => setSidebarCollapsed(false)}
          >
            <PanelLeftOpen size={15} aria-hidden="true" />
            <span>
              Filtros (
              <span className="mono">
                {filteredAntenas.length.toLocaleString('es-ES')}
              </span>
              )
            </span>
          </button>
        )}

        {/* Barra flotante superior en móvil */}
        <div className="mobile-controls-bar">
          <button
            type="button"
            id="mobile-open-filters-btn"
            className="btn btn-secondary btn-sm"
            onClick={() => setMobilePanelOpen(true)}
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
            <span>
              Filtros ·{' '}
              <span className="mono">
                {filteredAntenas.length.toLocaleString('es-ES')}
              </span>
            </span>
          </button>

          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              id="mobile-radar-mode-btn"
              className={`btn btn-sm ${
                measureModeActive ? 'btn-active' : 'btn-secondary'
              }`}
              onClick={toggleMeasureMode}
              title="Seleccionar 2 puntos en el mapa para medir distancia"
            >
              <Ruler size={13} aria-hidden="true" />
              <span>Medir</span>
            </button>
          </div>
        </div>

        {isLoading && !derived ? (
          <div className="state-center-box" style={{ height: '100%' }}>
            <div className="spinner-ring" aria-hidden="true" />
            <p style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
              Cargando censo nacional de antenas móviles…
            </p>
          </div>
        ) : (
          <AntenasMap
            antenas={filteredAntenas}
            selectedAntenna={selectedAntenna}
            onSelectAntenna={setSelectedAntenna}
            styleId={styleId}
            onStyleChange={setStyleId}
            flyToTarget={flyToTarget}
            measurePoints={measurePoints}
            onMeasurePointsChange={(pts) => {
              setMeasurePoints(pts);
            }}
            measureModeActive={measureModeActive}
            onToggleMeasureMode={toggleMeasureMode}
            activeOperators={activeOperators}
            onToggleOperator={toggleOperator}
          />
        )}
      </div>

      <StationDetailDrawer
        antenna={selectedAntenna}
        allAntenas={derived?.dataset.antenas ?? []}
        onClose={() => setSelectedAntenna(null)}
        onSelectAntenna={(ant) => focusAntennaOnMap(ant)}
      />
    </main>
  );
}
