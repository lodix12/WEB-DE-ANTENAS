import { useEffect, useMemo, useState } from 'react';
import { useSearch } from '@tanstack/react-router';
import {
  UNICO_COMUNIDAD_LIST,
  UNICO_PROVINCE_LABELS,
  computeUnicoSimpleSummary,
  formatUnicoInt,
  formatUnicoPercent,
  useUnico5gData,
  validateUnico5gSearch,
} from '../hooks/useUnico5gData';
import {
  UNICO_DECLARED_BAND_TABS,
  type UnicoDeclaredBandFilter,
  type UnicoFaseFilter,
  type UnicoOperatorCountStat,
  type UnicoTerritoryTab,
} from '../types/unico5g';
import '../styles/unico5g.css';

const VALID_PROV_SET = new Set<string>(
  UNICO_PROVINCE_LABELS.map((item) => item.prov),
);
const VALID_CCAA_SET = new Set<string>(UNICO_COMUNIDAD_LIST);

const PIE_CX = 110;
const PIE_CY = 110;
const PIE_RADIUS = 96;

interface PieSlicePath {
  key: string;
  color: string;
  d: string;
}

function parseProvsParam(raw: string | undefined): Set<string> {
  const set = new Set<string>();
  if (!raw) return set;
  const parts = raw.split(',');
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i].trim();
    if (VALID_PROV_SET.has(token)) {
      set.add(token);
    }
  }
  return set;
}

function parseCcaasParam(raw: string | undefined): Set<string> {
  const set = new Set<string>();
  if (!raw) return set;
  const parts = raw.split('|');
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i].trim();
    if (VALID_CCAA_SET.has(token)) {
      set.add(token);
    }
  }
  return set;
}

function buildPieSlicePaths(
  nonZeroOps: readonly UnicoOperatorCountStat[],
  totalAntennas: number,
): PieSlicePath[] {
  if (nonZeroOps.length < 2 || totalAntennas <= 0) {
    return [];
  }

  const paths: PieSlicePath[] = [];
  let startAngle = -Math.PI / 2;

  for (let i = 0; i < nonZeroOps.length; i++) {
    const op = nonZeroOps[i];
    const sliceAngle = (op.total / totalAntennas) * Math.PI * 2;
    const endAngle = startAngle + sliceAngle;

    const x1 = PIE_CX + PIE_RADIUS * Math.cos(startAngle);
    const y1 = PIE_CY + PIE_RADIUS * Math.sin(startAngle);
    const x2 = PIE_CX + PIE_RADIUS * Math.cos(endAngle);
    const y2 = PIE_CY + PIE_RADIUS * Math.sin(endAngle);
    const largeArc = sliceAngle > Math.PI ? 1 : 0;

    const d = `M ${PIE_CX} ${PIE_CY} L ${x1.toFixed(4)} ${y1.toFixed(4)} A ${PIE_RADIUS} ${PIE_RADIUS} 0 ${largeArc} 1 ${x2.toFixed(4)} ${y2.toFixed(4)} Z`;
    paths.push({
      key: op.key,
      color: op.meta.color,
      d,
    });

    startAngle = endAngle;
  }

  return paths;
}

export function Unico5gView() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;

  const [selectedProvs, setSelectedProvs] = useState<Set<string>>(() =>
    parseProvsParam(validateUnico5gSearch(rawSearch).provs),
  );
  const [selectedCcaas, setSelectedCcaas] = useState<Set<string>>(() =>
    parseCcaasParam(validateUnico5gSearch(rawSearch).ccaas),
  );
  const [activeTab, setActiveTab] = useState<UnicoTerritoryTab>(() => {
    const initial = validateUnico5gSearch(rawSearch);
    if (initial.tab) return initial.tab;
    const initCcaas = parseCcaasParam(initial.ccaas);
    const initProvs = parseProvsParam(initial.provs);
    return initCcaas.size > 0 && initProvs.size === 0
      ? 'comunidad'
      : 'provincia';
  });
  const [activeFase, setActiveFase] = useState<UnicoFaseFilter>(
    () => validateUnico5gSearch(rawSearch).fase ?? 'all',
  );
  const [activeBand, setActiveBand] = useState<UnicoDeclaredBandFilter>(
    () => validateUnico5gSearch(rawSearch).band ?? 'all',
  );

  const {
    dataset,
    declaredMasks,
    isDeclaredReady,
    isAntenasLoading,
    isLoading,
    isError,
    error,
  } = useUnico5gData();

  useEffect(() => {
    document.title =
      'UNICO 5G · Antenas Subvencionadas y Declaradas · Redes Moviles España';
  }, []);

  const summary = useMemo(() => {
    if (!dataset) return null;
    return computeUnicoSimpleSummary(dataset.antenas, declaredMasks, {
      fase: activeFase,
      selectedProvinces: selectedProvs,
      selectedComunidades: selectedCcaas,
      bandFilter: activeBand,
    });
  }, [
    dataset,
    declaredMasks,
    activeFase,
    selectedProvs,
    selectedCcaas,
    activeBand,
  ]);

  const nonZeroOps = useMemo(
    () => (summary ? summary.byOperator.filter((op) => op.total > 0) : []),
    [summary],
  );

  const piePaths = useMemo(
    () =>
      summary ? buildPieSlicePaths(nonZeroOps, summary.totalAntennas) : [],
    [summary, nonZeroOps],
  );

  function handleSelectTab(nextTab: UnicoTerritoryTab) {
    if (nextTab === activeTab) return;
    setActiveTab(nextTab);
    if (nextTab === 'comunidad') {
      setSelectedProvs(new Set());
    } else {
      setSelectedCcaas(new Set());
    }
  }

  function handleSelectFase(nextFase: UnicoFaseFilter) {
    setActiveFase(nextFase);
  }

  function handleSelectBand(nextBand: UnicoDeclaredBandFilter) {
    setActiveBand(nextBand);
  }

  function handleSelectAllProvs() {
    setSelectedProvs((prev) => (prev.size === 0 ? prev : new Set()));
  }

  function toggleProv(prov: string) {
    setSelectedProvs((prev) => {
      const next = new Set(prev);
      if (next.has(prov)) {
        next.delete(prov);
      } else {
        next.add(prov);
      }
      return next;
    });
  }

  function handleSelectAllCcaas() {
    setSelectedCcaas((prev) => (prev.size === 0 ? prev : new Set()));
  }

  function toggleCcaa(ccaa: string) {
    setSelectedCcaas((prev) => {
      const next = new Set(prev);
      if (next.has(ccaa)) {
        next.delete(ccaa);
      } else {
        next.add(ccaa);
      }
      return next;
    });
  }

  if (isLoading && !dataset) {
    return (
      <main className="page-container unico-simple-page">
        <h1 className="sr-only">
          UNICO 5G · Antenas Subvencionadas y Declaradas
        </h1>
        <div className="unico-card state-center-box">
          <div className="spinner-ring" aria-hidden="true" />
          <p>Cargando antenas de UNICO 5G…</p>
        </div>
      </main>
    );
  }

  if (isError || !dataset || !summary) {
    return (
      <main className="page-container unico-simple-page">
        <h1 className="sr-only">
          UNICO 5G · Antenas Subvencionadas y Declaradas
        </h1>
        <div className="unico-card state-center-box">
          <p className="unico-error-msg">
            {error instanceof Error
              ? error.message
              : 'No se pudieron cargar los datos de UNICO 5G.'}
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="page-container unico-simple-page">
      <h1 className="sr-only">
        UNICO 5G · Antenas Subvencionadas y Declaradas
      </h1>

      {/* Tarjeta 1: Filtro Territorial (Por Provincia / Por Comunidad) y Fase */}
      <section
        id="unico-filter-card"
        className="unico-card"
        aria-label="Filtros territoriales y por fase"
      >
        <div className="unico-top-tabs-row">
          <div
            className="unico-underline-tabs"
            role="tablist"
            aria-label="Modo de filtro territorial"
          >
            <button
              type="button"
              role="tab"
              id="unico-tab-provincia"
              className={`unico-underline-tab${
                activeTab === 'provincia' ? ' is-active' : ''
              }`}
              aria-selected={activeTab === 'provincia'}
              onClick={() => handleSelectTab('provincia')}
            >
              Por Provincia
            </button>
            <button
              type="button"
              role="tab"
              id="unico-tab-comunidad"
              className={`unico-underline-tab${
                activeTab === 'comunidad' ? ' is-active' : ''
              }`}
              aria-selected={activeTab === 'comunidad'}
              onClick={() => handleSelectTab('comunidad')}
            >
              Por Comunidad
            </button>
          </div>

          <div
            className="unico-fase-tabs"
            role="group"
            aria-label="Filtrar por fase"
          >
            <button
              type="button"
              id="unico-fase-all"
              className={`unico-fase-tab${
                activeFase === 'all' ? ' is-active' : ''
              }`}
              aria-pressed={activeFase === 'all'}
              onClick={() => handleSelectFase('all')}
            >
              Todas
            </button>
            <button
              type="button"
              id="unico-fase-1"
              className={`unico-fase-tab${
                activeFase === '1' ? ' is-active' : ''
              }`}
              aria-pressed={activeFase === '1'}
              onClick={() => handleSelectFase('1')}
            >
              Fase 1
            </button>
            <button
              type="button"
              id="unico-fase-2"
              className={`unico-fase-tab${
                activeFase === '2' ? ' is-active' : ''
              }`}
              aria-pressed={activeFase === '2'}
              onClick={() => handleSelectFase('2')}
            >
              Fase 2
            </button>
          </div>
        </div>

        <div className="unico-filter-card-body">
          {activeTab === 'provincia' ? (
            <>
              <div className="unico-master-check-row">
                <label className="unico-check-label is-master">
                  <input
                    type="checkbox"
                    id="unico-check-all-provs"
                    checked={selectedProvs.size === 0}
                    onChange={handleSelectAllProvs}
                  />
                  <span>Todas las provincias</span>
                </label>
              </div>

              <div className="unico-checkbox-grid">
                {UNICO_PROVINCE_LABELS.map((item) => (
                  <label key={item.prov} className="unico-check-label">
                    <input
                      type="checkbox"
                      checked={selectedProvs.has(item.prov)}
                      onChange={() => toggleProv(item.prov)}
                    />
                    <span>{item.label}</span>
                  </label>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="unico-master-check-row">
                <label className="unico-check-label is-master">
                  <input
                    type="checkbox"
                    id="unico-check-all-ccaas"
                    checked={selectedCcaas.size === 0}
                    onChange={handleSelectAllCcaas}
                  />
                  <span>Todas las comunidades</span>
                </label>
              </div>

              <div className="unico-checkbox-grid is-comunidades">
                {UNICO_COMUNIDAD_LIST.map((ccaa) => (
                  <label key={ccaa} className="unico-check-label">
                    <input
                      type="checkbox"
                      checked={selectedCcaas.has(ccaa)}
                      onChange={() => toggleCcaa(ccaa)}
                    />
                    <span>{ccaa}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
      </section>

      {/* Tarjeta 2: Gráfico Circular Sólido y Totales por Operadora */}
      <section
        id="unico-pie-card"
        className="unico-card unico-pie-card"
        aria-labelledby="unico-pie-heading"
      >
        <div className="unico-pie-layout">
          <div className="unico-pie-wrap">
            <svg
              viewBox="0 0 220 220"
              className="unico-pie-svg"
              role="img"
              aria-label={`Distribución de ${formatUnicoInt(summary.totalAntennas)} antenas por operadora`}
            >
              {nonZeroOps.length === 0 ? (
                <circle
                  cx={PIE_CX}
                  cy={PIE_CY}
                  r={PIE_RADIUS}
                  fill="var(--bg-surface-subtle)"
                />
              ) : nonZeroOps.length === 1 ? (
                <circle
                  cx={PIE_CX}
                  cy={PIE_CY}
                  r={PIE_RADIUS}
                  fill={nonZeroOps[0].meta.color}
                />
              ) : (
                piePaths.map((slice) => (
                  <path
                    key={slice.key}
                    d={slice.d}
                    fill={slice.color}
                    stroke="var(--bg-surface)"
                    strokeWidth="2.2"
                    strokeLinejoin="round"
                  />
                ))
              )}
            </svg>
          </div>

          <div className="unico-pie-legend-col">
            <h2 id="unico-pie-heading" className="unico-card-title">
              Antenas por operadora (
              <span className="unico-count-pill">
                {formatUnicoInt(summary.totalAntennas)}
              </span>{' '}
              total)
            </h2>

            <div className="unico-pie-legend-list">
              {summary.byOperator.map((item) => (
                <div key={item.key} className="unico-pie-legend-item">
                  <span
                    className="unico-legend-swatch"
                    style={{ backgroundColor: item.meta.color }}
                    aria-hidden="true"
                  />
                  <div className="unico-legend-text">
                    <span className="unico-legend-op-name">
                      {item.meta.name}
                    </span>
                    <span className="unico-legend-op-sub">
                      <span className="unico-count-pill">
                        {formatUnicoInt(item.total)}
                      </span>{' '}
                      <span className="unico-pct-green">
                        ({formatUnicoPercent(item.total, summary.totalAntennas)})
                      </span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Tarjeta 3: Declaradas por Operadora y Filtro de Banda 5G */}
      <section
        id="unico-declared-card"
        className="unico-card unico-declared-card"
        aria-labelledby="unico-declared-heading"
      >
        <h2
          id="unico-declared-heading"
          className="unico-card-title unico-declared-heading"
        >
          {!isDeclaredReady && isAntenasLoading ? (
            'DECLARADAS (cruzando censo real ≤ 1.200 m…)'
          ) : (
            <>
              <span>DECLARADAS</span>{' '}
              <span className="unico-count-pill">
                {formatUnicoInt(summary.totalDeclared)}/
                {formatUnicoInt(summary.totalAntennas)}
              </span>{' '}
              <span className="unico-pct-green">
                (
                {formatUnicoPercent(
                  summary.totalDeclared,
                  summary.totalAntennas,
                )}
                )
              </span>
            </>
          )}
        </h2>

        <div
          className="unico-underline-tabs unico-band-tabs"
          role="tablist"
          aria-label="Filtrar antenas declaradas por banda 5G"
        >
          {UNICO_DECLARED_BAND_TABS.map((tab) => {
            const isActive = activeBand === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`unico-band-tab-${tab.id}`}
                className={`unico-underline-tab${isActive ? ' is-active' : ''}`}
                aria-selected={isActive}
                onClick={() => handleSelectBand(tab.id)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="unico-declared-bars-list">
          {summary.byOperator.map((item) => (
            <div key={item.key} className="unico-declared-row">
              <div className="unico-declared-row-head">
                <span className="unico-declared-op-name">{item.meta.name}</span>
                <span className="unico-declared-op-nums">
                  <span className="unico-count-pill">
                    {formatUnicoInt(item.declared)}/{formatUnicoInt(item.total)}
                  </span>{' '}
                  <span className="unico-pct-green">
                    ({formatUnicoPercent(item.declared, item.total)})
                  </span>
                </span>
              </div>

              <div className="unico-declared-bar-track">
                <div
                  className="unico-declared-bar-fill"
                  style={{
                    width: `${Math.min(100, Math.max(0, item.pctDeclared))}%`,
                    backgroundColor: item.meta.color,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
