import { useMemo, useState } from 'react';
import { Check, ChevronRight, MapPin } from 'lucide-react';
import {
  UNICO_FASE_META,
  UNICO_OPERATOR_META,
  UNICO_OPERATOR_ORDER,
  type UnicoBounds,
  type UnicoColorMode,
  type UnicoDataset,
  type UnicoFaseFilter,
  type UnicoOperatorKey,
} from '../../types/unico5g';
import {
  formatUnicoInt,
  formatUnicoPercent,
  type UnicoDerivedAnalytics,
} from '../../hooks/useUnico5gData';

export interface Unico5gChartsProps {
  dataset: UnicoDataset;
  analytics: UnicoDerivedAnalytics;
  activeFase: UnicoFaseFilter;
  activeOperators: readonly UnicoOperatorKey[];
  selectedCcaa: string;
  selectedProv: string;
  colorMode: UnicoColorMode;
  onColorModeChange: (mode: UnicoColorMode) => void;
  onSelectFase: (fase: UnicoFaseFilter) => void;
  onToggleSingleOperator: (op: UnicoOperatorKey) => void;
  onSelectCcaa: (ccaa: string) => void;
  onSelectProv: (ccaa: string, prov: string) => void;
  onFocusTerritoryOnMap: (bounds: UnicoBounds, label: string) => void;
}

const DONUT_RADIUS = 86;
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;

const BUTTERFLY_LEFT_ORIGIN = 304;
const BUTTERFLY_RIGHT_ORIGIN = 456;
const BUTTERFLY_MAX_WING_PX = 208;
const BUTTERFLY_TICKS = [25, 50, 75, 100] as const;

function sanitizeDomId(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .toLowerCase();
}

function formatSignedPercentagePoints(deltaPp: number): string {
  const absFormatted = Math.abs(deltaPp).toLocaleString('es-ES', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  if (Math.abs(deltaPp) < 0.05) {
    return '0,0 pp';
  }
  return `${deltaPp > 0 ? '+' : '−'}${absFormatted} pp`;
}

export function Unico5gCharts({
  dataset,
  analytics,
  activeFase,
  activeOperators,
  selectedCcaa,
  selectedProv,
  colorMode,
  onColorModeChange,
  onSelectFase,
  onToggleSingleOperator,
  onSelectCcaa,
  onSelectProv,
  onFocusTerritoryOnMap,
}: Unico5gChartsProps) {
  const [hoveredOp, setHoveredOp] = useState<UnicoOperatorKey | null>(null);
  const [manualExpanded, setManualExpanded] = useState<Record<string, boolean>>(
    {},
  );

  const activeOpsSet = useMemo(
    () => new Set<UnicoOperatorKey>(activeOperators),
    [activeOperators],
  );

  const isFilteredScope =
    analytics.totalSelected !== dataset.total ||
    activeFase !== 'all' ||
    activeOperators.length < UNICO_OPERATOR_ORDER.length ||
    Boolean(selectedCcaa) ||
    Boolean(selectedProv);

  const hoveredOperatorStat = useMemo(
    () =>
      hoveredOp
        ? (analytics.operatorStats.find((item) => item.key === hoveredOp) ??
          null)
        : null,
    [analytics.operatorStats, hoveredOp],
  );

  const donutArcs = useMemo(() => {
    if (analytics.totalSelected <= 0) return [];
    const nonZeroOps = analytics.operatorStats.filter((item) => item.total > 0);
    const gapPx = nonZeroOps.length > 1 ? 3.5 : 0;
    const arcs: Array<{
      op: (typeof nonZeroOps)[number];
      dashArray: string;
      dashOffset: number;
    }> = [];
    let offsetAcc = 0;

    for (let i = 0; i < nonZeroOps.length; i++) {
      const op = nonZeroOps[i];
      const fraction = op.total / analytics.totalSelected;
      const rawLen = fraction * DONUT_CIRCUMFERENCE;
      const visibleLen =
        nonZeroOps.length === 1
          ? DONUT_CIRCUMFERENCE
          : Math.max(Math.min(rawLen, 2.2), rawLen - gapPx);
      const dashArray = `${visibleLen} ${Math.max(
        0,
        DONUT_CIRCUMFERENCE - visibleLen,
      )}`;
      arcs.push({
        op,
        dashArray,
        dashOffset: -offsetAcc,
      });
      offsetAcc += rawLen;
    }

    return arcs;
  }, [analytics.operatorStats, analytics.totalSelected]);

  const phaseOperatorShares = useMemo(
    () =>
      analytics.operatorStats.map((op) => {
        const pctInFase1 =
          analytics.fase1Selected > 0
            ? (op.fase1 / analytics.fase1Selected) * 100
            : 0;
        const pctInFase2 =
          analytics.fase2Selected > 0
            ? (op.fase2 / analytics.fase2Selected) * 100
            : 0;
        return {
          op,
          pctInFase1,
          pctInFase2,
          deltaPp: pctInFase2 - pctInFase1,
        };
      }),
    [analytics.fase1Selected, analytics.fase2Selected, analytics.operatorStats],
  );

  const { maxCcaaTotal, maxProvTotal } = useMemo(() => {
    let maxC = 1;
    let maxP = 1;
    for (let i = 0; i < analytics.comunidadesAlpha.length; i++) {
      const c = analytics.comunidadesAlpha[i];
      if (c.total > maxC) maxC = c.total;
      for (let j = 0; j < c.provinces.length; j++) {
        const p = c.provinces[j];
        if (p.total > maxP) maxP = p.total;
      }
    }
    return { maxCcaaTotal: maxC, maxProvTotal: maxP };
  }, [analytics.comunidadesAlpha]);

  const isCcaaAutoExpanded = (
    ccaa: string,
    provinces: ReadonlyArray<{ prov: string }>,
  ): boolean =>
    selectedCcaa === ccaa ||
    (Boolean(selectedProv) && provinces.some((p) => p.prov === selectedProv));

  const isCcaaExpanded = (
    ccaa: string,
    provinces: ReadonlyArray<{ prov: string }>,
  ): boolean => manualExpanded[ccaa] ?? isCcaaAutoExpanded(ccaa, provinces);

  const allCcaasExpanded =
    analytics.comunidadesAlpha.length > 0 &&
    analytics.comunidadesAlpha.every((item) =>
      isCcaaExpanded(item.ccaa, item.provinces),
    );

  function handleToggleCcaaExpand(
    ccaa: string,
    provinces: ReadonlyArray<{ prov: string }>,
  ): void {
    const current = isCcaaExpanded(ccaa, provinces);
    setManualExpanded((prev) => ({
      ...prev,
      [ccaa]: !current,
    }));
  }

  function handleToggleExpandAll(): void {
    const targetState = !allCcaasExpanded;
    const next: Record<string, boolean> = {};
    for (let i = 0; i < analytics.comunidadesAlpha.length; i++) {
      next[analytics.comunidadesAlpha[i].ccaa] = targetState;
    }
    setManualExpanded(next);
  }

  function handleFilterCcaaClick(ccaa: string): void {
    const isCurrentlySelected = selectedCcaa === ccaa;
    if (!isCurrentlySelected) {
      setManualExpanded((prev) => ({ ...prev, [ccaa]: true }));
      onSelectCcaa(ccaa);
    } else {
      onSelectCcaa('');
    }
  }

  function handleFilterProvClick(ccaa: string, prov: string): void {
    const isCurrentlySelected = selectedProv === prov;
    onSelectProv(ccaa, isCurrentlySelected ? '' : prov);
  }

  const movistarPhaseShare = phaseOperatorShares.find(
    (s) => s.op.key === 'movistar',
  );
  const orangePhaseShare = phaseOperatorShares.find(
    (s) => s.op.key === 'orange',
  );

  return (
    <div className="unico-charts-stack">
      {/* ====================================================================
          BLOQUE 1: Distribución por Operador Subvencionado
         ==================================================================== */}
      <section
        id="unico-operators-section"
        className="section-block unico-section-block"
        aria-labelledby="unico-operators-h2"
      >
        <div className="section-block-header">
          <div>
            <h2 id="unico-operators-h2" className="section-h2">
              Distribución por Operador Subvencionado
            </h2>
            <p className="section-desc">
              Cuota de antenas financiadas en orden fijo de adjudicatarios
              (Movistar, Orange —unificando proyectos individuales y en UTE—,
              Vodafone y Avatel).
            </p>
          </div>

          <span className="band-tag unico-scope-badge">
            {formatUnicoInt(analytics.totalSelected)} /{' '}
            {formatUnicoInt(dataset.total)} antenas (
            {formatUnicoPercent(analytics.totalSelected, dataset.total)})
          </span>
        </div>

        <div className="section-block-body">
          <div className="unico-operator-analytics-grid">
            {/* Columna izquierda: Anillo SVG interactivo + barra global Fase 1 vs Fase 2 */}
            <div className="unico-donut-card">
              <div
                className="unico-donut-visual"
                style={{
                  position: 'relative',
                  width: '100%',
                  maxWidth: 240,
                  margin: '0 auto',
                }}
              >
                <svg
                  viewBox="0 0 240 240"
                  className="unico-donut-svg"
                  role="img"
                  aria-label="Distribución proporcional de antenas subvencionadas por operador"
                >
                  <circle
                    cx="120"
                    cy="120"
                    r={DONUT_RADIUS + 18}
                    fill="none"
                    stroke="var(--border-subtle)"
                    strokeWidth="1"
                  />
                  <circle
                    cx="120"
                    cy="120"
                    r={DONUT_RADIUS}
                    fill="none"
                    stroke="var(--bg-surface-subtle)"
                    strokeWidth="26"
                  />
                  <circle
                    cx="120"
                    cy="120"
                    r={DONUT_RADIUS - 18}
                    fill="none"
                    stroke="var(--border-subtle)"
                    strokeWidth="1"
                  />

                  <g transform="rotate(-90 120 120)">
                    {donutArcs.map(({ op, dashArray, dashOffset }) => {
                      const isHovered = hoveredOp === op.key;
                      const isIsolated =
                        activeOperators.length === 1 &&
                        activeOperators[0] === op.key;
                      const dimmed =
                        hoveredOp !== null && hoveredOp !== op.key;

                      return (
                        <circle
                          key={op.key}
                          cx="120"
                          cy="120"
                          r={DONUT_RADIUS}
                          fill="none"
                          stroke={op.meta.color}
                          strokeWidth={isHovered || isIsolated ? 31 : 25}
                          strokeDasharray={dashArray}
                          strokeDashoffset={dashOffset}
                          opacity={dimmed ? 0.34 : 1}
                          className="unico-donut-arc"
                          role="button"
                          tabIndex={0}
                          aria-label={`${op.meta.name}: ${formatUnicoInt(op.total)} antenas (${formatUnicoPercent(op.total, analytics.totalSelected)}). Clic para filtrar operador.`}
                          style={{
                            cursor: 'pointer',
                            transition:
                              'stroke-width 0.18s ease, opacity 0.18s ease',
                          }}
                          onMouseEnter={() => setHoveredOp(op.key)}
                          onMouseLeave={() => setHoveredOp(null)}
                          onFocus={() => setHoveredOp(op.key)}
                          onBlur={() => setHoveredOp(null)}
                          onClick={() => onToggleSingleOperator(op.key)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onToggleSingleOperator(op.key);
                            }
                          }}
                        >
                          <title>
                            {`${op.meta.name}: ${formatUnicoInt(op.total)} antenas (${formatUnicoPercent(op.total, analytics.totalSelected)})`}
                          </title>
                        </circle>
                      );
                    })}
                  </g>
                </svg>

                <div
                  className="unico-donut-center"
                  aria-live="polite"
                  style={{
                    position: 'absolute',
                    inset: '22%',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    textAlign: 'center',
                    pointerEvents: 'none',
                  }}
                >
                  {hoveredOperatorStat ? (
                    <>
                      <span
                        className="unico-donut-center-op"
                        style={{ color: hoveredOperatorStat.meta.color }}
                      >
                        {hoveredOperatorStat.meta.shortName}
                      </span>
                      <strong className="unico-donut-center-value mono">
                        {formatUnicoInt(hoveredOperatorStat.total)}
                      </strong>
                      <span className="unico-donut-center-pct mono">
                        {formatUnicoPercent(
                          hoveredOperatorStat.total,
                          analytics.totalSelected,
                        )}
                      </span>
                    </>
                  ) : (
                    <>
                      <strong className="unico-donut-center-value mono">
                        {formatUnicoInt(analytics.totalSelected)}
                      </strong>
                      <span className="unico-donut-center-label">Antenas</span>
                      <span className="unico-donut-center-sub mono">
                        {formatUnicoPercent(
                          analytics.totalSelected,
                          dataset.total,
                        )}{' '}
                        nacional
                      </span>
                    </>
                  )}
                </div>
              </div>

              <p className="unico-donut-hint">
                Pasa el cursor o pulsa un arco para aislar un operador
              </p>

              {/* Barra compacta global Fase 1 vs Fase 2 */}
              <div className="unico-donut-phase-split">
                <div className="unico-donut-phase-header">
                  <span className="unico-donut-phase-title">
                    Reparto por convocatoria en selección
                  </span>
                </div>

                <div
                  className="stacked-bar unico-global-phase-bar"
                  aria-label="Proporción entre Fase 1 (2023) y Fase 2 (2024)"
                >
                  {analytics.fase1Selected > 0 && (
                    <div
                      className="stacked-bar-seg"
                      style={{
                        width: `${analytics.pctFase1InSelection}%`,
                        backgroundColor: UNICO_FASE_META[1].color,
                      }}
                      title={`Fase 1 (2023): ${formatUnicoInt(analytics.fase1Selected)} antenas (${formatUnicoPercent(analytics.fase1Selected, analytics.totalSelected)})`}
                    />
                  )}
                  {analytics.fase2Selected > 0 && (
                    <div
                      className="stacked-bar-seg"
                      style={{
                        width: `${analytics.pctFase2InSelection}%`,
                        backgroundColor: UNICO_FASE_META[2].color,
                      }}
                      title={`Fase 2 (2024): ${formatUnicoInt(analytics.fase2Selected)} antenas (${formatUnicoPercent(analytics.fase2Selected, analytics.totalSelected)})`}
                    />
                  )}
                </div>

                <div className="unico-donut-phase-stats">
                  <div className="unico-donut-phase-item">
                    <span className="unico-phase-dot-label">
                      <span
                        className="operator-dot"
                        style={{ backgroundColor: UNICO_FASE_META[1].color }}
                        aria-hidden="true"
                      />
                      <span>Fase 1 · 2023</span>
                    </span>
                    <span className="mono unico-donut-phase-nums">
                      <strong>
                        {formatUnicoInt(analytics.fase1Selected)}
                      </strong>{' '}
                      ·{' '}
                      {formatUnicoPercent(
                        analytics.fase1Selected,
                        analytics.totalSelected,
                      )}
                    </span>
                  </div>

                  <div className="unico-donut-phase-item">
                    <span className="unico-phase-dot-label">
                      <span
                        className="operator-dot"
                        style={{ backgroundColor: UNICO_FASE_META[2].color }}
                        aria-hidden="true"
                      />
                      <span>Fase 2 · 2024</span>
                    </span>
                    <span className="mono unico-donut-phase-nums">
                      <strong>
                        {formatUnicoInt(analytics.fase2Selected)}
                      </strong>{' '}
                      ·{' '}
                      {formatUnicoPercent(
                        analytics.fase2Selected,
                        analytics.totalSelected,
                      )}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Columna derecha: 4 Tarjetas Canónicas de Operador (orden UNICO_OPERATOR_ORDER) */}
            <div className="unico-operator-cards-grid">
              {analytics.operatorStats.map((op) => {
                const isIncluded = activeOpsSet.has(op.key);
                const isIsolated =
                  activeOperators.length === 1 &&
                  activeOperators[0] === op.key;
                const isHovered = hoveredOp === op.key;

                const uteProjectsFase2 = op.entities
                  .filter((e) => e.empresa.toUpperCase().includes('UTE'))
                  .reduce((acc, e) => acc + (e.proyectosFase2 ?? 0), 0);
                const indProjectsFase2 = op.entities
                  .filter((e) => !e.empresa.toUpperCase().includes('UTE'))
                  .reduce((acc, e) => acc + (e.proyectosFase2 ?? 0), 0);

                return (
                  <article
                    key={op.key}
                    className={`unico-op-stat-card${isHovered ? ' is-hovered' : ''}${isIsolated ? ' is-isolated' : ''}${!isIncluded ? ' is-excluded' : ''}`}
                    style={{
                      borderColor:
                        isHovered || isIsolated
                          ? op.meta.color
                          : op.meta.borderTint,
                    }}
                    onMouseEnter={() => setHoveredOp(op.key)}
                    onMouseLeave={() => setHoveredOp(null)}
                  >
                    <div className="unico-op-card-top">
                      <div className="unico-op-identity">
                        <span className="unico-op-name-row">
                          <span
                            className="operator-dot"
                            style={{
                              backgroundColor: op.meta.color,
                              width: 11,
                              height: 11,
                            }}
                            aria-hidden="true"
                          />
                          <h3 className="unico-op-title">{op.meta.name}</h3>
                        </span>
                        <span className="unico-op-legal-desc">
                          {op.meta.description}
                        </span>
                      </div>

                      <span
                        className="unico-op-pct-badge mono"
                        style={{
                          backgroundColor: op.meta.softBg,
                          borderColor: op.meta.borderTint,
                          color: op.meta.color,
                        }}
                      >
                        {formatUnicoPercent(op.total, analytics.totalSelected)}
                      </span>
                    </div>

                    <div className="unico-op-kpi-row">
                      <div className="unico-op-kpi-main">
                        <span className="unico-op-count mono">
                          {formatUnicoInt(op.total)}
                        </span>
                        <span className="unico-op-count-unit">antenas</span>
                        {isFilteredScope ? (
                          <span className="unico-op-national-ref mono">
                            · {formatUnicoPercent(op.total, dataset.total)} sobre
                            el total nacional (
                            {formatUnicoInt(dataset.total)})
                          </span>
                        ) : (
                          <span className="unico-op-national-ref">
                            · Total nacional UNICO 5G (
                            {formatUnicoInt(dataset.total)})
                          </span>
                        )}
                      </div>

                      <button
                        type="button"
                        className={`btn btn-sm ${isIsolated ? 'btn-active' : 'btn-subtle'} unico-op-filter-btn`}
                        onClick={() => onToggleSingleOperator(op.key)}
                        aria-pressed={isIsolated}
                      >
                        {isIsolated ? (
                          <>
                            <Check size={13} aria-hidden="true" />
                            <span>Mostrando {op.meta.shortName}</span>
                          </>
                        ) : (
                          <span>Filtrar {op.meta.shortName}</span>
                        )}
                      </button>
                    </div>

                    {/* Barra horizontal interna de doble segmento: Fase 1 vs Fase 2 */}
                    <div className="unico-op-phase-breakdown">
                      <div
                        className="stacked-bar unico-op-phase-bar"
                        aria-label={`Desglose por fase en ${op.meta.shortName}`}
                      >
                        {op.fase1 > 0 && (
                          <div
                            className="stacked-bar-seg"
                            style={{
                              width: `${op.pctFase1WithinOp}%`,
                              backgroundColor: UNICO_FASE_META[1].color,
                            }}
                            title={`Fase 1 (2023): ${formatUnicoInt(op.fase1)} antenas (${formatUnicoPercent(op.fase1, op.total)})`}
                          />
                        )}
                        {op.fase2 > 0 && (
                          <div
                            className="stacked-bar-seg"
                            style={{
                              width: `${op.pctFase2WithinOp}%`,
                              backgroundColor: UNICO_FASE_META[2].color,
                            }}
                            title={`Fase 2 (2024): ${formatUnicoInt(op.fase2)} antenas (${formatUnicoPercent(op.fase2, op.total)})`}
                          />
                        )}
                      </div>

                      <div className="unico-op-phase-meta">
                        <span className="unico-op-phase-pill">
                          <span
                            className="operator-dot"
                            style={{
                              backgroundColor: UNICO_FASE_META[1].color,
                              width: 7,
                              height: 7,
                            }}
                            aria-hidden="true"
                          />
                          <span>Fase 1 (2023):</span>
                          <strong className="mono">
                            {formatUnicoInt(op.fase1)}
                          </strong>
                          <span className="mono unico-muted-pct">
                            ({formatUnicoPercent(op.fase1, op.total)})
                          </span>
                        </span>

                        <span className="unico-op-phase-pill">
                          <span
                            className="operator-dot"
                            style={{
                              backgroundColor: UNICO_FASE_META[2].color,
                              width: 7,
                              height: 7,
                            }}
                            aria-hidden="true"
                          />
                          <span>Fase 2 (2024):</span>
                          <strong className="mono">
                            {formatUnicoInt(op.fase2)}
                          </strong>
                          <span className="mono unico-muted-pct">
                            ({formatUnicoPercent(op.fase2, op.total)})
                          </span>
                        </span>
                      </div>
                    </div>

                    {/* Desglose transparente de proyectos unificados para Orange */}
                    {op.key === 'orange' && op.entities.length > 0 && (
                      <div
                        className="unico-orange-projects-box"
                        style={{
                          backgroundColor: op.meta.softBg,
                          borderColor: op.meta.borderTint,
                        }}
                      >
                        <div className="unico-orange-box-header">
                          <strong className="unico-orange-box-title">
                            Proyectos Orange unificados en un único grupo
                          </strong>
                          {activeFase !== '1' && op.proyectosFase2 > 0 && (
                            <span className="unico-orange-projects-pill mono">
                              {op.proyectosFase2} proyectos adjudicados en Fase 2
                              ({uteProjectsFase2} UTE + {indProjectsFase2}{' '}
                              individual)
                            </span>
                          )}
                        </div>

                        <div className="unico-orange-entities-list">
                          {op.entities.map((ent) => (
                            <div
                              key={ent.empresa}
                              className="unico-orange-entity-row"
                            >
                              <div className="unico-orange-entity-main">
                                <span className="unico-orange-entity-name mono">
                                  {ent.empresa}
                                </span>
                                {activeFase !== '1' &&
                                  ent.proyectosFase2 !== undefined &&
                                  ent.proyectosFase2 > 0 && (
                                    <span className="tech-pill unico-orange-proj-tag mono">
                                      {ent.proyectosFase2} proy. F2
                                    </span>
                                  )}
                              </div>

                              <div className="unico-orange-entity-stats mono">
                                <strong>
                                  {formatUnicoInt(ent.total)}
                                </strong>{' '}
                                antenas ·{' '}
                                <span>
                                  {formatUnicoPercent(ent.total, op.total)} de
                                  Orange
                                </span>{' '}
                                <span className="unico-muted-pct">
                                  (
                                  {formatUnicoPercent(
                                    ent.total,
                                    analytics.totalSelected,
                                  )}{' '}
                                  sel. · F1: {formatUnicoInt(ent.fase1)}{' '}
                                  · F2: {formatUnicoInt(ent.fase2)})
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* ====================================================================
          BLOQUE 2: Radiografía Comparativa Fase 1 (2023) vs Fase 2 (2024)
         ==================================================================== */}
      <section
        id="unico-phases-section"
        className="section-block unico-section-block"
        aria-labelledby="unico-phases-h2"
      >
        <div className="section-block-header">
          <div>
            <h2 id="unico-phases-h2" className="section-h2">
              Radiografía Comparativa Fase 1 (2023) vs Fase 2 (2024)
            </h2>
            <p className="section-desc">
              Comparativa cronológica entre ambas convocatorias de UNICO 5G
              Redes Activas, cobertura municipal y composición por operador.
            </p>
          </div>

          <div
            className="unico-phase-filter-group"
            role="group"
            aria-label="Filtrar convocatoria UNICO 5G"
          >
            <button
              type="button"
              className={`btn btn-sm ${activeFase === 'all' ? 'btn-active' : 'btn-subtle'}`}
              onClick={() => onSelectFase('all')}
              aria-pressed={activeFase === 'all'}
            >
              Ambas fases
            </button>
            <button
              type="button"
              className={`btn btn-sm ${activeFase === '1' ? 'btn-active' : 'btn-subtle'}`}
              onClick={() => onSelectFase(activeFase === '1' ? 'all' : '1')}
              aria-pressed={activeFase === '1'}
            >
              Fase 1 · 2023
            </button>
            <button
              type="button"
              className={`btn btn-sm ${activeFase === '2' ? 'btn-active' : 'btn-subtle'}`}
              onClick={() => onSelectFase(activeFase === '2' ? 'all' : '2')}
              aria-pressed={activeFase === '2'}
            >
              Fase 2 · 2024
            </button>
          </div>
        </div>

        <div className="section-block-body">
          {/* Tarjetas interactivas cronológicas: Fase 1 (2023) y Fase 2 (2024) */}
          <div className="unico-phase-cards-grid">
            <button
              type="button"
              className={`unico-phase-card${activeFase === '1' ? ' is-active' : ''}`}
              style={{
                borderColor:
                  activeFase === '1'
                    ? UNICO_FASE_META[1].color
                    : 'var(--border-subtle)',
              }}
              onClick={() => onSelectFase(activeFase === '1' ? 'all' : '1')}
              aria-pressed={activeFase === '1'}
            >
              <div className="unico-phase-card-head">
                <span className="unico-phase-card-title-wrap">
                  <span
                    className="operator-dot"
                    style={{
                      backgroundColor: UNICO_FASE_META[1].color,
                      width: 10,
                      height: 10,
                    }}
                    aria-hidden="true"
                  />
                  <span className="unico-phase-card-title">
                    {UNICO_FASE_META[1].label}
                  </span>
                </span>
                <span
                  className="unico-phase-card-badge mono"
                  style={{
                    backgroundColor: UNICO_FASE_META[1].softBg,
                    color: UNICO_FASE_META[1].color,
                  }}
                >
                  {activeFase === '1' ? 'Filtro activo ✓' : 'Filtrar Fase 1'}
                </span>
              </div>

              <div className="unico-phase-card-main">
                <span className="unico-phase-card-count mono">
                  {formatUnicoInt(analytics.fase1Selected)}
                </span>
                <span className="unico-phase-card-unit">antenas</span>
                <span className="unico-phase-card-pct mono">
                  {formatUnicoPercent(
                    analytics.fase1Selected,
                    analytics.totalSelected,
                  )}{' '}
                  sobre selección
                </span>
              </div>

              <div className="unico-phase-card-metrics">
                <div className="unico-phase-metric-item">
                  <span className="unico-phase-metric-label">
                    Municipios cubiertos (Fase 1)
                  </span>
                  <strong className="mono">
                    {formatUnicoInt(analytics.uniqueMunicipiosFase1)}
                  </strong>
                </div>
                <div className="unico-phase-metric-item">
                  <span className="unico-phase-metric-label">
                    Municipios en ambas fases
                  </span>
                  <strong className="mono">
                    {formatUnicoInt(analytics.sharedMunicipiosBothPhases)}
                  </strong>
                </div>
                <div className="unico-phase-metric-item">
                  <span className="unico-phase-metric-label">
                    Referencia nacional 2023
                  </span>
                  <strong className="mono">
                    {formatUnicoInt(dataset.fase1Total)} antenas
                  </strong>
                </div>
              </div>
            </button>

            <button
              type="button"
              className={`unico-phase-card${activeFase === '2' ? ' is-active' : ''}`}
              style={{
                borderColor:
                  activeFase === '2'
                    ? UNICO_FASE_META[2].color
                    : 'var(--border-subtle)',
              }}
              onClick={() => onSelectFase(activeFase === '2' ? 'all' : '2')}
              aria-pressed={activeFase === '2'}
            >
              <div className="unico-phase-card-head">
                <span className="unico-phase-card-title-wrap">
                  <span
                    className="operator-dot"
                    style={{
                      backgroundColor: UNICO_FASE_META[2].color,
                      width: 10,
                      height: 10,
                    }}
                    aria-hidden="true"
                  />
                  <span className="unico-phase-card-title">
                    {UNICO_FASE_META[2].label}
                  </span>
                </span>
                <span
                  className="unico-phase-card-badge mono"
                  style={{
                    backgroundColor: UNICO_FASE_META[2].softBg,
                    color: UNICO_FASE_META[2].color,
                  }}
                >
                  {activeFase === '2' ? 'Filtro activo ✓' : 'Filtrar Fase 2'}
                </span>
              </div>

              <div className="unico-phase-card-main">
                <span className="unico-phase-card-count mono">
                  {formatUnicoInt(analytics.fase2Selected)}
                </span>
                <span className="unico-phase-card-unit">antenas</span>
                <span className="unico-phase-card-pct mono">
                  {formatUnicoPercent(
                    analytics.fase2Selected,
                    analytics.totalSelected,
                  )}{' '}
                  sobre selección
                </span>
              </div>

              <div className="unico-phase-card-metrics">
                <div className="unico-phase-metric-item">
                  <span className="unico-phase-metric-label">
                    Municipios cubiertos (Fase 2)
                  </span>
                  <strong className="mono">
                    {formatUnicoInt(analytics.uniqueMunicipiosFase2)}
                  </strong>
                </div>
                <div className="unico-phase-metric-item">
                  <span className="unico-phase-metric-label">
                    Municipios en ambas fases
                  </span>
                  <strong className="mono">
                    {formatUnicoInt(analytics.sharedMunicipiosBothPhases)}
                  </strong>
                </div>
                <div className="unico-phase-metric-item">
                  <span className="unico-phase-metric-label">
                    Referencia nacional 2024
                  </span>
                  <strong className="mono">
                    {formatUnicoInt(dataset.fase2Total)} ant. ·{' '}
                    {dataset.fase2ProjectsTotal} proy.
                  </strong>
                </div>
              </div>
            </button>
          </div>

          {/* Comparativa proporcional apilada + Gráfico Butterfly divergente */}
          <div className="unico-phase-comparison-chart">
            <div className="unico-phase-comparison-header">
              <h3 className="unico-subsection-title">
                Composición interna por operador en cada convocatoria
              </h3>
              <div className="legend-inline">
                {UNICO_OPERATOR_ORDER.map((opKey) => {
                  const meta = UNICO_OPERATOR_META[opKey];
                  return (
                    <span key={opKey} className="legend-inline-item">
                      <span
                        className="operator-dot"
                        style={{ backgroundColor: meta.color }}
                        aria-hidden="true"
                      />
                      <span>{meta.shortName}</span>
                    </span>
                  );
                })}
              </div>
            </div>

            {/* Dos barras horizontales de composición 100% (Fase 1 y Fase 2) */}
            <div className="unico-phase-stacked-rows">
              {/* Fila Fase 1 */}
              <div className="unico-phase-stacked-row">
                <div className="unico-phase-stacked-meta">
                  <span className="unico-phase-row-label">
                    <span
                      className="operator-dot"
                      style={{ backgroundColor: UNICO_FASE_META[1].color }}
                      aria-hidden="true"
                    />
                    <strong>Fase 1 · Convocatoria 2023</strong>
                  </span>
                  <span className="mono unico-phase-row-total">
                    {formatUnicoInt(analytics.fase1Selected)} antenas (
                    {formatUnicoInt(analytics.uniqueMunicipiosFase1)}{' '}
                    municipios)
                  </span>
                </div>

                <div
                  className="unico-phase-stacked-bar"
                  role="img"
                  aria-label="Composición por operador en Fase 1 (2023)"
                >
                  {phaseOperatorShares.map(({ op, pctInFase1 }) => {
                    if (op.fase1 <= 0 || analytics.fase1Selected <= 0) {
                      return null;
                    }
                    return (
                      <div
                        key={op.key}
                        className="unico-phase-stacked-seg"
                        style={{
                          width: `${pctInFase1}%`,
                          backgroundColor: op.meta.color,
                        }}
                        title={`${op.meta.shortName} en Fase 1: ${formatUnicoInt(op.fase1)} antenas (${formatUnicoPercent(op.fase1, analytics.fase1Selected)})`}
                      >
                        {pctInFase1 >= 8.5 && (
                          <span className="unico-phase-seg-label mono">
                            {op.meta.shortName}{' '}
                            {formatUnicoPercent(
                              op.fase1,
                              analytics.fase1Selected,
                            )}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="unico-phase-callouts">
                  {phaseOperatorShares.map(({ op }) => (
                    <span
                      key={op.key}
                      className="unico-phase-callout-chip mono"
                    >
                      <span
                        className="operator-dot"
                        style={{
                          backgroundColor: op.meta.color,
                          width: 7,
                          height: 7,
                        }}
                        aria-hidden="true"
                      />
                      <span>{op.meta.shortName}:</span>
                      <strong>{formatUnicoInt(op.fase1)}</strong>
                      <span className="unico-muted-pct">
                        ({formatUnicoPercent(op.fase1, analytics.fase1Selected)})
                      </span>
                    </span>
                  ))}
                </div>
              </div>

              {/* Fila Fase 2 */}
              <div className="unico-phase-stacked-row">
                <div className="unico-phase-stacked-meta">
                  <span className="unico-phase-row-label">
                    <span
                      className="operator-dot"
                      style={{ backgroundColor: UNICO_FASE_META[2].color }}
                      aria-hidden="true"
                    />
                    <strong>Fase 2 · Convocatoria 2024</strong>
                  </span>
                  <span className="mono unico-phase-row-total">
                    {formatUnicoInt(analytics.fase2Selected)} antenas (
                    {formatUnicoInt(analytics.uniqueMunicipiosFase2)}{' '}
                    municipios)
                  </span>
                </div>

                <div
                  className="unico-phase-stacked-bar"
                  role="img"
                  aria-label="Composición por operador en Fase 2 (2024)"
                >
                  {phaseOperatorShares.map(({ op, pctInFase2 }) => {
                    if (op.fase2 <= 0 || analytics.fase2Selected <= 0) {
                      return null;
                    }
                    return (
                      <div
                        key={op.key}
                        className="unico-phase-stacked-seg"
                        style={{
                          width: `${pctInFase2}%`,
                          backgroundColor: op.meta.color,
                        }}
                        title={`${op.meta.shortName} en Fase 2: ${formatUnicoInt(op.fase2)} antenas (${formatUnicoPercent(op.fase2, analytics.fase2Selected)})`}
                      >
                        {pctInFase2 >= 8.5 && (
                          <span className="unico-phase-seg-label mono">
                            {op.meta.shortName}{' '}
                            {formatUnicoPercent(
                              op.fase2,
                              analytics.fase2Selected,
                            )}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="unico-phase-callouts">
                  {phaseOperatorShares.map(({ op }) => (
                    <span
                      key={op.key}
                      className="unico-phase-callout-chip mono"
                    >
                      <span
                        className="operator-dot"
                        style={{
                          backgroundColor: op.meta.color,
                          width: 7,
                          height: 7,
                        }}
                        aria-hidden="true"
                      />
                      <span>{op.meta.shortName}:</span>
                      <strong>{formatUnicoInt(op.fase2)}</strong>
                      <span className="unico-muted-pct">
                        ({formatUnicoPercent(op.fase2, analytics.fase2Selected)})
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* SVG Butterfly / Diverging Share Comparison */}
            <div className="unico-butterfly-wrap">
              <div className="unico-butterfly-title-row">
                <span className="unico-butterfly-caption">
                  Comparativa simétrica de cuota dentro de Fase 1 vs cuota
                  dentro de Fase 2
                </span>
                <span className="unico-butterfly-sub mono">
                  Municipios compartidos F1+F2:{' '}
                  {formatUnicoInt(analytics.sharedMunicipiosBothPhases)}{' '}
                  de {formatUnicoInt(analytics.uniqueMunicipios)}
                </span>
              </div>

              <svg
                viewBox="0 0 760 236"
                className="unico-butterfly-svg"
                role="img"
                aria-label="Gráfico divergente de cuota porcentual de cada operador dentro de Fase 1 (izquierda) frente a Fase 2 (derecha)"
              >
                {/* Cabeceras de ejes */}
                <text
                  x={BUTTERFLY_LEFT_ORIGIN}
                  y="20"
                  textAnchor="end"
                  fontSize="11.5"
                  fontWeight="700"
                  fill={UNICO_FASE_META[1].color}
                >
                  ← Cuota dentro de Fase 1 (2023)
                </text>
                <text
                  x="380"
                  y="20"
                  textAnchor="middle"
                  fontSize="11"
                  fontWeight="700"
                  fill="var(--text-muted)"
                >
                  OPERADOR · Δ CUOTA
                </text>
                <text
                  x={BUTTERFLY_RIGHT_ORIGIN}
                  y="20"
                  textAnchor="start"
                  fontSize="11.5"
                  fontWeight="700"
                  fill={UNICO_FASE_META[2].color}
                >
                  Cuota dentro de Fase 2 (2024) →
                </text>

                {/* Líneas guía de referencia (25%, 50%, 75%, 100%) */}
                {BUTTERFLY_TICKS.map((tick) => {
                  const offsetPx = (tick / 100) * BUTTERFLY_MAX_WING_PX;
                  const lx = BUTTERFLY_LEFT_ORIGIN - offsetPx;
                  const rx = BUTTERFLY_RIGHT_ORIGIN + offsetPx;
                  return (
                    <g key={tick}>
                      <line
                        x1={lx}
                        y1="30"
                        x2={lx}
                        y2="212"
                        stroke="var(--border-subtle)"
                        strokeDasharray="3 3"
                      />
                      <text
                        x={lx}
                        y="228"
                        textAnchor="middle"
                        fontSize="10"
                        fill="var(--text-muted)"
                      >
                        {tick} %
                      </text>

                      <line
                        x1={rx}
                        y1="30"
                        x2={rx}
                        y2="212"
                        stroke="var(--border-subtle)"
                        strokeDasharray="3 3"
                      />
                      <text
                        x={rx}
                        y="228"
                        textAnchor="middle"
                        fontSize="10"
                        fill="var(--text-muted)"
                      >
                        {tick} %
                      </text>
                    </g>
                  );
                })}

                {/* Ejes base izquierdo y derecho */}
                <line
                  x1={BUTTERFLY_LEFT_ORIGIN}
                  y1="28"
                  x2={BUTTERFLY_LEFT_ORIGIN}
                  y2="214"
                  stroke="var(--border-default)"
                  strokeWidth="1.2"
                />
                <line
                  x1={BUTTERFLY_RIGHT_ORIGIN}
                  y1="28"
                  x2={BUTTERFLY_RIGHT_ORIGIN}
                  y2="214"
                  stroke="var(--border-default)"
                  strokeWidth="1.2"
                />

                {/* Filas en orden canónico UNICO_OPERATOR_ORDER */}
                {phaseOperatorShares.map(
                  ({ op, pctInFase1, pctInFase2, deltaPp }, idx) => {
                    const rowY = 38 + idx * 44;
                    const barHeight = 22;
                    const barY = rowY + 6;
                    const leftW = Math.max(
                      pctInFase1 > 0 ? 2.5 : 0,
                      (pctInFase1 / 100) * BUTTERFLY_MAX_WING_PX,
                    );
                    const rightW = Math.max(
                      pctInFase2 > 0 ? 2.5 : 0,
                      (pctInFase2 / 100) * BUTTERFLY_MAX_WING_PX,
                    );
                    const showDelta =
                      analytics.fase1Selected > 0 && analytics.fase2Selected > 0;

                    return (
                      <g
                        key={op.key}
                        className="unico-butterfly-row"
                        style={{ cursor: 'pointer' }}
                        onClick={() => onToggleSingleOperator(op.key)}
                      >
                        {/* Pistas de fondo */}
                        <rect
                          x={BUTTERFLY_LEFT_ORIGIN - BUTTERFLY_MAX_WING_PX}
                          y={barY}
                          width={BUTTERFLY_MAX_WING_PX}
                          height={barHeight}
                          rx="5"
                          fill="var(--bg-surface-subtle)"
                        />
                        <rect
                          x={BUTTERFLY_RIGHT_ORIGIN}
                          y={barY}
                          width={BUTTERFLY_MAX_WING_PX}
                          height={barHeight}
                          rx="5"
                          fill="var(--bg-surface-subtle)"
                        />

                        {/* Ala izquierda: Fase 1 */}
                        {leftW > 0 && (
                          <rect
                            x={BUTTERFLY_LEFT_ORIGIN - leftW}
                            y={barY}
                            width={leftW}
                            height={barHeight}
                            rx="5"
                            fill={op.meta.color}
                            opacity="0.9"
                          />
                        )}
                        <text
                          x={BUTTERFLY_LEFT_ORIGIN - leftW - 8}
                          y={barY + 15}
                          textAnchor="end"
                          fontSize="11.5"
                          fontWeight="700"
                          fontFamily="var(--font-mono)"
                          fill="var(--text-primary)"
                        >
                          {formatUnicoPercent(
                            op.fase1,
                            analytics.fase1Selected,
                          )}
                        </text>

                        {/* Columna central: Operador + variación en puntos porcentuales */}
                        <rect
                          x={BUTTERFLY_LEFT_ORIGIN + 8}
                          y={rowY + 2}
                          width={
                            BUTTERFLY_RIGHT_ORIGIN - BUTTERFLY_LEFT_ORIGIN - 16
                          }
                          height={30}
                          rx="6"
                          fill="var(--bg-surface-subtle)"
                          stroke={op.meta.borderTint}
                        />
                        <circle
                          cx={BUTTERFLY_LEFT_ORIGIN + 22}
                          cy={rowY + 13}
                          r="4.5"
                          fill={op.meta.color}
                        />
                        <text
                          x={BUTTERFLY_LEFT_ORIGIN + 32}
                          y={rowY + 16.5}
                          textAnchor="start"
                          fontSize="12"
                          fontWeight="700"
                          fill="var(--text-primary)"
                        >
                          {op.meta.shortName}
                        </text>
                        <text
                          x="380"
                          y={rowY + 28}
                          textAnchor="middle"
                          fontSize="10"
                          fontFamily="var(--font-mono)"
                          fill="var(--text-muted)"
                        >
                          {showDelta
                            ? formatSignedPercentagePoints(deltaPp)
                            : `${formatUnicoInt(op.total)} ant.`}
                        </text>

                        {/* Ala derecha: Fase 2 */}
                        {rightW > 0 && (
                          <rect
                            x={BUTTERFLY_RIGHT_ORIGIN}
                            y={barY}
                            width={rightW}
                            height={barHeight}
                            rx="5"
                            fill={op.meta.color}
                          />
                        )}
                        <text
                          x={BUTTERFLY_RIGHT_ORIGIN + rightW + 8}
                          y={barY + 15}
                          textAnchor="start"
                          fontSize="11.5"
                          fontWeight="700"
                          fontFamily="var(--font-mono)"
                          fill="var(--text-primary)"
                        >
                          {formatUnicoPercent(
                            op.fase2,
                            analytics.fase2Selected,
                          )}
                        </text>
                      </g>
                    );
                  },
                )}
              </svg>

              {analytics.fase1Selected > 0 &&
                analytics.fase2Selected > 0 &&
                orangePhaseShare &&
                movistarPhaseShare && (
                  <p className="unico-butterfly-note">
                    <strong>Lectura comparativa entre fases:</strong> En el
                    ámbito seleccionado, la participación unificada de{' '}
                    <strong>Orange</strong> pasa de{' '}
                    <span className="mono">
                      {formatUnicoPercent(
                        orangePhaseShare.op.fase1,
                        analytics.fase1Selected,
                      )}
                    </span>{' '}
                    en Fase 1 (2023) a{' '}
                    <span className="mono">
                      {formatUnicoPercent(
                        orangePhaseShare.op.fase2,
                        analytics.fase2Selected,
                      )}
                    </span>{' '}
                    en Fase 2 (2024), mientras que{' '}
                    <strong>Movistar</strong> representa{' '}
                    <span className="mono">
                      {formatUnicoPercent(
                        movistarPhaseShare.op.fase1,
                        analytics.fase1Selected,
                      )}
                    </span>{' '}
                    en Fase 1 y{' '}
                    <span className="mono">
                      {formatUnicoPercent(
                        movistarPhaseShare.op.fase2,
                        analytics.fase2Selected,
                      )}
                    </span>{' '}
                    en Fase 2, concentrándose las adjudicaciones de{' '}
                    <strong>Vodafone</strong> y <strong>Avatel</strong> en la
                    convocatoria de 2023.
                  </p>
                )}
            </div>
          </div>
        </div>
      </section>

      {/* ====================================================================
          BLOQUE 3: Distribución Territorial por CCAA y Provincia (A–Z)
         ==================================================================== */}
      <section
        id="unico-territorial-section"
        className="section-block unico-section-block"
        aria-labelledby="unico-territorial-h2"
      >
        <div className="section-block-header">
          <div>
            <h2 id="unico-territorial-h2" className="section-h2">
              Distribución Territorial por Comunidad Autónoma y Provincia
            </h2>
            <p className="section-desc">
              Listado estrictamente alfabético (A–Z) de Comunidades Autónomas y
              Provincias con desglose proporcional por operador o convocatoria.
            </p>
          </div>

          <div className="unico-territorial-controls">
            <div
              className="unico-colormode-toggle"
              role="group"
              aria-label="Segmentar barras territoriales por operador o por fase"
            >
              <button
                type="button"
                className={`btn btn-sm ${colorMode === 'operator' ? 'btn-active' : 'btn-subtle'}`}
                onClick={() => onColorModeChange('operator')}
                aria-pressed={colorMode === 'operator'}
              >
                Por Operador
              </button>
              <button
                type="button"
                className={`btn btn-sm ${colorMode === 'fase' ? 'btn-active' : 'btn-subtle'}`}
                onClick={() => onColorModeChange('fase')}
                aria-pressed={colorMode === 'fase'}
              >
                Por Fase 1 / Fase 2
              </button>
            </div>

            <button
              type="button"
              className="btn btn-sm btn-secondary unico-expand-all-btn"
              onClick={handleToggleExpandAll}
              disabled={analytics.comunidadesAlpha.length === 0}
            >
              {allCcaasExpanded ? 'Contraer todas' : 'Expandir todas'}
            </button>
          </div>
        </div>

        <div className="unico-territorial-legend-strip">
          <div className="legend-inline">
            {colorMode === 'operator' ? (
              UNICO_OPERATOR_ORDER.map((opKey) => {
                const meta = UNICO_OPERATOR_META[opKey];
                return (
                  <span key={opKey} className="legend-inline-item">
                    <span
                      className="operator-dot"
                      style={{ backgroundColor: meta.color }}
                      aria-hidden="true"
                    />
                    <span>{meta.shortName}</span>
                  </span>
                );
              })
            ) : (
              <>
                <span className="legend-inline-item">
                  <span
                    className="operator-dot"
                    style={{ backgroundColor: UNICO_FASE_META[1].color }}
                    aria-hidden="true"
                  />
                  <span>{UNICO_FASE_META[1].label}</span>
                </span>
                <span className="legend-inline-item">
                  <span
                    className="operator-dot"
                    style={{ backgroundColor: UNICO_FASE_META[2].color }}
                    aria-hidden="true"
                  />
                  <span>{UNICO_FASE_META[2].label}</span>
                </span>
              </>
            )}
          </div>

          <span className="tech-pill mono">
            Orden A–Z · {analytics.uniqueComunidades} CCAA ·{' '}
            {analytics.uniqueProvincias} prov. ·{' '}
            {formatUnicoInt(analytics.uniqueMunicipios)} mun.
          </span>
        </div>

        <div className="section-block-body">
          {analytics.comunidadesAlpha.length === 0 ? (
            <div className="callout-note unico-empty-territory">
              No se registran antenas UNICO 5G para la combinación actual de
              filtros. Ajusta la fase, operador o territorio para inspeccionar
              el desglose autonómico y provincial.
            </div>
          ) : (
            <div className="unico-ccaa-list">
              {analytics.comunidadesAlpha.map((item) => {
                const isExpanded = isCcaaExpanded(item.ccaa, item.provinces);
                const isSelectedCcaa = selectedCcaa === item.ccaa;
                const sublistId = `unico-provs-${sanitizeDomId(item.ccaa)}`;
                const ccaaScalePct =
                  maxCcaaTotal > 0
                    ? Math.max(
                        (item.total / maxCcaaTotal) * 100,
                        item.total > 0 ? 1.8 : 0,
                      )
                    : 0;

                return (
                  <div
                    key={item.ccaa}
                    className={`unico-ccaa-group${isExpanded ? ' is-expanded' : ''}`}
                  >
                    <div
                      className={`unico-ccaa-row${isSelectedCcaa ? ' is-selected' : ''}`}
                    >
                      <div className="unico-territory-identity">
                        <button
                          type="button"
                          className="icon-btn unico-ccaa-chevron-btn"
                          aria-expanded={isExpanded}
                          aria-controls={sublistId}
                          aria-label={`${isExpanded ? 'Contraer' : 'Expandir'} provincias de ${item.ccaa}`}
                          onClick={() =>
                            handleToggleCcaaExpand(item.ccaa, item.provinces)
                          }
                        >
                          <ChevronRight
                            size={15}
                            aria-hidden="true"
                            style={{
                              transform: isExpanded
                                ? 'rotate(90deg)'
                                : 'rotate(0deg)',
                              transition: 'transform 0.16s ease',
                            }}
                          />
                        </button>

                        <div className="unico-territory-title-block">
                          <span className="unico-ccaa-name">{item.ccaa}</span>
                          <span className="tech-pill unico-territory-subpill mono">
                            {item.provincesCount} prov. ·{' '}
                            {formatUnicoInt(item.municipiosCount)} mun.
                          </span>
                        </div>
                      </div>

                      {/* Barra proporcional escalada respecto a maxCcaaTotal */}
                      <div className="unico-territory-bar-col">
                        <div
                          className="unico-territory-bar-track"
                          aria-label={`Distribución en ${item.ccaa}`}
                        >
                          <div
                            className="unico-territory-bar-fill-group"
                            style={{
                              width: `${ccaaScalePct}%`,
                              display: 'flex',
                              height: '100%',
                              borderRadius: '999px',
                              overflow: 'hidden',
                            }}
                          >
                            {colorMode === 'operator' ? (
                              UNICO_OPERATOR_ORDER.map((opKey) => {
                                const count = item.byOperator[opKey] ?? 0;
                                if (count <= 0 || item.total <= 0) return null;
                                const segPct = (count / item.total) * 100;
                                const meta = UNICO_OPERATOR_META[opKey];
                                return (
                                  <div
                                    key={opKey}
                                    className="stacked-bar-seg"
                                    style={{
                                      width: `${segPct}%`,
                                      backgroundColor: meta.color,
                                    }}
                                    title={`${item.ccaa} · ${meta.shortName}: ${formatUnicoInt(count)} antenas (${formatUnicoPercent(count, item.total)})`}
                                  />
                                );
                              })
                            ) : (
                              <>
                                {item.fase1 > 0 && item.total > 0 && (
                                  <div
                                    className="stacked-bar-seg"
                                    style={{
                                      width: `${(item.fase1 / item.total) * 100}%`,
                                      backgroundColor: UNICO_FASE_META[1].color,
                                    }}
                                    title={`${item.ccaa} · Fase 1 (2023): ${formatUnicoInt(item.fase1)} antenas (${formatUnicoPercent(item.fase1, item.total)})`}
                                  />
                                )}
                                {item.fase2 > 0 && item.total > 0 && (
                                  <div
                                    className="stacked-bar-seg"
                                    style={{
                                      width: `${(item.fase2 / item.total) * 100}%`,
                                      backgroundColor: UNICO_FASE_META[2].color,
                                    }}
                                    title={`${item.ccaa} · Fase 2 (2024): ${formatUnicoInt(item.fase2)} antenas (${formatUnicoPercent(item.fase2, item.total)})`}
                                  />
                                )}
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="unico-territory-numbers mono">
                        <span className="unico-territory-main-num">
                          <strong>{formatUnicoInt(item.total)}</strong>{' '}
                          <span className="unico-territory-unit">antenas</span>
                        </span>
                        <span className="unico-territory-pct">
                          {formatUnicoPercent(
                            item.total,
                            analytics.totalSelected,
                          )}
                        </span>
                        <span className="unico-territory-f1f2">
                          F1: {formatUnicoInt(item.fase1)} · F2:{' '}
                          {formatUnicoInt(item.fase2)}
                        </span>
                      </div>

                      <div className="unico-territory-actions">
                        <button
                          type="button"
                          className={`btn btn-sm ${isSelectedCcaa ? 'btn-active' : 'btn-subtle'} unico-filter-territory-btn`}
                          onClick={() => handleFilterCcaaClick(item.ccaa)}
                          aria-pressed={isSelectedCcaa}
                        >
                          {isSelectedCcaa ? 'Filtrar CCAA ✓' : 'Filtrar CCAA'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-subtle unico-map-territory-btn"
                          onClick={() =>
                            onFocusTerritoryOnMap(item.bounds, item.ccaa)
                          }
                          title={`Centrar ${item.ccaa} en el mapa UNICO 5G`}
                        >
                          <MapPin size={13} aria-hidden="true" />
                          <span>Mapa</span>
                        </button>
                      </div>
                    </div>

                    {/* Sublista provincial en orden alfabético A–Z */}
                    {isExpanded && (
                      <div
                        id={sublistId}
                        className="unico-prov-sublist"
                        role="region"
                        aria-label={`Provincias de ${item.ccaa} en orden alfabético`}
                      >
                        {item.provinces.map((p) => {
                          const isSelectedProv = selectedProv === p.prov;
                          const provScalePct =
                            maxProvTotal > 0
                              ? Math.max(
                                  (p.total / maxProvTotal) * 100,
                                  p.total > 0 ? 1.8 : 0,
                                )
                              : 0;

                          return (
                            <div
                              key={p.prov}
                              className={`unico-prov-row${isSelectedProv ? ' is-selected' : ''}`}
                            >
                              <div className="unico-prov-identity">
                                <span className="unico-prov-name">
                                  {p.prov}
                                </span>
                                <span className="tech-pill unico-territory-subpill mono">
                                  {formatUnicoInt(p.municipiosCount)}{' '}
                                  mun.
                                </span>
                              </div>

                              <div className="unico-territory-bar-col">
                                <div
                                  className="unico-territory-bar-track is-prov"
                                  aria-label={`Distribución en ${p.prov}`}
                                >
                                  <div
                                    className="unico-territory-bar-fill-group"
                                    style={{
                                      width: `${provScalePct}%`,
                                      display: 'flex',
                                      height: '100%',
                                      borderRadius: '999px',
                                      overflow: 'hidden',
                                    }}
                                  >
                                    {colorMode === 'operator' ? (
                                      UNICO_OPERATOR_ORDER.map((opKey) => {
                                        const count =
                                          p.byOperator[opKey] ?? 0;
                                        if (count <= 0 || p.total <= 0) {
                                          return null;
                                        }
                                        const segPct = (count / p.total) * 100;
                                        const meta = UNICO_OPERATOR_META[opKey];
                                        return (
                                          <div
                                            key={opKey}
                                            className="stacked-bar-seg"
                                            style={{
                                              width: `${segPct}%`,
                                              backgroundColor: meta.color,
                                            }}
                                            title={`${p.prov} · ${meta.shortName}: ${formatUnicoInt(count)} antenas (${formatUnicoPercent(count, p.total)})`}
                                          />
                                        );
                                      })
                                    ) : (
                                      <>
                                        {p.fase1 > 0 && p.total > 0 && (
                                          <div
                                            className="stacked-bar-seg"
                                            style={{
                                              width: `${(p.fase1 / p.total) * 100}%`,
                                              backgroundColor:
                                                UNICO_FASE_META[1].color,
                                            }}
                                            title={`${p.prov} · Fase 1 (2023): ${formatUnicoInt(p.fase1)} antenas (${formatUnicoPercent(p.fase1, p.total)})`}
                                          />
                                        )}
                                        {p.fase2 > 0 && p.total > 0 && (
                                          <div
                                            className="stacked-bar-seg"
                                            style={{
                                              width: `${(p.fase2 / p.total) * 100}%`,
                                              backgroundColor:
                                                UNICO_FASE_META[2].color,
                                            }}
                                            title={`${p.prov} · Fase 2 (2024): ${formatUnicoInt(p.fase2)} antenas (${formatUnicoPercent(p.fase2, p.total)})`}
                                          />
                                        )}
                                      </>
                                    )}
                                  </div>
                                </div>
                              </div>

                              <div className="unico-territory-numbers mono">
                                <span className="unico-territory-main-num">
                                  <strong>
                                    {formatUnicoInt(p.total)}
                                  </strong>{' '}
                                  <span className="unico-territory-unit">
                                    ant.
                                  </span>
                                </span>
                                <span className="unico-territory-pct">
                                  {formatUnicoPercent(
                                    p.total,
                                    analytics.totalSelected,
                                  )}
                                </span>
                                <span className="unico-territory-f1f2">
                                  F1: {formatUnicoInt(p.fase1)} · F2:{' '}
                                  {formatUnicoInt(p.fase2)}
                                </span>
                              </div>

                              <div className="unico-territory-actions">
                                <button
                                  type="button"
                                  className={`btn btn-sm ${isSelectedProv ? 'btn-active' : 'btn-subtle'} unico-filter-territory-btn`}
                                  onClick={() =>
                                    handleFilterProvClick(item.ccaa, p.prov)
                                  }
                                  aria-pressed={isSelectedProv}
                                >
                                  {isSelectedProv ? 'Filtrar ✓' : 'Filtrar'}
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-sm btn-subtle unico-map-territory-btn"
                                  onClick={() =>
                                    onFocusTerritoryOnMap(p.bounds, p.prov)
                                  }
                                  title={`Centrar provincia de ${p.prov} en el mapa UNICO 5G`}
                                >
                                  <MapPin size={12} aria-hidden="true" />
                                  <span>Mapa</span>
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
