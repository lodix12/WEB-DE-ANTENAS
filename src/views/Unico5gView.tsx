import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Crosshair,
  Download,
  ExternalLink,
  FileJson,
  FileSpreadsheet,
  Layers,
  MapPin,
  RadioTower,
  RotateCcw,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { Unico5gMap } from '../components/map/Unico5gMap';
import { Unico5gCharts } from '../components/unico5g/Unico5gCharts';
import {
  UNICO_PAGE_SIZE_OPTIONS,
  buildUnicoCascadeOptions,
  computeUnicoAnalytics,
  downloadUnico5gCsv,
  downloadUnico5gJson,
  filterUnicoAntennas,
  formatUnicoInt,
  formatUnicoPercent,
  parseOperatorsSearchParam,
  sortUnicoAntennasNeutral,
  useUnico5gData,
  validateUnico5gSearch,
} from '../hooks/useUnico5gData';
import { useWorkspace } from '../hooks/useWorkspace';
import {
  UNICO_FASE_META,
  UNICO_OPERATOR_META,
  UNICO_OPERATOR_ORDER,
  type UnicoAntennaRecord,
  type UnicoBounds,
  type UnicoColorMode,
  type UnicoFaseFilter,
  type UnicoOperatorKey,
  type UnicoRouteSearch,
  type UnicoTableSortField,
} from '../types/unico5g';
import '../styles/unico5g.css';

function buildPageTokens(
  current: number,
  total: number,
): Array<number | 'ellipsis-left' | 'ellipsis-right'> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, idx) => idx + 1);
  }
  const tokens: Array<number | 'ellipsis-left' | 'ellipsis-right'> = [1];
  const left = Math.max(2, current - 1);
  const right = Math.min(total - 1, current + 1);

  if (left > 2) {
    tokens.push('ellipsis-left');
  }
  for (let p = left; p <= right; p++) {
    tokens.push(p);
  }
  if (right < total - 1) {
    tokens.push('ellipsis-right');
  }
  tokens.push(total);
  return tokens;
}

export function Unico5gView() {
  const navigate = useNavigate();
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const urlSearch = useMemo(() => validateUnico5gSearch(rawSearch), [rawSearch]);

  const { dataset, searchIndex, isLoading, isError, error } = useUnico5gData();
  const { styleId, setStyleId } = useWorkspace();

  const [draftQuery, setDraftQuery] = useState<string | null>(null);
  const localQuery = draftQuery ?? (urlSearch.q ?? '');
  const [sortField, setSortField] = useState<UnicoTableSortField>('territorio');
  const [sortAsc, setSortAsc] = useState(true);
  const [selectedAntenna, setSelectedAntenna] =
    useState<UnicoAntennaRecord | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [manualFocusBounds, setManualFocusBounds] = useState<{
    bounds: UnicoBounds;
    key: string;
  } | null>(null);
  const [focusPoint, setFocusPoint] = useState<{
    lat: number;
    lon: number;
    zoom?: number;
    seq: number;
  } | null>(null);

  const mapSectionRef = useRef<HTMLElement | null>(null);
  const exportWrapRef = useRef<HTMLDivElement | null>(null);
  const searchDebounceRef = useRef<number | null>(null);
  const focusSeqRef = useRef(0);

  useEffect(() => {
    document.title =
      'UNICO 5G · Antenas Subvencionadas Fase 1 y Fase 2 · RadioMapa España';
  }, []);

  useEffect(() => {
    if (!exportOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (
        exportWrapRef.current &&
        !exportWrapRef.current.contains(e.target as Node)
      ) {
        setExportOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [exportOpen]);

  useEffect(() => {
    return () => {
      if (searchDebounceRef.current !== null) {
        window.clearTimeout(searchDebounceRef.current);
      }
    };
  }, []);

  const activeFase: UnicoFaseFilter = urlSearch.fase ?? 'all';
  const activeOperators = useMemo(
    () => parseOperatorsSearchParam(urlSearch.op),
    [urlSearch.op],
  );
  const selectedCcaa = urlSearch.ccaa ?? '';
  const selectedProv = urlSearch.prov ?? '';
  const selectedMun = urlSearch.mun ?? '';
  const colorMode: UnicoColorMode = urlSearch.colorMode ?? 'operator';
  const pageSize = urlSearch.pageSize ?? 50;

  function commitSearch(patch: Partial<UnicoRouteSearch>, resetPage = true) {
    const next: UnicoRouteSearch = {
      ...urlSearch,
      ...patch,
    };
    if (resetPage && patch.page === undefined) {
      delete next.page;
    }
    if (!next.fase || (next.fase !== '1' && next.fase !== '2')) {
      delete next.fase;
    }
    if (!next.op) delete next.op;
    if (!next.ccaa) delete next.ccaa;
    if (!next.prov) delete next.prov;
    if (!next.mun) delete next.mun;
    if (!next.q) delete next.q;
    if (!next.colorMode || next.colorMode === 'operator') {
      delete next.colorMode;
    }
    if (!next.page || next.page <= 1) delete next.page;
    if (!next.pageSize || next.pageSize === 50) delete next.pageSize;

    void navigate({
      to: '/unico-5g',
      search: next,
      replace: true,
    });
  }

  const cascade = useMemo(() => {
    if (!dataset) {
      return {
        comunidades: [],
        provincias: [],
        municipios: [],
        provToCcaa: new Map<string, string>(),
      };
    }
    return buildUnicoCascadeOptions(dataset, {
      fase: activeFase,
      operators: activeOperators,
      ccaa: selectedCcaa,
      prov: selectedProv,
    });
  }, [dataset, activeFase, activeOperators, selectedCcaa, selectedProv]);

  const filteredAntennas = useMemo(() => {
    if (!dataset) return [];
    return filterUnicoAntennas(dataset.antenas, searchIndex, {
      fase: activeFase,
      operators: activeOperators,
      ccaa: selectedCcaa,
      prov: selectedProv,
      mun: selectedMun,
      query: localQuery,
    });
  }, [
    dataset,
    searchIndex,
    activeFase,
    activeOperators,
    selectedCcaa,
    selectedProv,
    selectedMun,
    localQuery,
  ]);

  // Totales por operador bajo los filtros territoriales/fase actuales (para mostrar en los chips de operador)
  const operatorChipCounts = useMemo(() => {
    const counts: Record<UnicoOperatorKey, number> = {
      movistar: 0,
      orange: 0,
      vodafone: 0,
      avatel: 0,
    };
    if (!dataset) return { counts, totalScope: 0 };
    const scopeRows = filterUnicoAntennas(dataset.antenas, searchIndex, {
      fase: activeFase,
      operators: [...UNICO_OPERATOR_ORDER],
      ccaa: selectedCcaa,
      prov: selectedProv,
      mun: selectedMun,
      query: localQuery,
    });
    for (let i = 0; i < scopeRows.length; i++) {
      counts[scopeRows[i].op]++;
    }
    return { counts, totalScope: scopeRows.length };
  }, [
    dataset,
    searchIndex,
    activeFase,
    selectedCcaa,
    selectedProv,
    selectedMun,
    localQuery,
  ]);

  // Totales por fase bajo los filtros territoriales/operador actuales (para mostrar en el selector de Fase)
  const faseChipCounts = useMemo(() => {
    if (!dataset) return { all: 0, f1: 0, f2: 0 };
    const scopeRows = filterUnicoAntennas(dataset.antenas, searchIndex, {
      fase: 'all',
      operators: activeOperators,
      ccaa: selectedCcaa,
      prov: selectedProv,
      mun: selectedMun,
      query: localQuery,
    });
    let f1 = 0;
    let f2 = 0;
    for (let i = 0; i < scopeRows.length; i++) {
      if (scopeRows[i].fase === 1) f1++;
      else f2++;
    }
    return { all: scopeRows.length, f1, f2 };
  }, [
    dataset,
    searchIndex,
    activeOperators,
    selectedCcaa,
    selectedProv,
    selectedMun,
    localQuery,
  ]);

  const analytics = useMemo(() => {
    if (!dataset) return null;
    return computeUnicoAnalytics(dataset, filteredAntennas);
  }, [dataset, filteredAntennas]);

  const sortedTableRows = useMemo(
    () => sortUnicoAntennasNeutral(filteredAntennas, sortField, sortAsc),
    [filteredAntennas, sortField, sortAsc],
  );

  const totalPages = Math.max(1, Math.ceil(sortedTableRows.length / pageSize));
  const currentPage = Math.min(Math.max(1, urlSearch.page ?? 1), totalPages);
  const pageStartIdx = (currentPage - 1) * pageSize;
  const pagedRows = useMemo(
    () => sortedTableRows.slice(pageStartIdx, pageStartIdx + pageSize),
    [sortedTableRows, pageStartIdx, pageSize],
  );
  const pageTokens = useMemo(
    () => buildPageTokens(currentPage, totalPages),
    [currentPage, totalPages],
  );

  const allOperatorsActive =
    activeOperators.length === UNICO_OPERATOR_ORDER.length;
  const hasActiveFilters =
    activeFase !== 'all' ||
    !allOperatorsActive ||
    selectedCcaa !== '' ||
    selectedProv !== '' ||
    selectedMun !== '' ||
    localQuery.trim().length > 0;

  // Determinar qué límites usar en el mapa cuando cambia un filtro territorial o se pulsa "Mapa"
  const territorialFilterKey = selectedMun
    ? `mun:${selectedProv}:${selectedMun}`
    : selectedProv
      ? `prov:${selectedProv}`
      : selectedCcaa
        ? `ccaa:${selectedCcaa}`
        : 'all';

  const effectiveMapBounds = manualFocusBounds
    ? manualFocusBounds.bounds
    : territorialFilterKey !== 'all'
      ? (analytics?.selectedBounds ?? null)
      : null;

  const effectiveMapBoundsKey = manualFocusBounds
    ? manualFocusBounds.key
    : territorialFilterKey;

  function handleSelectFase(nextFase: UnicoFaseFilter) {
    setManualFocusBounds(null);
    commitSearch({ fase: nextFase === 'all' ? undefined : nextFase });
  }

  function handleToggleSingleOperator(op: UnicoOperatorKey) {
    setManualFocusBounds(null);
    if (activeOperators.length === 1 && activeOperators[0] === op) {
      commitSearch({ op: undefined });
      return;
    }
    commitSearch({ op });
  }

  function handleToggleOperatorMulti(
    op: UnicoOperatorKey,
    shiftOrMulti = false,
  ) {
    setManualFocusBounds(null);
    if (!shiftOrMulti) {
      if (allOperatorsActive) {
        commitSearch({ op });
        return;
      }
      if (activeOperators.length === 1 && activeOperators[0] === op) {
        commitSearch({ op: undefined });
        return;
      }
      commitSearch({ op });
      return;
    }

    const exists = activeOperators.includes(op);
    const nextOps = exists
      ? activeOperators.filter((item) => item !== op)
      : [...activeOperators, op];

    if (
      nextOps.length === 0 ||
      nextOps.length === UNICO_OPERATOR_ORDER.length
    ) {
      commitSearch({ op: undefined });
    } else {
      commitSearch({ op: nextOps.join(',') });
    }
  }

  function handleSelectAllOperators() {
    setManualFocusBounds(null);
    commitSearch({ op: undefined });
  }

  function handleCcaaChange(nextCcaa: string) {
    setManualFocusBounds(null);
    setSelectedAntenna(null);
    commitSearch({
      ccaa: nextCcaa || undefined,
      prov: undefined,
      mun: undefined,
    });
  }

  function handleProvChange(nextProv: string) {
    setManualFocusBounds(null);
    setSelectedAntenna(null);
    if (!nextProv) {
      commitSearch({ prov: undefined, mun: undefined });
      return;
    }
    const inferredCcaa = cascade.provToCcaa.get(nextProv) ?? selectedCcaa;
    commitSearch({
      ccaa: inferredCcaa || undefined,
      prov: nextProv,
      mun: undefined,
    });
  }

  function handleSelectProvFromChart(ccaa: string, prov: string) {
    setManualFocusBounds(null);
    setSelectedAntenna(null);
    if (selectedProv === prov) {
      commitSearch({ prov: undefined, mun: undefined });
      return;
    }
    commitSearch({
      ccaa,
      prov,
      mun: undefined,
    });
  }

  function handleSelectCcaaFromChart(ccaa: string) {
    setManualFocusBounds(null);
    setSelectedAntenna(null);
    if (selectedCcaa === ccaa && !selectedProv) {
      commitSearch({ ccaa: undefined, prov: undefined, mun: undefined });
      return;
    }
    commitSearch({
      ccaa,
      prov: undefined,
      mun: undefined,
    });
  }

  function handleMunChange(nextVal: string) {
    setManualFocusBounds(null);
    setSelectedAntenna(null);
    if (!nextVal) {
      commitSearch({ mun: undefined });
      return;
    }
    const sepIdx = nextVal.indexOf('::');
    if (sepIdx !== -1) {
      const targetProv = nextVal.slice(0, sepIdx);
      const targetMun = nextVal.slice(sepIdx + 2);
      const inferredCcaa = cascade.provToCcaa.get(targetProv) ?? selectedCcaa;
      commitSearch({
        ccaa: inferredCcaa || undefined,
        prov: targetProv || undefined,
        mun: targetMun || undefined,
      });
      return;
    }
    commitSearch({ mun: nextVal });
  }

  function handleQueryInput(value: string) {
    setDraftQuery(value);
    if (searchDebounceRef.current !== null) {
      window.clearTimeout(searchDebounceRef.current);
    }
    searchDebounceRef.current = window.setTimeout(() => {
      commitSearch({ q: value.trim() || undefined });
      setDraftQuery(null);
    }, 200);
  }

  function handleClearFilters() {
    if (searchDebounceRef.current !== null) {
      window.clearTimeout(searchDebounceRef.current);
    }
    setDraftQuery(null);
    setManualFocusBounds(null);
    setSelectedAntenna(null);
    void navigate({
      to: '/unico-5g',
      search: colorMode === 'fase' ? { colorMode: 'fase' } : {},
      replace: true,
    });
  }

  function handleColorModeChange(nextMode: UnicoColorMode) {
    commitSearch(
      { colorMode: nextMode === 'operator' ? undefined : nextMode },
      false,
    );
  }

  function handleFocusTerritoryOnMap(bounds: UnicoBounds, label: string) {
    focusSeqRef.current += 1;
    setManualFocusBounds({
      bounds,
      key: `manual:${label}:${focusSeqRef.current}`,
    });
    mapSectionRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
    });
  }

  function handleFocusAntennaOnMap(antena: UnicoAntennaRecord) {
    focusSeqRef.current += 1;
    setSelectedAntenna(antena);
    setFocusPoint({
      lat: antena.lat,
      lon: antena.lon,
      zoom: 14.5,
      seq: focusSeqRef.current,
    });
    mapSectionRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  }

  function handleToggleTableSort(field: UnicoTableSortField) {
    if (sortField === field) {
      setSortAsc((prev) => !prev);
    } else {
      setSortField(field);
      setSortAsc(true);
    }
  }

  if (isLoading && !dataset) {
    return (
      <main className="page-container unico-page">
        <div className="state-center-box">
          <div className="spinner-ring" aria-hidden="true" />
          <p>
            Cargando ubicaciones y estadísticas de UNICO 5G Redes Activas (Fase
            1 y Fase 2)…
          </p>
        </div>
      </main>
    );
  }

  if (isError || !dataset || !analytics) {
    return (
      <main className="page-container unico-page">
        <div className="state-center-box">
          <p style={{ color: 'var(--status-danger)', fontWeight: 600 }}>
            {error instanceof Error
              ? error.message
              : 'No se pudieron cargar los datos de UNICO 5G.'}
          </p>
        </div>
      </main>
    );
  }

  const orangeGlobal = dataset.operators.orange;

  return (
    <main className="page-container unico-page">
      {/* Cabecera Editorial */}
      <header className="page-hero unico-hero">
        <div className="unico-hero-top">
          <span className="page-eyebrow">
            Programa UNICO 5G · Redes Activas · Convocatorias 2023 y 2024
          </span>
          <div className="unico-hero-pills">
            <span className="unico-program-chip is-f1 mono">
              Fase 1: {formatUnicoInt(dataset.fase1Total)} (
              {formatUnicoPercent(dataset.fase1Total, dataset.total)})
            </span>
            <span className="unico-program-chip is-f2 mono">
              Fase 2: {formatUnicoInt(dataset.fase2Total)} (
              {formatUnicoPercent(dataset.fase2Total, dataset.total)})
            </span>
          </div>
        </div>

        <h1 className="page-h1">UNICO 5G · Antenas Subvencionadas</h1>

        <p className="page-lead">
          Visor cartográfico, análisis estadístico y distribución territorial de
          las{' '}
          <strong>
            {formatUnicoInt(dataset.total)} ubicaciones subvencionadas
          </strong>{' '}
          en los proyectos de <strong>Fase 1</strong> (Convocatoria 2023) y{' '}
          <strong>Fase 2</strong> (Convocatoria 2024). Todos los proyectos con
          participación de <strong>Orange</strong> —incluidas las adjudicaciones
          en UTE (
          <em>UTE Orange Espagne y Orange Comunicaciones Fijas</em>)— están
          unificados dentro de{' '}
          <strong>
            Orange ({formatUnicoInt(orangeGlobal.total)} antenas ·{' '}
            {formatUnicoPercent(orangeGlobal.total, dataset.total)})
          </strong>
          .
        </p>
      </header>

      {/* Panel Maestro de Filtros Multi-Criterio */}
      <section
        id="unico-filters-panel"
        className="section-block unico-filters-card"
        aria-labelledby="unico-filters-title"
      >
        <div className="unico-filters-header">
          <div className="unico-filters-title-wrap">
            <SlidersHorizontal size={15} aria-hidden="true" />
            <h2 id="unico-filters-title" className="unico-filters-h2">
              Filtros Interactivos · Proyecto, Operador y Territorio
            </h2>
          </div>

          <div className="unico-filters-actions">
            {hasActiveFilters && (
              <button
                type="button"
                id="unico-clear-filters-btn"
                className="btn btn-subtle btn-sm"
                onClick={handleClearFilters}
              >
                <RotateCcw size={13} aria-hidden="true" />
                <span>Restablecer filtros</span>
              </button>
            )}

            <div className="export-menu-wrap" ref={exportWrapRef}>
              <button
                type="button"
                id="unico-export-btn"
                className="btn btn-secondary btn-sm"
                aria-expanded={exportOpen}
                onClick={() => setExportOpen((prev) => !prev)}
                disabled={filteredAntennas.length === 0}
              >
                <Download size={13} aria-hidden="true" />
                <span>
                  Exportar ({formatUnicoInt(filteredAntennas.length)})
                </span>
              </button>

              {exportOpen && (
                <div className="export-dropdown" role="menu">
                  <button
                    type="button"
                    id="unico-export-csv-btn"
                    className="export-option"
                    role="menuitem"
                    onClick={() => {
                      downloadUnico5gCsv(filteredAntennas);
                      setExportOpen(false);
                    }}
                  >
                    <span className="export-option-title">
                      <span>CSV compatible con Excel</span>
                      <FileSpreadsheet size={14} aria-hidden="true" />
                    </span>
                    <span className="export-option-desc">
                      Operador, Fase, CCAA, Provincia, Municipio y Coordenadas
                    </span>
                  </button>

                  <button
                    type="button"
                    id="unico-export-json-btn"
                    className="export-option"
                    role="menuitem"
                    onClick={() => {
                      downloadUnico5gJson(filteredAntennas);
                      setExportOpen(false);
                    }}
                  >
                    <span className="export-option-title">
                      <span>JSON estructurado (.json)</span>
                      <FileJson size={14} aria-hidden="true" />
                    </span>
                    <span className="export-option-desc">
                      Fase, operador, entidad, municipio, provincia y coordenadas
                    </span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="unico-filters-body">
          {/* Fila 1: Selector por Fase 1 / Fase 2 */}
          <div className="unico-filter-block">
            <span className="unico-filter-group-label">
              Proyecto / Convocatoria
            </span>
            <div
              className="unico-phase-segmented"
              role="group"
              aria-label="Filtrar por Fase de UNICO 5G"
            >
              <button
                type="button"
                id="unico-fase-btn-all"
                className={`unico-phase-seg-btn${
                  activeFase === 'all' ? ' is-active' : ''
                }`}
                aria-pressed={activeFase === 'all'}
                onClick={() => handleSelectFase('all')}
              >
                <Layers size={14} aria-hidden="true" />
                <span className="unico-phase-seg-label">
                  Fase 1 + Fase 2
                </span>
                <span className="unico-phase-seg-stat mono">
                  {formatUnicoInt(faseChipCounts.all)} · 100 %
                </span>
              </button>

              <button
                type="button"
                id="unico-fase-btn-1"
                className={`unico-phase-seg-btn is-f1${
                  activeFase === '1' ? ' is-active' : ''
                }`}
                aria-pressed={activeFase === '1'}
                onClick={() =>
                  handleSelectFase(activeFase === '1' ? 'all' : '1')
                }
              >
                <span
                  className="operator-dot"
                  style={{ backgroundColor: UNICO_FASE_META[1].color }}
                  aria-hidden="true"
                />
                <span className="unico-phase-seg-label">
                  Fase 1 · 2023
                </span>
                <span className="unico-phase-seg-stat mono">
                  {formatUnicoInt(faseChipCounts.f1)} ·{' '}
                  {formatUnicoPercent(faseChipCounts.f1, faseChipCounts.all)}
                </span>
              </button>

              <button
                type="button"
                id="unico-fase-btn-2"
                className={`unico-phase-seg-btn is-f2${
                  activeFase === '2' ? ' is-active' : ''
                }`}
                aria-pressed={activeFase === '2'}
                onClick={() =>
                  handleSelectFase(activeFase === '2' ? 'all' : '2')
                }
              >
                <span
                  className="operator-dot"
                  style={{ backgroundColor: UNICO_FASE_META[2].color }}
                  aria-hidden="true"
                />
                <span className="unico-phase-seg-label">
                  Fase 2 · 2024
                </span>
                <span className="unico-phase-seg-stat mono">
                  {formatUnicoInt(faseChipCounts.f2)} ·{' '}
                  {formatUnicoPercent(faseChipCounts.f2, faseChipCounts.all)}
                </span>
              </button>
            </div>
          </div>

          {/* Fila 2: Filtro por Operador Subvencionado */}
          <div className="unico-filter-block">
            <div className="unico-filter-label-row">
              <span className="unico-filter-group-label">
                Operador adjudicatario
              </span>
              <span className="unico-filter-hint">
                Pulsa un operador para aislarlo (Mayús+clic para selección
                múltiple)
              </span>
            </div>

            <div
              className="unico-op-filter-chips"
              role="group"
              aria-label="Filtrar por operador subvencionado"
            >
              <button
                type="button"
                id="unico-op-btn-all"
                className={`novedades-op-chip${
                  allOperatorsActive ? ' is-active' : ''
                }`}
                aria-pressed={allOperatorsActive}
                onClick={handleSelectAllOperators}
              >
                <span>Todos ({UNICO_OPERATOR_ORDER.length})</span>
              </button>

              {UNICO_OPERATOR_ORDER.map((opKey) => {
                const meta = UNICO_OPERATOR_META[opKey];
                const isSelected = activeOperators.includes(opKey);
                const isIsolated = !allOperatorsActive && isSelected;
                const count = operatorChipCounts.counts[opKey];
                const pct = formatUnicoPercent(
                  count,
                  operatorChipCounts.totalScope,
                );

                return (
                  <button
                    key={opKey}
                    type="button"
                    id={`unico-op-btn-${opKey}`}
                    className={`unico-op-chip${
                      isIsolated
                        ? ' is-isolated'
                        : isSelected
                          ? ' is-included'
                          : ' is-muted'
                    }`}
                    style={
                      isIsolated
                        ? {
                            backgroundColor: meta.softBg,
                            borderColor: meta.color,
                          }
                        : undefined
                    }
                    aria-pressed={isIsolated}
                    title={meta.description}
                    onClick={(e) =>
                      handleToggleOperatorMulti(opKey, e.shiftKey)
                    }
                  >
                    <span
                      className="operator-dot"
                      style={{ backgroundColor: meta.color }}
                      aria-hidden="true"
                    />
                    <span className="unico-op-chip-name">{meta.shortName}</span>
                    {opKey === 'orange' && (
                      <span className="unico-op-ute-pill">incl. UTE</span>
                    )}
                    <span className="unico-op-chip-count mono">
                      {formatUnicoInt(count)} ({pct})
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Fila 3: Selectores en Cascada por Comunidad Autónoma, Provincia, Municipio y Búsqueda */}
          <div className="unico-territorial-grid">
            <div className="novedades-filter-field">
              <label
                htmlFor="unico-filter-ccaa"
                className="novedades-filter-label"
              >
                Comunidad Autónoma
              </label>
              <select
                id="unico-filter-ccaa"
                className="select-control"
                value={selectedCcaa}
                onChange={(e) => handleCcaaChange(e.target.value)}
              >
                <option value="">
                  Todas las comunidades ({cascade.comunidades.length})
                </option>
                {cascade.comunidades.map((c) => (
                  <option key={c.ccaa} value={c.ccaa}>
                    {c.ccaa} ({formatUnicoInt(c.count)})
                  </option>
                ))}
              </select>
            </div>

            <div className="novedades-filter-field">
              <label
                htmlFor="unico-filter-prov"
                className="novedades-filter-label"
              >
                Provincia
              </label>
              <select
                id="unico-filter-prov"
                className="select-control"
                value={selectedProv}
                onChange={(e) => handleProvChange(e.target.value)}
              >
                <option value="">
                  {selectedCcaa
                    ? `Todas en ${selectedCcaa} (${cascade.provincias.length})`
                    : `Todas las provincias (${cascade.provincias.length})`}
                </option>
                {cascade.provincias.map((p) => (
                  <option key={p.prov} value={p.prov}>
                    {p.prov} ({formatUnicoInt(p.count)})
                  </option>
                ))}
              </select>
            </div>

            <div className="novedades-filter-field">
              <label
                htmlFor="unico-filter-mun"
                className="novedades-filter-label"
              >
                Municipio
              </label>
              <select
                id="unico-filter-mun"
                className="select-control"
                value={
                  selectedMun
                    ? selectedProv
                      ? `${selectedProv}::${selectedMun}`
                      : selectedMun
                    : ''
                }
                onChange={(e) => handleMunChange(e.target.value)}
              >
                <option value="">
                  Todos los municipios ({formatUnicoInt(cascade.municipios.length)})
                </option>
                {cascade.municipios.map((m) => (
                  <option
                    key={`${m.prov}::${m.mun}`}
                    value={`${m.prov}::${m.mun}`}
                  >
                    {m.mun}
                    {!selectedProv ? ` (${m.prov})` : ''} ·{' '}
                    {formatUnicoInt(m.count)}
                  </option>
                ))}
              </select>
            </div>

            <div className="novedades-filter-field">
              <label
                htmlFor="unico-search-input"
                className="novedades-filter-label"
              >
                Búsqueda libre o coordenadas
              </label>
              <div className="search-input-wrap">
                <span className="search-input-icon" aria-hidden="true">
                  <Search size={14} />
                </span>
                <input
                  id="unico-search-input"
                  type="search"
                  className="search-input"
                  placeholder="Municipio, provincia, UTE o 42.83, -2.51…"
                  value={localQuery}
                  onChange={(e) => handleQueryInput(e.target.value)}
                />
                {localQuery.length > 0 && (
                  <button
                    type="button"
                    id="unico-search-clear-btn"
                    className="search-clear-btn"
                    aria-label="Limpiar búsqueda"
                    onClick={() => handleQueryInput('')}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Píldoras resumen de filtros activos */}
          {hasActiveFilters && (
            <div className="unico-active-tags-bar" aria-live="polite">
              <span className="unico-active-tags-label">Selección activa:</span>
              {activeFase !== 'all' && (
                <button
                  type="button"
                  className="unico-active-filter-tag"
                  onClick={() => handleSelectFase('all')}
                >
                  <span>
                    {activeFase === '1' ? 'Fase 1 (2023)' : 'Fase 2 (2024)'}
                  </span>
                  <X size={12} aria-hidden="true" />
                </button>
              )}
              {!allOperatorsActive &&
                activeOperators.map((opKey) => (
                  <button
                    key={opKey}
                    type="button"
                    className="unico-active-filter-tag"
                    onClick={() =>
                      handleToggleOperatorMulti(opKey, activeOperators.length > 1)
                    }
                  >
                    <span
                      className="operator-dot"
                      style={{
                        backgroundColor: UNICO_OPERATOR_META[opKey].color,
                      }}
                      aria-hidden="true"
                    />
                    <span>{UNICO_OPERATOR_META[opKey].shortName}</span>
                    <X size={12} aria-hidden="true" />
                  </button>
                ))}
              {selectedCcaa && (
                <button
                  type="button"
                  className="unico-active-filter-tag"
                  onClick={() => handleCcaaChange('')}
                >
                  <span>CCAA: {selectedCcaa}</span>
                  <X size={12} aria-hidden="true" />
                </button>
              )}
              {selectedProv && (
                <button
                  type="button"
                  className="unico-active-filter-tag"
                  onClick={() => handleProvChange('')}
                >
                  <span>Provincia: {selectedProv}</span>
                  <X size={12} aria-hidden="true" />
                </button>
              )}
              {selectedMun && (
                <button
                  type="button"
                  className="unico-active-filter-tag"
                  onClick={() => handleMunChange('')}
                >
                  <span>Municipio: {selectedMun}</span>
                  <X size={12} aria-hidden="true" />
                </button>
              )}
              {localQuery.trim().length > 0 && (
                <button
                  type="button"
                  className="unico-active-filter-tag"
                  onClick={() => handleQueryInput('')}
                >
                  <span>«{localQuery.trim()}»</span>
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Banda Arquitectónica de Indicadores Estadísticos (Totales y Porcentajes en Vivo) */}
      <section
        className="metrics-strip unico-metrics-strip"
        aria-label="Indicadores estadísticos principales de UNICO 5G"
      >
        <div className="metric-cell">
          <span className="metric-label">Total Antenas Subvencionadas</span>
          <div className="unico-metric-val-row">
            <span className="metric-value">
              {formatUnicoInt(analytics.totalSelected)}
            </span>
            <span className="unico-metric-pct-badge mono">
              {formatUnicoPercent(analytics.totalSelected, dataset.total)}
            </span>
          </div>
          <span className="metric-sub">
            {hasActiveFilters
              ? `de ${formatUnicoInt(dataset.total)} emplazamientos nacionales`
              : 'Suma íntegra de Fase 1 + Fase 2 en España'}
          </span>
        </div>

        <div className="metric-cell">
          <span className="metric-label">Fase 1 · Convocatoria 2023</span>
          <div className="unico-metric-val-row">
            <span className="metric-value">
              {formatUnicoInt(analytics.fase1Selected)}
            </span>
            <span className="unico-metric-pct-badge is-f1 mono">
              {formatUnicoPercent(
                analytics.fase1Selected,
                analytics.totalSelected,
              )}
            </span>
          </div>
          <span className="metric-sub">
            {formatUnicoInt(analytics.uniqueMunicipiosFase1)} municipios
            con adjudicación en Fase 1
          </span>
        </div>

        <div className="metric-cell">
          <span className="metric-label">Fase 2 · Convocatoria 2024</span>
          <div className="unico-metric-val-row">
            <span className="metric-value">
              {formatUnicoInt(analytics.fase2Selected)}
            </span>
            <span className="unico-metric-pct-badge is-f2 mono">
              {formatUnicoPercent(
                analytics.fase2Selected,
                analytics.totalSelected,
              )}
            </span>
          </div>
          <span className="metric-sub">
            {formatUnicoInt(analytics.uniqueMunicipiosFase2)} municipios ·{' '}
            {dataset.fase2ProjectsTotal} proyectos adjudicados
          </span>
        </div>

        <div className="metric-cell">
          <span className="metric-label">Alcance Territorial</span>
          <div className="unico-metric-val-row">
            <span className="metric-value">
              {formatUnicoInt(analytics.uniqueMunicipios)}
            </span>
            <span className="unico-metric-unit">municipios</span>
          </div>
          <span className="metric-sub">
            {analytics.uniqueProvincias}{' '}
            {analytics.uniqueProvincias === 1 ? 'provincia' : 'provincias'} ·{' '}
            {analytics.uniqueComunidades}{' '}
            {analytics.uniqueComunidades === 1
              ? 'comunidad autónoma'
              : 'comunidades autónomas'}
          </span>
        </div>
      </section>

      {/* Mapa Cartográfico Interactivo de Ubicaciones UNICO 5G */}
      <section
        ref={mapSectionRef}
        id="unico-map-section"
        className="section-block unico-map-section"
        aria-labelledby="unico-map-h2"
      >
        <div className="section-block-header">
          <div>
            <h2 id="unico-map-h2" className="section-h2">
              Cartografía Interactiva de Antenas Subvencionadas
            </h2>
            <p className="section-desc">
              Visualización georreferenciada de las{' '}
              <strong>
                {formatUnicoInt(filteredAntennas.length)}
              </strong>{' '}
              estaciones filtradas. Pulsa sobre cualquier clúster para ampliar o
              sobre un punto para consultar su municipio, operador y proyecto.
            </p>
          </div>

          {(manualFocusBounds !== null ||
            selectedCcaa !== '' ||
            selectedProv !== '') && (
            <button
              type="button"
              id="unico-map-reset-view-btn"
              className="btn btn-subtle btn-sm"
              onClick={() => {
                focusSeqRef.current += 1;
                setManualFocusBounds({
                  bounds: {
                    minLon: -9.5,
                    minLat: 35.9,
                    maxLon: 3.4,
                    maxLat: 43.8,
                  },
                  key: 'all',
                });
                setSelectedAntenna(null);
              }}
            >
              <RadioTower size={13} aria-hidden="true" />
              <span>Vista general peninsular</span>
            </button>
          )}
        </div>

        <Unico5gMap
          antenas={filteredAntennas}
          selectedAntenna={selectedAntenna}
          onSelectAntenna={setSelectedAntenna}
          colorMode={colorMode}
          onColorModeChange={handleColorModeChange}
          focusBounds={effectiveMapBounds}
          focusBoundsKey={effectiveMapBoundsKey}
          focusPoint={focusPoint}
          styleId={styleId}
          onStyleChange={setStyleId}
        />
      </section>

      {/* Bloques Analíticos y Gráficas Interactivas (Sin Rankings) */}
      <Unico5gCharts
        dataset={dataset}
        analytics={analytics}
        activeFase={activeFase}
        activeOperators={activeOperators}
        selectedCcaa={selectedCcaa}
        selectedProv={selectedProv}
        colorMode={colorMode}
        onColorModeChange={handleColorModeChange}
        onSelectFase={handleSelectFase}
        onToggleSingleOperator={handleToggleSingleOperator}
        onSelectCcaa={handleSelectCcaaFromChart}
        onSelectProv={handleSelectProvFromChart}
        onFocusTerritoryOnMap={handleFocusTerritoryOnMap}
      />

      {/* Explorador Detallado de Ubicaciones Subvencionadas */}
      <section
        id="unico-table-section"
        className="section-block unico-table-section"
        aria-labelledby="unico-table-h2"
      >
        <div className="section-block-header">
          <div>
            <h2 id="unico-table-h2" className="section-h2">
              Listado de Antenas Subvencionadas y Ubicación
            </h2>
            <p className="section-desc">
              Detalle territorial ordenado alfabéticamente por Comunidad
              Autónoma, Provincia y Municipio.
            </p>
          </div>

          <span className="unico-table-count-pill mono">
            {formatUnicoInt(sortedTableRows.length)} ubicaciones (
            {formatUnicoPercent(sortedTableRows.length, dataset.total)} del
            total)
          </span>
        </div>

        <div className="province-table-wrap">
          <table className="clean-table unico-locations-table">
            <thead>
              <tr>
                <th>
                  <button
                    type="button"
                    className="unico-th-sort-btn"
                    onClick={() => handleToggleTableSort('fase')}
                  >
                    <span>Fase</span>
                    <ArrowUpDown size={12} aria-hidden="true" />
                  </button>
                </th>
                <th>
                  <button
                    type="button"
                    className="unico-th-sort-btn"
                    onClick={() => handleToggleTableSort('op')}
                  >
                    <span>Operador</span>
                    <ArrowUpDown size={12} aria-hidden="true" />
                  </button>
                </th>
                <th>
                  <button
                    type="button"
                    className="unico-th-sort-btn"
                    onClick={() => handleToggleTableSort('mun')}
                  >
                    <span>Municipio</span>
                    <ArrowUpDown size={12} aria-hidden="true" />
                  </button>
                </th>
                <th>
                  <button
                    type="button"
                    className="unico-th-sort-btn"
                    onClick={() => handleToggleTableSort('prov')}
                  >
                    <span>Provincia</span>
                    <ArrowUpDown size={12} aria-hidden="true" />
                  </button>
                </th>
                <th>
                  <button
                    type="button"
                    className="unico-th-sort-btn"
                    onClick={() => handleToggleTableSort('ccaa')}
                  >
                    <span>Comunidad Autónoma</span>
                    <ArrowUpDown size={12} aria-hidden="true" />
                  </button>
                </th>
                <th>Coordenadas WGS84</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {pagedRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="unico-empty-cell">
                    <div className="unico-empty-state">
                      <p>
                        No hay antenas subvencionadas que coincidan con la
                        combinación actual de filtros.
                      </p>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={handleClearFilters}
                      >
                        <RotateCcw size={13} aria-hidden="true" />
                        <span>Mostrar todas las antenas</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                pagedRows.map((row) => {
                  const opMeta = UNICO_OPERATOR_META[row.op];
                  const faseMeta = UNICO_FASE_META[row.fase];
                  const isOrangeUte =
                    row.op === 'orange' &&
                    row.empresa.toUpperCase().includes('UTE');
                  const isSelectedRow = selectedAntenna?.id === row.id;

                  return (
                    <tr
                      key={row.id}
                      className={isSelectedRow ? 'is-selected-row' : undefined}
                    >
                      <td>
                        <span
                          className={`unico-fase-badge is-f${row.fase} mono`}
                          style={{
                            backgroundColor: faseMeta.softBg,
                            color: faseMeta.color,
                          }}
                        >
                          {faseMeta.shortLabel} · {faseMeta.convocatoria}
                        </span>
                      </td>
                      <td>
                        <div className="unico-table-op-cell">
                          <span
                            className="operator-badge"
                            style={{
                              backgroundColor: opMeta.softBg,
                              color: opMeta.color,
                            }}
                          >
                            <span
                              className="operator-dot"
                              style={{ backgroundColor: opMeta.color }}
                              aria-hidden="true"
                            />
                            <span>{opMeta.shortName}</span>
                          </span>
                          {isOrangeUte && (
                            <span
                              className="unico-ute-tag mono"
                              title={row.empresa}
                            >
                              UTE Orange
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="unico-td-mun">{row.mun}</td>
                      <td className="unico-td-prov">{row.prov}</td>
                      <td className="unico-td-ccaa">{row.ccaa}</td>
                      <td className="mono unico-td-coords">
                        {row.lat.toFixed(5)}, {row.lon.toFixed(5)}
                      </td>
                      <td>
                        <div className="unico-row-actions">
                          <button
                            type="button"
                            className="btn btn-subtle btn-sm"
                            title="Centrar esta antena en el mapa UNICO 5G superior"
                            onClick={() => handleFocusAntennaOnMap(row)}
                          >
                            <Crosshair size={12} aria-hidden="true" />
                            <span>Mapa</span>
                          </button>

                          <Link
                            to="/"
                            search={{ lat: row.lat, lon: row.lon }}
                            className="btn btn-subtle btn-sm"
                            title="Abrir ubicación en el mapa general de frecuencias MINETUR"
                          >
                            <MapPin size={12} aria-hidden="true" />
                            <span>RadioMapa</span>
                          </Link>

                          <a
                            href={`https://www.google.com/maps?q=&layer=c&cbll=${row.lat},${row.lon}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="icon-btn unico-sv-link"
                            title="Ver ubicación en Google Street View"
                            aria-label={`Ver ${row.mun} en Google Street View`}
                          >
                            <ExternalLink size={13} aria-hidden="true" />
                          </a>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Paginación */}
        {sortedTableRows.length > 0 && (
          <div className="novedades-pagination-bar">
            <div className="novedades-pagination-left">
              <div className="novedades-page-size-group">
                <label
                  htmlFor="unico-page-size-select"
                  className="novedades-pagination-label"
                >
                  Filas por página
                </label>
                <select
                  id="unico-page-size-select"
                  className="select-control novedades-page-size-select"
                  value={pageSize}
                  onChange={(e) =>
                    commitSearch({ pageSize: Number(e.target.value), page: 1 })
                  }
                >
                  {UNICO_PAGE_SIZE_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>

              <span className="novedades-pagination-info">
                Mostrando{' '}
                <strong className="mono">
                  {formatUnicoInt((pageStartIdx + 1))}–
                  {formatUnicoInt(Math.min(
                    pageStartIdx + pageSize,
                    sortedTableRows.length,
                  ))}
                </strong>{' '}
                de{' '}
                <strong className="mono">
                  {formatUnicoInt(sortedTableRows.length)}
                </strong>
              </span>
            </div>

            <div className="novedades-pagination-right">
              <div className="novedades-page-nav" role="navigation" aria-label="Paginación de tabla UNICO 5G">
                <button
                  type="button"
                  className="novedades-page-btn novedades-page-step-btn"
                  disabled={currentPage <= 1}
                  aria-label="Primera página"
                  onClick={() => commitSearch({ page: 1 }, false)}
                >
                  <ChevronsLeft size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="novedades-page-btn novedades-page-step-btn"
                  disabled={currentPage <= 1}
                  aria-label="Página anterior"
                  onClick={() => commitSearch({ page: currentPage - 1 }, false)}
                >
                  <ChevronLeft size={14} aria-hidden="true" />
                </button>

                <div className="novedades-page-numbers">
                  {pageTokens.map((tok) =>
                    typeof tok === 'number' ? (
                      <button
                        key={tok}
                        type="button"
                        className={`novedades-page-btn mono${
                          tok === currentPage ? ' is-active' : ''
                        }`}
                        aria-current={tok === currentPage ? 'page' : undefined}
                        onClick={() => commitSearch({ page: tok }, false)}
                      >
                        {tok}
                      </button>
                    ) : (
                      <span key={tok} className="novedades-page-ellipsis">
                        …
                      </span>
                    ),
                  )}
                </div>

                <button
                  type="button"
                  className="novedades-page-btn novedades-page-step-btn"
                  disabled={currentPage >= totalPages}
                  aria-label="Página siguiente"
                  onClick={() => commitSearch({ page: currentPage + 1 }, false)}
                >
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="novedades-page-btn novedades-page-step-btn"
                  disabled={currentPage >= totalPages}
                  aria-label="Última página"
                  onClick={() => commitSearch({ page: totalPages }, false)}
                >
                  <ChevronsRight size={14} aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
