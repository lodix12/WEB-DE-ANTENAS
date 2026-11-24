import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearch } from '@tanstack/react-router';
import {
  LayoutGrid,
  PanelLeftOpen,
  RefreshCw,
  SlidersHorizontal,
} from 'lucide-react';
import { AntenasMap } from '../components/map/AntenasMap';
import { FilterPanel } from '../components/ui/FilterPanel';
import { StationDetailDrawer } from '../components/ui/StationDetailDrawer';
import {
  getComunidadAutonomaByProvince,
  inferOperatorKeyFromAntennaId,
  matchesAntennaBandsFilter,
  resolveLiveSelectedAntenna,
  useAntenasData,
  useFilteredAntenas,
} from '../hooks/useAntenasData';
import { useUnico5gData } from '../hooks/useUnico5gData';
import { useWorkspace } from '../hooks/useWorkspace';

export function MapaView() {
  const { derived, isLoading, isError, error, refetch } = useAntenasData();
  const {
    dataset: unicoDataset,
    declaredRealAntennasById,
    isLoading: isUnicoLoading,
    isError: isUnicoError,
  } = useUnico5gData();
  const {
    styleId,
    setStyleId,
    searchQuery,
    setSearchQuery,
    selectedComunidad,
    setSelectedComunidad,
    selectedProvince,
    setSelectedProvince,
    selectedBands,
    toggleBand,
    clearBands,
    exclusiveBands,
    setExclusiveBands,
    onlyUnicoDeclared,
    setOnlyUnicoDeclared,
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
    showBandsOnMap,
    toggleShowBandsOnMap,
    clusteringLevel,
    setClusteringLevel,
    highlightUnicoDeclared,
    toggleHighlightUnicoDeclared,
    sectionsMenuOpen,
    setSectionsMenuOpen,
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

  useEffect(() => {
    if (!mobilePanelOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobilePanelOpen(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [mobilePanelOpen]);

  // Soporte de enlace directo #/?gid=3600449&id=... y respaldo por coordenadas #/?lat=...&lon=...
  useEffect(() => {
    const targetId = searchParams.id;
    const targetGid = searchParams.gid;
    const targetLat = searchParams.lat;
    const targetLon = searchParams.lon;
    const hasCoords = targetLat !== undefined && targetLon !== undefined;
    if (!targetId && !targetGid && !hasCoords) {
      appliedGidRef.current = null;
      return;
    }
    if (!derived) return;

    const targetKey = `${targetId ?? ''}|${targetGid ?? ''}|${targetLat ?? ''}|${targetLon ?? ''}`;
    if (appliedGidRef.current === targetKey) return;

    const exactById = targetId ? derived.byId.get(targetId) : undefined;
    const candidateByGid = targetGid ? derived.byGid.get(targetGid) : undefined;
    const expectedOpFromId = targetId
      ? inferOperatorKeyFromAntennaId(targetId)
      : null;
    const found =
      exactById ??
      (candidateByGid &&
      (!expectedOpFromId || candidateByGid.op === expectedOpFromId)
        ? candidateByGid
        : undefined);
    if (found) {
      appliedGidRef.current = targetKey;
      if (
        selectedComunidad &&
        getComunidadAutonomaByProvince(found.prov) !== selectedComunidad
      ) {
        setSelectedComunidad('');
      }
      if (selectedProvince && selectedProvince !== found.prov) {
        setSelectedProvince('');
      }
      if (
        selectedBands.length > 0 &&
        !matchesAntennaBandsFilter(found.bandas, selectedBands, exclusiveBands)
      ) {
        clearBands();
        setExclusiveBands(false);
      }
      if (
        onlyUnicoDeclared &&
        unicoDataset &&
        !declaredRealAntennasById.has(found.id)
      ) {
        setOnlyUnicoDeclared(false);
      }
      if (searchQuery.trim().length > 0) {
        setSearchQuery('');
      }
      focusAntennaOnMap(found);
    } else if (hasCoords) {
      appliedGidRef.current = targetKey;
      triggerFlyTo(targetLat, targetLon, 16);
    }
  }, [
    searchParams.id,
    searchParams.gid,
    searchParams.lat,
    searchParams.lon,
    derived,
    selectedComunidad,
    selectedProvince,
    selectedBands,
    exclusiveBands,
    onlyUnicoDeclared,
    unicoDataset,
    declaredRealAntennasById,
    searchQuery,
    setSelectedComunidad,
    setSelectedProvince,
    clearBands,
    setExclusiveBands,
    setOnlyUnicoDeclared,
    setSearchQuery,
    focusAntennaOnMap,
    triggerFlyTo,
  ]);

  const baseFilteredAntenas = useFilteredAntenas({
    derived,
    searchQuery,
    selectedComunidad,
    selectedProvince,
    activeOperators,
    selectedBands,
    exclusiveBands,
  });

  const unicoStatus: 'ready' | 'loading' | 'error' = isUnicoError
    ? 'error'
    : !unicoDataset && isUnicoLoading
      ? 'loading'
      : 'ready';

  const { filteredAntenas, unicoDeclaredInBaseCount } = useMemo(() => {
    if (!unicoDataset && isUnicoLoading) {
      return {
        filteredAntenas: baseFilteredAntenas,
        unicoDeclaredInBaseCount: 0,
      };
    }

    if (declaredRealAntennasById.size === 0) {
      return {
        filteredAntenas: onlyUnicoDeclared ? [] : baseFilteredAntenas,
        unicoDeclaredInBaseCount: 0,
      };
    }

    let declaredCount = 0;
    if (!onlyUnicoDeclared) {
      for (let i = 0; i < baseFilteredAntenas.length; i++) {
        if (declaredRealAntennasById.has(baseFilteredAntenas[i].id)) {
          declaredCount += 1;
        }
      }
      return {
        filteredAntenas: baseFilteredAntenas,
        unicoDeclaredInBaseCount: declaredCount,
      };
    }

    const onlyDeclared = baseFilteredAntenas.filter((ant) =>
      declaredRealAntennasById.has(ant.id),
    );
    return {
      filteredAntenas: onlyDeclared,
      unicoDeclaredInBaseCount: onlyDeclared.length,
    };
  }, [
    baseFilteredAntenas,
    declaredRealAntennasById,
    isUnicoLoading,
    onlyUnicoDeclared,
    unicoDataset,
  ]);

  const liveSelectedAntenna = useMemo(
    () => resolveLiveSelectedAntenna(selectedAntenna, derived),
    [selectedAntenna, derived],
  );

  useEffect(() => {
    if (selectedAntenna && derived && !liveSelectedAntenna) {
      setSelectedAntenna(null);
    }
  }, [selectedAntenna, derived, liveSelectedAntenna, setSelectedAntenna]);

  if (isError) {
    return (
      <main className="mapa-workspace">
        <button
          type="button"
          id="error-open-sections-btn"
          className="btn btn-secondary btn-sm page-floating-sections-btn map-error-sections-btn"
          onClick={() => setSectionsMenuOpen(true)}
          aria-expanded={sectionsMenuOpen}
          aria-controls="sections-drawer"
        >
          <LayoutGrid size={14} aria-hidden="true" />
          <span>Secciones</span>
        </button>

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
        selectedComunidad={selectedComunidad}
        onComunidadChange={setSelectedComunidad}
        selectedProvince={selectedProvince}
        onProvinceChange={setSelectedProvince}
        selectedBands={selectedBands}
        onToggleBand={toggleBand}
        onClearBands={clearBands}
        exclusiveBands={exclusiveBands}
        onExclusiveBandsChange={setExclusiveBands}
        onlyUnicoDeclared={onlyUnicoDeclared}
        onOnlyUnicoDeclaredChange={setOnlyUnicoDeclared}
        unicoDeclaredCount={unicoDeclaredInBaseCount}
        unicoStatus={unicoStatus}
        highlightUnicoDeclared={highlightUnicoDeclared}
        activeOperators={activeOperators}
        onToggleOperator={toggleOperator}
        onSelectAllOperators={selectAllOperators}
        onClearAllOperators={clearAllOperators}
        hasActiveFilters={hasActiveFilters}
        onResetFilters={resetAllFilters}
        onFlyTo={triggerFlyTo}
      />

      <div className="map-stage">
        {/* Botones flotantes inferiores izquierdos en escritorio: Filtros a la derecha de Secciones */}
        <div className="desktop-floating-controls">
          <button
            type="button"
            id="desktop-open-sections-btn"
            className="btn btn-secondary btn-sm desktop-sections-btn"
            onClick={() => setSectionsMenuOpen(true)}
            aria-expanded={sectionsMenuOpen}
            aria-controls="sections-drawer"
          >
            <LayoutGrid size={14} aria-hidden="true" />
            <span>Secciones</span>
          </button>

          {sidebarCollapsed && (
            <button
              type="button"
              id="sidebar-reopen-btn"
              className="btn btn-secondary btn-sm sidebar-reopen-btn"
              onClick={() => setSidebarCollapsed(false)}
            >
              <PanelLeftOpen size={14} aria-hidden="true" />
              <span>
                Filtros (
                <span className="mono">
                  {filteredAntenas.length.toLocaleString('es-ES')}
                </span>
                )
              </span>
            </button>
          )}
        </div>

        {/* Botones flotantes inferiores izquierdos en móvil: Filtros a la derecha de Secciones */}
        <div className="mobile-controls-bar">
          <button
            type="button"
            id="mobile-open-sections-btn"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              setMobilePanelOpen(false);
              setSectionsMenuOpen(true);
            }}
            aria-expanded={sectionsMenuOpen}
            aria-controls="sections-drawer"
          >
            <LayoutGrid size={14} aria-hidden="true" />
            <span>Secciones</span>
          </button>

          <button
            type="button"
            id="mobile-open-filters-btn"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              setSectionsMenuOpen(false);
              setMobilePanelOpen(true);
            }}
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
            <span>
              Filtros ·{' '}
              <span className="mono">
                {filteredAntenas.length.toLocaleString('es-ES')}
              </span>
            </span>
          </button>
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
            selectedAntenna={liveSelectedAntenna}
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
            showBandsOnMap={showBandsOnMap}
            onToggleShowBandsOnMap={toggleShowBandsOnMap}
            clusteringLevel={clusteringLevel}
            onClusteringLevelChange={setClusteringLevel}
            unicoDeclaredById={declaredRealAntennasById}
            highlightUnicoDeclared={highlightUnicoDeclared}
            onToggleHighlightUnicoDeclared={toggleHighlightUnicoDeclared}
            activeOperators={activeOperators}
            onToggleOperator={toggleOperator}
          />
        )}
      </div>

      <StationDetailDrawer
        antenna={liveSelectedAntenna}
        allAntenas={derived?.dataset.antenas ?? []}
        unicoDeclaredById={declaredRealAntennasById}
        onClose={() => setSelectedAntenna(null)}
        onSelectAntenna={(ant) => {
          if (onlyUnicoDeclared && !declaredRealAntennasById.has(ant.id)) {
            setOnlyUnicoDeclared(false);
          }
          focusAntennaOnMap(ant);
        }}
      />
    </main>
  );
}
