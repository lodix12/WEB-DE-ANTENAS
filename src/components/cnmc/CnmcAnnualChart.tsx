import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import {
  formatCnmcAxisTick,
  formatCnmcDeltaPct,
  formatCnmcSharePct,
  formatCnmcValue,
} from '../../hooks/useCnmcData';
import type {
  CnmcChartMode,
  CnmcChartSeries,
  CnmcSeriesViewModel,
} from '../../types/cnmc';

export interface CnmcAnnualChartProps {
  view: CnmcSeriesViewModel;
  chartMode: CnmcChartMode;
  showTotalLine: boolean;
  onToggleSeries: (seriesKey: string) => void;
}

const DEFAULT_CHART_WIDTH = 860;
const CHART_HEIGHT = 368;
const MARGIN_TOP = 20;
const MARGIN_RIGHT = 20;
const MARGIN_BOTTOM = 38;
const MARGIN_LEFT = 68;

function computeNiceScale(maxValue: number, tickCount = 5): {
  max: number;
  ticks: number[];
} {
  if (!Number.isFinite(maxValue) || maxValue <= 0) {
    return { max: 100, ticks: [0, 25, 50, 75, 100] };
  }
  const roughStep = maxValue / tickCount;
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const normalized = roughStep / magnitude;
  let niceNorm = 10;
  if (normalized <= 1) niceNorm = 1;
  else if (normalized <= 2) niceNorm = 2;
  else if (normalized <= 2.5) niceNorm = 2.5;
  else if (normalized <= 5) niceNorm = 5;

  const step = niceNorm * magnitude;
  const top = Math.ceil(maxValue / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step * 0.001; v += step) {
    ticks.push(Number(v.toFixed(6)));
  }
  return { max: top, ticks };
}

function buildSegmentedPath(
  points: ReadonlyArray<{ x: number; y: number | null }>,
): string {
  let d = '';
  let inSegment = false;
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    if (pt.y === null || !Number.isFinite(pt.y)) {
      inSegment = false;
      continue;
    }
    const cmd = inSegment ? 'L' : 'M';
    d += `${cmd}${pt.x.toFixed(2)},${pt.y.toFixed(2)} `;
    inSegment = true;
  }
  return d.trim();
}

function buildAreaPolygonPath(
  upper: ReadonlyArray<{ x: number; y: number }>,
  lower: ReadonlyArray<{ x: number; y: number }>,
): string {
  if (upper.length === 0) return '';
  if (upper.length === 1) {
    const half = 18;
    const u = upper[0];
    const l = lower[0];
    return `M${(u.x - half).toFixed(2)},${u.y.toFixed(2)} L${(u.x + half).toFixed(2)},${u.y.toFixed(2)} L${(l.x + half).toFixed(2)},${l.y.toFixed(2)} L${(l.x - half).toFixed(2)},${l.y.toFixed(2)} Z`;
  }
  let d = `M${upper[0].x.toFixed(2)},${upper[0].y.toFixed(2)}`;
  for (let i = 1; i < upper.length; i++) {
    d += ` L${upper[i].x.toFixed(2)},${upper[i].y.toFixed(2)}`;
  }
  for (let i = lower.length - 1; i >= 0; i--) {
    d += ` L${lower[i].x.toFixed(2)},${lower[i].y.toFixed(2)}`;
  }
  d += ' Z';
  return d;
}

export function CnmcAnnualChart({
  view,
  chartMode,
  showTotalLine,
  onToggleSeries,
}: CnmcAnnualChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [measuredWidth, setMeasuredWidth] = useState(DEFAULT_CHART_WIDTH);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [pinnedIdx, setPinnedIdx] = useState<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const updateWidth = () => {
      const next = Math.round(el.getBoundingClientRect().width);
      if (next >= 280) {
        setMeasuredWidth(next);
      }
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const years = view.years;
  const series = view.visibleSeries;
  const nYears = years.length;
  const chartWidth = Math.max(300, measuredWidth);
  const leftMargin = chartWidth < 480 ? 54 : MARGIN_LEFT;
  const plotWidth = Math.max(120, chartWidth - leftMargin - MARGIN_RIGHT);
  const plotHeight = CHART_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;

  // Índices activos seguros si cambia el rango de años
  const safePinnedIdx =
    pinnedIdx !== null && pinnedIdx < nYears ? pinnedIdx : null;
  const safeHoverIdx =
    hoverIdx !== null && hoverIdx < nYears ? hoverIdx : null;
  const activeIdx =
    safeHoverIdx ?? safePinnedIdx ?? (nYears > 0 ? nYears - 1 : null);

  // Determinar si en modo barras caben agrupadas o conviene apilarlas
  const useStackedBars = useMemo(() => {
    if (chartMode !== 'bar' || nYears === 0 || series.length <= 1) return false;
    const slotWidth = plotWidth / nYears;
    const groupedBarWidth = (slotWidth * 0.78) / series.length;
    return groupedBarWidth < 4;
  }, [chartMode, nYears, plotWidth, series.length]);

  const yScaleData = useMemo(() => {
    let maxVal = 0;
    if (chartMode === 'area' || (chartMode === 'bar' && useStackedBars)) {
      for (let yi = 0; yi < nYears; yi++) {
        let sum = 0;
        for (let si = 0; si < series.length; si++) {
          const v = series[si].points[yi]?.value;
          if (v !== null && v !== undefined && v > 0) sum += v;
        }
        if (sum > maxVal) maxVal = sum;
      }
    } else if (chartMode === 'indexed') {
      for (let si = 0; si < series.length; si++) {
        for (let yi = 0; yi < nYears; yi++) {
          const iv = series[si].points[yi]?.indexedValue;
          if (iv !== null && iv !== undefined && iv > maxVal) maxVal = iv;
        }
      }
      if (showTotalLine) {
        for (let yi = 0; yi < view.totalPoints.length; yi++) {
          const iv = view.totalPoints[yi]?.indexedValue;
          if (iv !== null && iv !== undefined && iv > maxVal) maxVal = iv;
        }
      }
      maxVal = Math.max(maxVal, 110);
    } else {
      for (let si = 0; si < series.length; si++) {
        for (let yi = 0; yi < nYears; yi++) {
          const v = series[si].points[yi]?.value;
          if (v !== null && v !== undefined && v > maxVal) maxVal = v;
        }
      }
      if (showTotalLine && chartMode === 'line') {
        for (let yi = 0; yi < view.totalPoints.length; yi++) {
          const v = view.totalPoints[yi]?.value;
          if (v !== null && v !== undefined && v > maxVal) maxVal = v;
        }
      }
    }
    return computeNiceScale(maxVal * 1.06, 5);
  }, [chartMode, useStackedBars, nYears, series, showTotalLine, view.totalPoints]);

  const xForIndex = useCallback(
    (idx: number): number => {
      if (nYears <= 1) return leftMargin + plotWidth / 2;
      if (chartMode === 'bar') {
        const slot = plotWidth / nYears;
        return leftMargin + slot * idx + slot / 2;
      }
      return leftMargin + (idx / (nYears - 1)) * plotWidth;
    },
    [nYears, leftMargin, plotWidth, chartMode],
  );

  const yForValue = useCallback(
    (val: number): number => {
      const ratio = yScaleData.max > 0 ? val / yScaleData.max : 0;
      return MARGIN_TOP + plotHeight * (1 - Math.min(1.05, Math.max(0, ratio)));
    },
    [yScaleData.max, plotHeight],
  );

  // Eje X: paso automático con distancia mínima en píxeles para evitar superposiciones
  const xTickIndices = useMemo(() => {
    if (nYears === 0) return [];
    const minPixelGap = chartWidth < 480 ? 48 : 54;
    const maxLabels = Math.max(2, Math.floor(plotWidth / minPixelGap));
    const step = Math.max(1, Math.ceil(nYears / maxLabels));
    const indices: number[] = [];
    for (let i = 0; i < nYears; i += step) {
      indices.push(i);
    }
    const lastIdx = nYears - 1;
    if (indices[indices.length - 1] !== lastIdx) {
      const prevIdx = indices[indices.length - 1];
      const gapPx = Math.abs(xForIndex(lastIdx) - xForIndex(prevIdx));
      if (gapPx < minPixelGap && indices.length > 1) {
        indices[indices.length - 1] = lastIdx;
      } else {
        indices.push(lastIdx);
      }
    }
    return indices;
  }, [nYears, plotWidth, chartWidth, xForIndex]);

  // Precalcular áreas apiladas si chartMode === 'area'
  const stackedAreas = useMemo(() => {
    if (chartMode !== 'area' || nYears === 0) return [];
    const baseline = new Array<number>(nYears).fill(0);
    return series.map((s) => {
      const lowerPts: Array<{ x: number; y: number }> = [];
      const upperPts: Array<{ x: number; y: number }> = [];
      for (let yi = 0; yi < nYears; yi++) {
        const val = Math.max(0, s.points[yi]?.value ?? 0);
        const lowVal = baseline[yi];
        const highVal = lowVal + val;
        baseline[yi] = highVal;
        const x = xForIndex(yi);
        lowerPts.push({ x, y: yForValue(lowVal) });
        upperPts.push({ x, y: yForValue(highVal) });
      }
      return {
        series: s,
        path: buildAreaPolygonPath(upperPts, lowerPts),
        topLine: buildSegmentedPath(upperPts),
      };
    });
  }, [chartMode, nYears, series, xForIndex, yForValue]);

  function resolveYearIndexFromClientX(clientX: number): number | null {
    const svgWrap = containerRef.current;
    if (!svgWrap || nYears === 0) return null;
    const rect = svgWrap.getBoundingClientRect();
    const relX = clientX - rect.left - leftMargin;
    if (nYears === 1) return 0;
    if (chartMode === 'bar') {
      const idx = Math.floor((relX / plotWidth) * nYears);
      return Math.min(nYears - 1, Math.max(0, idx));
    }
    const idx = Math.round((relX / plotWidth) * (nYears - 1));
    return Math.min(nYears - 1, Math.max(0, idx));
  }

  function handlePointerMove(e: PointerEvent<SVGSVGElement>) {
    const idx = resolveYearIndexFromClientX(e.clientX);
    if (idx !== null) {
      setHoverIdx(idx);
    }
  }

  function handlePointerLeave() {
    setHoverIdx(null);
  }

  function handleChartClick(e: PointerEvent<SVGSVGElement>) {
    const idx = resolveYearIndexFromClientX(e.clientX);
    if (idx === null) return;
    setPinnedIdx((prev) => (prev === idx ? null : idx));
  }

  function handleChartKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    if (nYears === 0) return;
    const current = activeIdx ?? nYears - 1;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setPinnedIdx(Math.max(0, current - 1));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setPinnedIdx(Math.min(nYears - 1, current + 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setPinnedIdx(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setPinnedIdx(nYears - 1);
    }
  }

  // Datos de inspección para el año activo (crosshair)
  const inspectedData = useMemo(() => {
    if (activeIdx === null || activeIdx >= nYears) return null;
    const year = years[activeIdx];
    const rows = series
      .map((s) => {
        const pt = s.points[activeIdx];
        return {
          key: s.key,
          label: s.label,
          color: s.color,
          value: pt?.value ?? null,
          indexedValue: pt?.indexedValue ?? null,
          yoyPct: pt?.yoyPct ?? null,
          sharePct: pt?.sharePct ?? null,
        };
      })
      .filter((r) => r.value !== null)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

    const totalPt = view.totalPoints[activeIdx] ?? null;
    return {
      year,
      rows,
      totalPt,
      isPinned: safePinnedIdx === activeIdx && safeHoverIdx === null,
    };
  }, [activeIdx, nYears, years, series, view.totalPoints, safePinnedIdx, safeHoverIdx]);

  if (nYears === 0 || series.length === 0) {
    return (
      <div className="cnmc-chart-empty">
        <p>No hay registros disponibles para esta combinación de parámetro, mercado y rango anual.</p>
      </div>
    );
  }

  const slotWidth = plotWidth / Math.max(1, nYears);
  const groupedBarSlot = slotWidth * 0.78;
  const groupedBarWidth = Math.min(
    34,
    Math.max(4, groupedBarSlot / Math.max(1, series.length) - 1.5),
  );
  const stackedBarWidth = Math.min(44, Math.max(8, slotWidth * 0.62));

  const totalLinePath =
    showTotalLine && (chartMode === 'line' || chartMode === 'indexed')
      ? buildSegmentedPath(
          view.totalPoints.map((pt, yi) => {
            const v = chartMode === 'indexed' ? pt.indexedValue : pt.value;
            return {
              x: xForIndex(yi),
              y: v !== null ? yForValue(v) : null,
            };
          }),
        )
      : '';

  return (
    <div className="cnmc-chart-shell">
      <div ref={containerRef} className="cnmc-chart-canvas-wrap">
        <svg
          id="cnmc-annual-chart-svg"
          className="cnmc-chart-svg"
          viewBox={`0 0 ${chartWidth} ${CHART_HEIGHT}`}
          width="100%"
          height={CHART_HEIGHT}
          role="img"
          tabIndex={0}
          aria-label={`Gráfica anual interactiva de ${view.metric.label} entre ${view.fromYear} y ${view.toYear}. Usa las flechas izquierda y derecha para recorrer los años.`}
          onPointerMove={handlePointerMove}
          onPointerLeave={handlePointerLeave}
          onPointerDown={handleChartClick}
          onKeyDown={handleChartKeyDown}
        >
          {/* Rejilla horizontal y eje Y */}
          <g className="cnmc-grid-group" aria-hidden="true">
            {yScaleData.ticks.map((tick) => {
              const y = yForValue(tick);
              return (
                <g key={tick}>
                  <line
                    x1={leftMargin}
                    x2={chartWidth - MARGIN_RIGHT}
                    y1={y}
                    y2={y}
                    className={
                      tick === 0 ? 'cnmc-axis-baseline' : 'cnmc-grid-line'
                    }
                  />
                  <text
                    x={leftMargin - 10}
                    y={y + 4}
                    textAnchor="end"
                    className="cnmc-axis-label mono"
                  >
                    {formatCnmcAxisTick(tick, view.metric.key, chartMode)}
                  </text>
                </g>
              );
            })}

            {/* Línea de referencia Base 100 */}
            {chartMode === 'indexed' && yScaleData.max >= 100 && (
              <g>
                <line
                  x1={leftMargin}
                  x2={chartWidth - MARGIN_RIGHT}
                  y1={yForValue(100)}
                  y2={yForValue(100)}
                  className="cnmc-base100-line"
                />
                <text
                  x={chartWidth - MARGIN_RIGHT - 4}
                  y={yForValue(100) - 6}
                  textAnchor="end"
                  className="cnmc-base100-label mono"
                >
                  Base 100
                </text>
              </g>
            )}
          </g>

          {/* Etiquetas de años (Eje X) */}
          <g className="cnmc-xaxis-group" aria-hidden="true">
            {xTickIndices.map((idx) => {
              const x = xForIndex(idx);
              const isSelected = activeIdx === idx;
              return (
                <text
                  key={years[idx]}
                  x={x}
                  y={CHART_HEIGHT - 12}
                  textAnchor="middle"
                  className={`cnmc-axis-label mono${isSelected ? ' is-highlighted' : ''}`}
                >
                  {years[idx]}
                </text>
              );
            })}
          </g>

          {/* Modo Área Apilada */}
          {chartMode === 'area' && (
            <g className="cnmc-areas-group">
              {stackedAreas.map((layer) => (
                <g key={layer.series.key}>
                  <path
                    d={layer.path}
                    fill={layer.series.color}
                    fillOpacity={0.28}
                  />
                  <path
                    d={layer.topLine}
                    fill="none"
                    stroke={layer.series.color}
                    strokeWidth={1.75}
                    strokeLinejoin="round"
                  />
                </g>
              ))}
            </g>
          )}

          {/* Modo Barras (Agrupadas o Apiladas si hay muchas series/años) */}
          {chartMode === 'bar' && (
            <g className="cnmc-bars-group">
              {years.map((year, yi) => {
                const centerX = xForIndex(yi);
                const isActiveCol = activeIdx === yi;
                if (useStackedBars) {
                  let acc = 0;
                  return (
                    <g key={year} opacity={activeIdx === null || isActiveCol ? 1 : 0.72}>
                      {series.map((s) => {
                        const val = Math.max(0, s.points[yi]?.value ?? 0);
                        if (val <= 0) return null;
                        const yTop = yForValue(acc + val);
                        const yBottom = yForValue(acc);
                        acc += val;
                        const h = Math.max(1, yBottom - yTop);
                        return (
                          <rect
                            key={s.key}
                            x={centerX - stackedBarWidth / 2}
                            y={yTop}
                            width={stackedBarWidth}
                            height={h}
                            fill={s.color}
                            rx={1.5}
                          />
                        );
                      })}
                    </g>
                  );
                }

                const totalGroupWidth = series.length * (groupedBarWidth + 1.5) - 1.5;
                const startX = centerX - totalGroupWidth / 2;
                return (
                  <g key={year} opacity={activeIdx === null || isActiveCol ? 1 : 0.76}>
                    {series.map((s, si) => {
                      const val = s.points[yi]?.value;
                      if (val === null || val === undefined || val <= 0) return null;
                      const yTop = yForValue(val);
                      const yBottom = yForValue(0);
                      const h = Math.max(1.5, yBottom - yTop);
                      return (
                        <rect
                          key={s.key}
                          x={startX + si * (groupedBarWidth + 1.5)}
                          y={yTop}
                          width={groupedBarWidth}
                          height={h}
                          fill={s.color}
                          rx={2}
                        />
                      );
                    })}
                  </g>
                );
              })}
            </g>
          )}

          {/* Modo Líneas e Índice Base 100 */}
          {(chartMode === 'line' || chartMode === 'indexed') && (
            <g className="cnmc-lines-group">
              {totalLinePath && (
                <path
                  d={totalLinePath}
                  fill="none"
                  className="cnmc-total-line"
                  strokeWidth={2}
                  strokeDasharray="6 4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}

              {series.map((s: CnmcChartSeries) => {
                const coords = s.points.map((pt, yi) => {
                  const v = chartMode === 'indexed' ? pt.indexedValue : pt.value;
                  return {
                    x: xForIndex(yi),
                    y: v !== null ? yForValue(v) : null,
                    raw: v,
                  };
                });
                const d = buildSegmentedPath(coords);
                const validCoords = coords.filter((c) => c.y !== null);

                return (
                  <g key={s.key}>
                    {d && (
                      <path
                        d={d}
                        fill="none"
                        stroke={s.color}
                        strokeWidth={2.35}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    )}
                    {/* Mostrar puntos discretos cuando hay 1 solo punto aislado o pocos años */}
                    {(validCoords.length === 1 || nYears <= 12) &&
                      validCoords.map((pt, idx) => (
                        <circle
                          key={idx}
                          cx={pt.x}
                          cy={pt.y!}
                          r={validCoords.length === 1 ? 4.5 : 3}
                          fill={s.color}
                          stroke="var(--bg-surface)"
                          strokeWidth={1.5}
                        />
                      ))}
                  </g>
                );
              })}
            </g>
          )}

          {/* Crosshair interactivo del año activo */}
          {activeIdx !== null && (
            <g className="cnmc-crosshair-group" aria-hidden="true">
              <line
                x1={xForIndex(activeIdx)}
                x2={xForIndex(activeIdx)}
                y1={MARGIN_TOP}
                y2={MARGIN_TOP + plotHeight}
                className="cnmc-crosshair-line"
              />
              {(chartMode === 'line' || chartMode === 'indexed') &&
                series.map((s) => {
                  const pt = s.points[activeIdx];
                  const v =
                    chartMode === 'indexed' ? pt?.indexedValue : pt?.value;
                  if (v === null || v === undefined) return null;
                  return (
                    <circle
                      key={s.key}
                      cx={xForIndex(activeIdx)}
                      cy={yForValue(v)}
                      r={5}
                      fill={s.color}
                      stroke="var(--bg-surface)"
                      strokeWidth={2.2}
                    />
                  );
                })}
              {showTotalLine &&
                (chartMode === 'line' || chartMode === 'indexed') && (() => {
                  const pt = view.totalPoints[activeIdx];
                  const v =
                    chartMode === 'indexed' ? pt?.indexedValue : pt?.value;
                  if (v === null || v === undefined) return null;
                  return (
                    <circle
                      cx={xForIndex(activeIdx)}
                      cy={yForValue(v)}
                      r={4.5}
                      className="cnmc-total-dot"
                    />
                  );
                })()}
            </g>
          )}
        </svg>
      </div>

      {/* Panel de inspección sincronizado del año bajo cursor o fijado */}
      {inspectedData && (
        <div
          id="cnmc-chart-inspector"
          className="cnmc-inspector-bar"
          aria-live="polite"
        >
          <div className="cnmc-inspector-head">
            <div className="cnmc-inspector-year-group">
              <span className="cnmc-inspector-year mono">{inspectedData.year}</span>
              <span className="cnmc-inspector-hint">
                {inspectedData.isPinned
                  ? 'Año fijado · Pulsa de nuevo o mueve el puntero para cambiar'
                  : 'Pasa el cursor o pulsa sobre cualquier año para fijar el detalle'}
              </span>
            </div>
            {inspectedData.totalPt && inspectedData.totalPt.value !== null && (
              <div className="cnmc-inspector-total mono">
                <span className="cnmc-inspector-total-label">Total sector:</span>{' '}
                <strong>
                  {formatCnmcValue(
                    inspectedData.totalPt.value,
                    view.metric.key,
                    true,
                  )}
                </strong>
                {inspectedData.totalPt.yoyPct !== null && (
                  <span
                    className={`cnmc-delta-chip ${
                      inspectedData.totalPt.yoyPct > 0
                        ? 'is-up'
                        : inspectedData.totalPt.yoyPct < 0
                          ? 'is-down'
                          : ''
                    }`}
                  >
                    {formatCnmcDeltaPct(inspectedData.totalPt.yoyPct)} YoY
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="cnmc-inspector-grid">
            {inspectedData.rows.map((row) => (
              <button
                key={row.key}
                type="button"
                className="cnmc-inspector-item"
                onClick={() => onToggleSeries(row.key)}
                title={`Ocultar o alternar ${row.label}`}
              >
                <span className="cnmc-inspector-item-top">
                  <span
                    className="cnmc-series-dot"
                    style={{ backgroundColor: row.color }}
                    aria-hidden="true"
                  />
                  <span className="cnmc-inspector-item-name">{row.label}</span>
                </span>
                <span className="cnmc-inspector-item-val mono">
                  {chartMode === 'indexed' && row.indexedValue !== null
                    ? `${row.indexedValue.toLocaleString('es-ES', {
                        minimumFractionDigits: 1,
                        maximumFractionDigits: 1,
                      })} pts`
                    : formatCnmcValue(row.value, view.metric.key, true)}
                </span>
                <span className="cnmc-inspector-item-meta mono">
                  {row.sharePct !== null && (
                    <span>{formatCnmcSharePct(row.sharePct)} cuota</span>
                  )}
                  {row.yoyPct !== null && (
                    <span
                      className={
                        row.yoyPct > 0
                          ? 'is-up'
                          : row.yoyPct < 0
                            ? 'is-down'
                            : ''
                      }
                    >
                      {formatCnmcDeltaPct(row.yoyPct)}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
