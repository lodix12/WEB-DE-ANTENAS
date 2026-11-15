import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  columnSizingFeature,
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_text,
  tableFeatures,
  useTable,
  type SortingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  Copy,
  ExternalLink,
  MapPin,
  Navigation,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import { ExportMenu } from '../components/ui/ExportMenu';
import {
  useAntenasData,
  useFilteredAntenas,
} from '../hooks/useAntenasData';
import { useWorkspace } from '../hooks/useWorkspace';
import {
  getDetalleEstacionUrl,
  OPERATOR_META,
  OPERATOR_ORDER,
  type AntennaRecord,
} from '../types/antena';
import { parseCoordinateInput } from '../utils/export';
import {
  bearingToCardinal,
  calculateBearingDeg,
  formatDistance,
  haversineDistanceKm,
} from '../utils/geo';

interface ExplorerRow extends AntennaRecord {
  distanceKm: number | undefined;
  bearingDeg: number | undefined;
  cardinal: string | undefined;
}

const explorerFeatures = tableFeatures({
  columnSizingFeature,
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    text: sortFn_text,
  },
});

const columnHelper = createColumnHelper<typeof explorerFeatures, ExplorerRow>();

export function ExplorarView() {
  const navigate = useNavigate();
  const { derived, isLoading, isError, error } = useAntenasData();
  const {
    searchQuery,
    setSearchQuery,
    selectedProvince,
    setSelectedProvince,
    selectedMunicipality,
    setSelectedMunicipality,
    activeOperators,
    toggleOperator,
    selectAllOperators,
    hasActiveFilters,
    resetAllFilters,
    radarPoint,
    setRadarPoint,
    gpsLoading,
    requestGpsLocation,
    focusAntennaOnMap,
    jumpToCoordinates,
  } = useWorkspace();

  const [sorting, setSorting] = useState<SortingState>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.title =
      'Explorador de Estaciones Móviles · RadioMapa España';
  }, []);

  const filteredAntenas = useFilteredAntenas({
    derived,
    searchQuery,
    selectedProvince,
    selectedMunicipality,
    activeOperators,
  });

  const parsedCoords = useMemo(
    () => parseCoordinateInput(searchQuery),
    [searchQuery],
  );

  const municipalities = useMemo(() => {
    if (!derived || !selectedProvince) return [];
    return derived.municipalitiesByProvince.get(selectedProvince) ?? [];
  }, [derived, selectedProvince]);

  const rowsData = useMemo<ExplorerRow[]>(() => {
    if (!radarPoint) {
      return filteredAntenas.map((ant) => ({
        ...ant,
        distanceKm: undefined,
        bearingDeg: undefined,
        cardinal: undefined,
      }));
    }
    const { lat, lon } = radarPoint;
    const enriched = new Array<ExplorerRow>(filteredAntenas.length);
    for (let i = 0; i < filteredAntenas.length; i++) {
      const ant = filteredAntenas[i];
      const distanceKm = haversineDistanceKm(lat, lon, ant.lat, ant.lon);
      const bearingDeg = calculateBearingDeg(lat, lon, ant.lat, ant.lon);
      enriched[i] = {
        ...ant,
        distanceKm,
        bearingDeg,
        cardinal: bearingToCardinal(bearingDeg),
      };
    }
    return enriched;
  }, [filteredAntenas, radarPoint]);

  // Ordenar automáticamente por cercanía cuando el usuario activa un punto de radar
  useEffect(() => {
    if (radarPoint && sorting.length === 0) {
      setSorting([{ id: 'distanceKm', desc: false }]);
    }
  }, [radarPoint, sorting.length]);

  const handleViewOnMap = useCallback(
    (ant: AntennaRecord) => {
      focusAntennaOnMap(ant);
      void navigate({
        to: '/',
        search: { gid: ant.gid },
      });
    },
    [focusAntennaOnMap, navigate],
  );

  const handleCopyCoords = useCallback(async (ant: AntennaRecord) => {
    try {
      await navigator.clipboard.writeText(
        `${ant.lat.toFixed(6)}, ${ant.lon.toFixed(6)}`,
      );
      setCopiedId(ant.id);
      window.setTimeout(() => {
        setCopiedId((curr) => (curr === ant.id ? null : curr));
      }, 1800);
    } catch {
      // Ignorar si clipboard no está disponible
    }
  }, []);

  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.accessor('op', {
          id: 'op',
          header: 'Operador',
          size: 162,
          sortFn: 'text',
          cell: (info) => {
            const meta = OPERATOR_META[info.getValue()];
            return (
              <span
                className="operator-badge"
                style={{
                  backgroundColor: meta.softBg,
                  color: meta.color,
                  border: `1px solid ${meta.color}2e`,
                }}
                title={info.row.original.opRaw}
              >
                <span
                  className="operator-dot"
                  style={{ backgroundColor: meta.color }}
                  aria-hidden="true"
                />
                {meta.shortName}
              </span>
            );
          },
        }),
        columnHelper.accessor('gid', {
          id: 'gid',
          header: 'Código Gis_ID',
          size: 122,
          sortFn: 'alphanumeric',
          cell: (info) => (
            <span className="mono" style={{ fontWeight: 600 }}>
              {info.getValue()}
            </span>
          ),
        }),
        columnHelper.accessor('mun', {
          id: 'mun',
          header: 'Municipio',
          size: 175,
          sortFn: 'text',
          cell: (info) => (
            <span style={{ fontWeight: 600 }} title={info.getValue()}>
              {info.getValue()}
            </span>
          ),
        }),
        columnHelper.accessor('prov', {
          id: 'prov',
          header: 'Provincia',
          size: 150,
          sortFn: 'text',
          cell: (info) => (
            <span style={{ color: 'var(--text-secondary)' }}>
              {info.getValue()}
            </span>
          ),
        }),
        columnHelper.accessor('dir', {
          id: 'dir',
          header: 'Dirección del Emplazamiento',
          size: 260,
          sortFn: 'text',
          cell: (info) => (
            <span
              style={{
                color: 'var(--text-secondary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              title={info.getValue()}
            >
              {info.getValue() || '—'}
            </span>
          ),
        }),
        columnHelper.display({
          id: 'coords',
          header: 'Coordenadas WGS84',
          size: 196,
          enableSorting: false,
          cell: (info) => {
            const row = info.row.original;
            const isCopied = copiedId === row.id;
            return (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span className="mono" style={{ fontSize: 11.5 }}>
                  {row.lat.toFixed(5)}, {row.lon.toFixed(5)}
                </span>
                <button
                  type="button"
                  className="search-clear-btn"
                  style={{ position: 'static', width: 22, height: 22 }}
                  onClick={() => void handleCopyCoords(row)}
                  title="Copiar coordenadas"
                  aria-label={`Copiar coordenadas de estación ${row.gid}`}
                >
                  {isCopied ? <Check size={12} /> : <Copy size={12} />}
                </button>
              </span>
            );
          },
        }),
        columnHelper.accessor('distanceKm', {
          id: 'distanceKm',
          header: 'Distancia · Acimut',
          size: 164,
          sortUndefined: 'last',
          cell: (info) => {
            const dist = info.getValue();
            const row = info.row.original;
            if (dist === undefined) {
              return (
                <span style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>
                  Sin punto GPS/Radar
                </span>
              );
            }
            return (
              <span className="mono" style={{ fontSize: 12 }}>
                <strong>{formatDistance(dist)}</strong>{' '}
                <span style={{ color: 'var(--accent-primary)' }}>
                  {row.cardinal?.replace(/[()]/g, '')}
                </span>
              </span>
            );
          },
        }),
        columnHelper.display({
          id: 'actions',
          header: 'Acciones',
          size: 204,
          enableSorting: false,
          cell: (info) => {
            const row = info.row.original;
            return (
              <div className="cell-actions">
                <button
                  type="button"
                  className="btn btn-subtle btn-sm"
                  onClick={() => handleViewOnMap(row)}
                >
                  <MapPin size={12} aria-hidden="true" />
                  <span>Ver en mapa</span>
                </button>
                <a
                  href={getDetalleEstacionUrl(row)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-secondary btn-sm"
                  title="Abrir ficha oficial de exposición y bandas (MHz) en MINETUR"
                >
                  <span>Ficha</span>
                  <ExternalLink size={11} aria-hidden="true" />
                </a>
              </div>
            );
          },
        }),
      ]),
    [copiedId, handleCopyCoords, handleViewOnMap],
  );

  const table = useTable({
    features: explorerFeatures,
    data: rowsData,
    columns,
    getRowId: (row) => row.id,
    state: {
      sorting,
    },
    onSortingChange: setSorting,
  });

  const { rows } = table.getRowModel();

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 46,
    getItemKey: (index) => rows[index].id,
    overscan: 14,
  });

  return (
    <main className="explorar-page">
      <section className="explorar-toolbar" aria-label="Filtros del explorador">
        <div className="explorar-toolbar-top">
          <div className="explorar-heading-group">
            <h1 className="explorar-title">Explorador del Censo de Antenas</h1>
            <span className="explorar-count-summary">
              Mostrando{' '}
              <strong className="mono" style={{ color: 'var(--text-primary)' }}>
                {rowsData.length.toLocaleString('es-ES')}
              </strong>{' '}
              de{' '}
              <span className="mono">
                {(derived?.dataset.total ?? 0).toLocaleString('es-ES')}
              </span>{' '}
              estaciones registradas
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {radarPoint ? (
              <span
                className="dataset-live-badge"
                title="Punto de referencia activo para cálculo de distancia y acimut"
              >
                <span className="mono" style={{ fontSize: 11.5 }}>
                  Radar: {radarPoint.lat.toFixed(4)}, {radarPoint.lon.toFixed(4)}
                </span>
                <button
                  type="button"
                  className="text-link-btn"
                  onClick={() => setRadarPoint(null)}
                >
                  Quitar
                </button>
              </span>
            ) : (
              <button
                type="button"
                id="explorer-gps-btn"
                className="btn btn-secondary btn-sm"
                onClick={() => requestGpsLocation(false)}
                disabled={gpsLoading}
              >
                <Navigation size={13} aria-hidden="true" />
                <span>
                  {gpsLoading ? 'Localizando…' : 'Calcular distancia GPS'}
                </span>
              </button>
            )}

            <ExportMenu
              antenas={filteredAntenas}
              radarPoint={radarPoint}
              align="right"
              idPrefix="explorer-export"
            />
          </div>
        </div>

        <div className="explorar-filters-row">
          <div className="search-input-wrap">
            <span className="search-input-icon" aria-hidden="true">
              <Search size={14} />
            </span>
            <input
              id="explorer-search-input"
              type="search"
              className="search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && parsedCoords) {
                  e.preventDefault();
                  jumpToCoordinates(parsedCoords.lat, parsedCoords.lon);
                }
              }}
              placeholder="Filtrar por municipio, calle, código Gis_ID, razón social o coordenadas…"
            />
            {searchQuery && (
              <button
                type="button"
                className="search-clear-btn"
                onClick={() => setSearchQuery('')}
                aria-label="Limpiar búsqueda"
              >
                <X size={14} />
              </button>
            )}
          </div>

          <select
            id="explorer-province-select"
            aria-label="Filtrar por provincia"
            className="select-control"
            value={selectedProvince}
            onChange={(e) => setSelectedProvince(e.target.value)}
          >
            <option value="">Todas las provincias</option>
            {derived?.provincesByAlpha.map((p) => (
              <option key={p.provincia} value={p.provincia}>
                {p.provincia} ({p.count.toLocaleString('es-ES')})
              </option>
            ))}
          </select>

          <select
            id="explorer-municipality-select"
            aria-label="Filtrar por municipio"
            className="select-control"
            value={selectedMunicipality}
            disabled={!selectedProvince}
            onChange={(e) => setSelectedMunicipality(e.target.value)}
          >
            <option value="">
              {selectedProvince
                ? `Todos los municipios (${municipalities.length})`
                : 'Selecciona provincia'}
            </option>
            {municipalities.map((m) => (
              <option key={m.mun} value={m.mun}>
                {m.mun} ({m.count})
              </option>
            ))}
          </select>

          {hasActiveFilters ? (
            <button
              type="button"
              id="explorer-reset-btn"
              className="btn btn-subtle"
              onClick={resetAllFilters}
            >
              <RotateCcw size={13} aria-hidden="true" />
              <span>Limpiar filtros</span>
            </button>
          ) : (
            <div />
          )}
        </div>

        <div className="explorar-operators-bar">
          <div className="explorar-op-chips" role="group" aria-label="Filtrar por operador">
            {OPERATOR_ORDER.map((opKey) => {
              const meta = OPERATOR_META[opKey];
              const isActive = activeOperators.includes(opKey);
              const count = derived?.operatorCounts[opKey] ?? 0;
              return (
                <button
                  key={opKey}
                  type="button"
                  id={`explorer-op-${opKey}`}
                  className={`op-chip-inline ${
                    isActive ? 'is-active' : 'is-inactive'
                  }`}
                  onClick={() => toggleOperator(opKey)}
                  aria-pressed={isActive}
                >
                  <span
                    className="operator-dot"
                    style={{ backgroundColor: meta.color }}
                    aria-hidden="true"
                  />
                  <span>{meta.shortName}</span>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {count.toLocaleString('es-ES')}
                  </span>
                </button>
              );
            })}
            {activeOperators.length < OPERATOR_ORDER.length && (
              <button
                type="button"
                className="text-link-btn"
                onClick={selectAllOperators}
              >
                Activar todos
              </button>
            )}
          </div>

          {parsedCoords && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                setRadarPoint({
                  lat: parsedCoords.lat,
                  lon: parsedCoords.lon,
                  label: 'Coordenadas de búsqueda',
                });
              }}
            >
              <MapPin size={12} aria-hidden="true" />
              <span>
                Fijar radar en {parsedCoords.lat.toFixed(4)},{' '}
                {parsedCoords.lon.toFixed(4)}
              </span>
            </button>
          )}
        </div>
      </section>

      {/* Tabla Virtualizada */}
      <div className="datagrid-shell">
        {isLoading && !derived ? (
          <div className="state-center-box">
            <div className="spinner-ring" aria-hidden="true" />
            <p>Cargando tabla de emplazamientos…</p>
          </div>
        ) : isError ? (
          <div className="state-center-box">
            <p style={{ color: 'var(--status-danger)', fontWeight: 600 }}>
              {error instanceof Error
                ? error.message
                : 'Error al cargar los datos'}
            </p>
          </div>
        ) : rows.length === 0 ? (
          <div className="state-center-box">
            <p style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
              Ninguna estación coincide con los filtros actuales
            </p>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={resetAllFilters}
            >
              Restablecer filtros
            </button>
          </div>
        ) : (
          <div
            ref={scrollContainerRef}
            className="datagrid-scroll-viewport"
            role="table"
            aria-label="Tabla de estaciones base de telefonía móvil"
            aria-rowcount={rows.length}
          >
            <div className="datagrid-inner-width">
              <div className="datagrid-header" role="rowgroup">
                {table.getHeaderGroups().map((headerGroup) => (
                  <div
                    key={headerGroup.id}
                    className="datagrid-header-row"
                    role="row"
                  >
                    {headerGroup.headers.map((header) => {
                      const canSort = header.column.getCanSort();
                      const sortedDir = header.column.getIsSorted();
                      const isFlexible = header.column.id === 'dir';
                      const width = header.getSize();

                      return (
                        <div
                          key={header.id}
                          role="columnheader"
                          aria-sort={
                            sortedDir === 'asc'
                              ? 'ascending'
                              : sortedDir === 'desc'
                                ? 'descending'
                                : 'none'
                          }
                          className={`datagrid-th ${
                            canSort ? 'is-sortable' : ''
                          }`}
                          style={{
                            width,
                            minWidth: width,
                            flex: isFlexible ? '1 1 auto' : '0 0 auto',
                          }}
                          onClick={
                            canSort
                              ? header.column.getToggleSortingHandler()
                              : undefined
                          }
                        >
                          {header.isPlaceholder ? null : (
                            <>
                              <table.FlexRender header={header} />
                              {canSort && (
                                <span
                                  style={{
                                    display: 'inline-flex',
                                    color: sortedDir
                                      ? 'var(--accent-primary)'
                                      : 'var(--text-muted)',
                                  }}
                                  aria-hidden="true"
                                >
                                  {sortedDir === 'asc' ? (
                                    <ArrowUp size={13} />
                                  ) : sortedDir === 'desc' ? (
                                    <ArrowDown size={13} />
                                  ) : (
                                    <ArrowUpDown size={12} style={{ opacity: 0.55 }} />
                                  )}
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>

              <div
                className="datagrid-body"
                role="rowgroup"
                style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
              >
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const row = rows[virtualRow.index];
                  return (
                    <div
                      key={row.id}
                      role="row"
                      aria-rowindex={virtualRow.index + 1}
                      className="datagrid-tr"
                      style={{
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      {row.getAllCells().map((cell) => {
                        const isFlexible = cell.column.id === 'dir';
                        const width = cell.column.getSize();
                        return (
                          <div
                            key={cell.id}
                            role="cell"
                            className="datagrid-td"
                            style={{
                              width,
                              minWidth: width,
                              flex: isFlexible ? '1 1 auto' : '0 0 auto',
                            }}
                          >
                            <table.FlexRender cell={cell} />
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
