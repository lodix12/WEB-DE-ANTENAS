import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CNMC_CHART_MODE_OPTIONS,
  CNMC_MARKET_OPTIONS,
  CNMC_METRIC_META,
  CNMC_METRIC_ORDER,
  CNMC_NA_SERIES_KEY,
  formatCnmcSeriesLabel,
  resolveCnmcSeriesColor,
  type CnmcAnnualPoint,
  type CnmcChartMode,
  type CnmcChartSeries,
  type CnmcDatasetPayload,
  type CnmcMarketFilter,
  type CnmcMetricKey,
  type CnmcNormalizedRecord,
  type CnmcPeriodKpis,
  type CnmcRouteSearch,
  type CnmcSeriesViewModel,
} from '../types/cnmc';
import { fetchCnmcAnnualDataset } from '../utils/cnmcApi';

export const CNMC_ANNUAL_QUERY_KEY = ['cnmc-telecom-anual'] as const;

const VALID_METRICS = new Set<string>(CNMC_METRIC_ORDER);
const VALID_MARKETS = new Set<string>(CNMC_MARKET_OPTIONS.map((m) => m.id));
const VALID_CHART_MODES = new Set<string>(
  CNMC_CHART_MODE_OPTIONS.map((m) => m.id),
);

const ES_INT_FORMAT = new Intl.NumberFormat('es-ES', {
  useGrouping: 'always',
  maximumFractionDigits: 0,
});

const ES_DEC2_FORMAT = new Intl.NumberFormat('es-ES', {
  useGrouping: 'always',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const ES_DEC1_FORMAT = new Intl.NumberFormat('es-ES', {
  useGrouping: 'always',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

function parseYearParam(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1990 && raw <= 2100) {
    return raw;
  }
  if (typeof raw === 'string' && /^\d{4}$/.test(raw.trim())) {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (parsed >= 1990 && parsed <= 2100) {
      return parsed;
    }
  }
  return undefined;
}

export function validateCnmcSearch(
  search: Record<string, unknown>,
): CnmcRouteSearch {
  const result: CnmcRouteSearch = {};

  if (typeof search.metric === 'string' && VALID_METRICS.has(search.metric)) {
    result.metric = search.metric as CnmcMetricKey;
  }

  const from = parseYearParam(search.from);
  if (from !== undefined) {
    result.from = from;
  }

  const to = parseYearParam(search.to);
  if (to !== undefined) {
    result.to = to;
  }

  if (typeof search.market === 'string' && VALID_MARKETS.has(search.market)) {
    result.market = search.market as CnmcMarketFilter;
  }

  if (typeof search.chart === 'string' && VALID_CHART_MODES.has(search.chart)) {
    result.chart = search.chart as CnmcChartMode;
  }

  if (typeof search.series === 'string' && search.series.trim().length > 0) {
    result.series = search.series.trim();
  }

  if (search.total === '0' || search.total === '1') {
    result.total = search.total;
  }

  return result;
}

function matchesMarketFilter(
  record: CnmcNormalizedRecord,
  metric: CnmcMetricKey,
  market: CnmcMarketFilter,
): boolean {
  if (!CNMC_METRIC_META[metric].supportsMarket || market === 'all') {
    return true;
  }
  const norm = record.tipoDeMercado.toLowerCase();
  if (market === 'minorista') {
    return norm.includes('minorista');
  }
  return norm.includes('mayorista');
}

function getSeriesDimensionKey(
  record: CnmcNormalizedRecord,
  metric: CnmcMetricKey,
): string {
  const field = CNMC_METRIC_META[metric].dimensionField;
  return record[field] || CNMC_NA_SERIES_KEY;
}

export function getMetricAvailableYears(
  records: readonly CnmcNormalizedRecord[],
  metric: CnmcMetricKey,
  market: CnmcMarketFilter = 'all',
): number[] {
  const years = new Set<number>();
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec[metric] === null) continue;
    if (!matchesMarketFilter(rec, metric, market)) continue;
    years.add(rec.anno);
  }
  return Array.from(years).sort((a, b) => a - b);
}

export function clampYearRange(
  requestedFrom: number | undefined,
  requestedTo: number | undefined,
  availableYears: readonly number[],
): { fromYear: number; toYear: number } {
  if (availableYears.length === 0) {
    return { fromYear: 2000, toYear: 2000 };
  }
  const minYear = availableYears[0];
  const maxYear = availableYears[availableYears.length - 1];

  let fromYear =
    requestedFrom !== undefined
      ? Math.min(maxYear, Math.max(minYear, requestedFrom))
      : minYear;
  let toYear =
    requestedTo !== undefined
      ? Math.min(maxYear, Math.max(minYear, requestedTo))
      : maxYear;

  if (fromYear > toYear) {
    const tmp = fromYear;
    fromYear = toYear;
    toYear = tmp;
  }

  return { fromYear, toYear };
}

export interface BuildCnmcSeriesOptions {
  metric: CnmcMetricKey;
  market: CnmcMarketFilter;
  fromYear?: number;
  toYear?: number;
  selectedSeriesKeys?: readonly string[] | null;
}

/**
 * Construye el modelo analítico exacto a partir de los registros de la CNMC
 * sin agrupar artificialmente ningún operador ni servicio que no venga agrupado.
 */
export function buildCnmcSeriesView(
  records: readonly CnmcNormalizedRecord[],
  options: BuildCnmcSeriesOptions,
): CnmcSeriesViewModel {
  const metricDef = CNMC_METRIC_META[options.metric];
  const effectiveMarket: CnmcMarketFilter = metricDef.supportsMarket
    ? options.market
    : 'all';

  const availableYears = getMetricAvailableYears(
    records,
    options.metric,
    effectiveMarket,
  );
  const { fromYear, toYear } = clampYearRange(
    options.fromYear,
    options.toYear,
    availableYears,
  );

  const years = availableYears.filter((y) => y >= fromYear && y <= toYear);
  const yearIndex = new Map<number, number>();
  for (let i = 0; i < years.length; i++) {
    yearIndex.set(years[i], i);
  }

  // Acumular suma exacta por (seriesKey, year) — necesario para market='all' en ingresos_por_operador
  // donde minorista + mayorista suman el total del operador en el año
  const seriesByYearMap = new Map<string, Map<number, number>>();
  const prevYearBeforeRange =
    availableYears.findLast((y) => y < fromYear) ?? null;

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const val = rec[options.metric];
    if (val === null) continue;
    if (!matchesMarketFilter(rec, options.metric, effectiveMarket)) continue;
    if (
      !yearIndex.has(rec.anno) &&
      (prevYearBeforeRange === null || rec.anno !== prevYearBeforeRange)
    ) {
      continue;
    }

    const key = getSeriesDimensionKey(rec, options.metric);
    let yearMap = seriesByYearMap.get(key);
    if (!yearMap) {
      yearMap = new Map<number, number>();
      seriesByYearMap.set(key, yearMap);
    }
    yearMap.set(rec.anno, (yearMap.get(rec.anno) ?? 0) + val);
  }

  // Ordenar series por valor en el último año del rango (descendente), luego por último valor disponible y nombre
  const orderedKeys = Array.from(seriesByYearMap.keys())
    .filter((key) => {
      const ym = seriesByYearMap.get(key)!;
      return years.some((y) => ym.has(y));
    })
    .sort((a, b) => {
      if (a === CNMC_NA_SERIES_KEY && b !== CNMC_NA_SERIES_KEY) return 1;
      if (b === CNMC_NA_SERIES_KEY && a !== CNMC_NA_SERIES_KEY) return -1;
      const mapA = seriesByYearMap.get(a)!;
      const mapB = seriesByYearMap.get(b)!;
      const endA = mapA.get(toYear) ?? -1;
      const endB = mapB.get(toYear) ?? -1;
      if (endA !== endB) return endB - endA;

      let maxA = 0;
      let maxB = 0;
      for (const y of years) {
        const va = mapA.get(y);
        if (va !== undefined && va > maxA) maxA = va;
        const vb = mapB.get(y);
        if (vb !== undefined && vb > maxB) maxB = vb;
      }
      if (maxA !== maxB) return maxB - maxA;
      return a.localeCompare(b, 'es');
    });

  // Calcular totales globales por año (sobre todas las series presentes en el año)
  const sectorTotalsByYear = new Map<number, number>();
  for (let i = 0; i < years.length; i++) {
    const y = years[i];
    let sum = 0;
    let hasAny = false;
    for (let s = 0; s < orderedKeys.length; s++) {
      const val = seriesByYearMap.get(orderedKeys[s])?.get(y);
      if (val !== undefined) {
        sum += val;
        hasAny = true;
      }
    }
    if (hasAny) {
      sectorTotalsByYear.set(y, sum);
    }
  }

  const prevRangeSectorTotal =
    prevYearBeforeRange !== null
      ? (() => {
          let sum = 0;
          let hasAny = false;
          seriesByYearMap.forEach((ym) => {
            const v = ym.get(prevYearBeforeRange);
            if (v !== undefined) {
              sum += v;
              hasAny = true;
            }
          });
          return hasAny ? sum : null;
        })()
      : null;

  let nonKnownColorIndex = 0;
  const allSeries: CnmcChartSeries[] = orderedKeys.map((key) => {
    const color = resolveCnmcSeriesColor(key, nonKnownColorIndex);
    nonKnownColorIndex += 1;
    const yearMap = seriesByYearMap.get(key)!;

    let firstAvailableYear: number | null = null;
    let firstAvailableValue: number | null = null;
    let lastAvailableYear: number | null = null;
    let lastAvailableValue: number | null = null;
    let maxValue = 0;

    for (let i = 0; i < years.length; i++) {
      const y = years[i];
      const v = yearMap.get(y);
      if (v !== undefined) {
        if (firstAvailableYear === null) {
          firstAvailableYear = y;
          firstAvailableValue = v;
        }
        lastAvailableYear = y;
        lastAvailableValue = v;
        if (v > maxValue) maxValue = v;
      }
    }

    const baseForIndex =
      firstAvailableValue !== null && firstAvailableValue > 0
        ? firstAvailableValue
        : null;

    const points: CnmcAnnualPoint[] = years.map((y, idx) => {
      const rawVal = yearMap.get(y);
      const value = rawVal !== undefined ? rawVal : null;
      const sectorTotal = sectorTotalsByYear.get(y) ?? null;

      let prevVal: number | null = null;
      if (idx > 0) {
        const pv = yearMap.get(years[idx - 1]);
        prevVal = pv !== undefined ? pv : null;
      } else if (prevYearBeforeRange !== null) {
        const pv = yearMap.get(prevYearBeforeRange);
        prevVal = pv !== undefined ? pv : null;
      }

      const yoyPct =
        value !== null && prevVal !== null && prevVal !== 0
          ? ((value - prevVal) / Math.abs(prevVal)) * 100
          : null;

      const sharePct =
        value !== null && sectorTotal !== null && sectorTotal > 0
          ? (value / sectorTotal) * 100
          : null;

      const indexedValue =
        value !== null && baseForIndex !== null
          ? (value / baseForIndex) * 100
          : null;

      return {
        year: y,
        value,
        indexedValue,
        yoyPct,
        sharePct,
      };
    });

    const startValue = yearMap.get(fromYear) ?? null;
    const endValue = yearMap.get(toYear) ?? null;
    const deltaAbs =
      startValue !== null && endValue !== null ? endValue - startValue : null;
    const deltaPct =
      deltaAbs !== null && startValue !== null && startValue !== 0
        ? (deltaAbs / Math.abs(startValue)) * 100
        : null;
    const endSectorTotal = sectorTotalsByYear.get(toYear) ?? null;
    const endSharePct =
      endValue !== null && endSectorTotal !== null && endSectorTotal > 0
        ? (endValue / endSectorTotal) * 100
        : null;

    return {
      key,
      label: formatCnmcSeriesLabel(key),
      color,
      isNaAggregate: key === CNMC_NA_SERIES_KEY,
      points,
      startValue,
      endValue,
      firstAvailableYear,
      firstAvailableValue,
      lastAvailableYear,
      lastAvailableValue,
      deltaAbs,
      deltaPct,
      endSharePct,
      maxValue,
    };
  });

  // Selección de series visibles: si el usuario no pasó filtro explícito, seleccionar todas las presentes en el rango
  const requestedSet =
    options.selectedSeriesKeys && options.selectedSeriesKeys.length > 0
      ? new Set(options.selectedSeriesKeys)
      : null;

  const visibleSeries = requestedSet
    ? allSeries.filter((s) => requestedSet.has(s.key))
    : allSeries;

  const effectiveVisible =
    visibleSeries.length > 0 ? visibleSeries : allSeries;

  // Serie Total (suma de todas las series del sector en cada año)
  const firstTotalVal =
    years.length > 0 ? (sectorTotalsByYear.get(years[0]) ?? null) : null;
  const baseTotalForIndex =
    firstTotalVal !== null && firstTotalVal > 0 ? firstTotalVal : null;

  const totalPoints: CnmcAnnualPoint[] = years.map((y, idx) => {
    const val = sectorTotalsByYear.get(y) ?? null;
    const prevVal =
      idx > 0
        ? (sectorTotalsByYear.get(years[idx - 1]) ?? null)
        : prevRangeSectorTotal;
    const yoyPct =
      val !== null && prevVal !== null && prevVal !== 0
        ? ((val - prevVal) / Math.abs(prevVal)) * 100
        : null;
    const indexedValue =
      val !== null && baseTotalForIndex !== null
        ? (val / baseTotalForIndex) * 100
        : null;

    return {
      year: y,
      value: val,
      indexedValue,
      yoyPct,
      sharePct: val !== null ? 100 : null,
    };
  });

  // KPIs calculados sobre la suma de las series visibles (o total sector si todas están visibles)
  const visibleSumByYear = new Map<number, number>();
  for (let i = 0; i < years.length; i++) {
    const y = years[i];
    let sum = 0;
    let hasAny = false;
    for (let s = 0; s < effectiveVisible.length; s++) {
      const pt = effectiveVisible[s].points[i];
      if (pt && pt.value !== null) {
        sum += pt.value;
        hasAny = true;
      }
    }
    if (hasAny) {
      visibleSumByYear.set(y, sum);
    }
  }

  const startTotal = visibleSumByYear.get(fromYear) ?? null;
  const endTotal = visibleSumByYear.get(toYear) ?? null;
  const periodDeltaAbs =
    startTotal !== null && endTotal !== null ? endTotal - startTotal : null;
  const periodDeltaPct =
    periodDeltaAbs !== null && startTotal !== null && startTotal !== 0
      ? (periodDeltaAbs / Math.abs(startTotal)) * 100
      : null;

  const yearSpan = toYear - fromYear;
  const cagrPct =
    yearSpan >= 2 &&
    startTotal !== null &&
    endTotal !== null &&
    startTotal > 0 &&
    endTotal > 0
      ? (Math.pow(endTotal / startTotal, 1 / yearSpan) - 1) * 100
      : null;

  const prevYear = years.length >= 2 ? years[years.length - 2] : prevYearBeforeRange;
  let prevYearTotal: number | null = null;
  if (prevYear !== null) {
    if (visibleSumByYear.has(prevYear)) {
      prevYearTotal = visibleSumByYear.get(prevYear) ?? null;
    } else if (prevYear === prevYearBeforeRange) {
      let sum = 0;
      let hasAny = false;
      for (let s = 0; s < effectiveVisible.length; s++) {
        const v = seriesByYearMap.get(effectiveVisible[s].key)?.get(prevYear);
        if (v !== undefined) {
          sum += v;
          hasAny = true;
        }
      }
      prevYearTotal = hasAny ? sum : null;
    }
  }

  const yoyDeltaAbs =
    endTotal !== null && prevYearTotal !== null
      ? endTotal - prevYearTotal
      : null;
  const yoyDeltaPct =
    yoyDeltaAbs !== null && prevYearTotal !== null && prevYearTotal !== 0
      ? (yoyDeltaAbs / Math.abs(prevYearTotal)) * 100
      : null;

  // Líder del año fin entre series visibles (excluyendo "Resto" solo si hay otro líder? No: mostrar fielmente el mayor valor, priorizando series nombradas si empatan)
  const rankedEndSeries = effectiveVisible
    .filter((s) => s.endValue !== null)
    .sort((a, b) => (b.endValue ?? 0) - (a.endValue ?? 0));
  const leader = rankedEndSeries[0] ?? null;

  const kpis: CnmcPeriodKpis = {
    startYear: fromYear,
    endYear: toYear,
    startTotal,
    endTotal,
    periodDeltaAbs,
    periodDeltaPct,
    cagrPct,
    prevYear,
    prevYearTotal,
    yoyDeltaAbs,
    yoyDeltaPct,
    leaderLabel: leader ? leader.label : null,
    leaderColor: leader ? leader.color : null,
    leaderValue: leader ? leader.endValue : null,
    leaderSharePct: leader ? leader.endSharePct : null,
  };

  return {
    metric: metricDef,
    market: effectiveMarket,
    availableYears,
    years,
    fromYear,
    toYear,
    allSeries,
    visibleSeries: effectiveVisible,
    totalPoints,
    kpis,
  };
}

export function formatCnmcValue(
  value: number | null,
  metricKey: CnmcMetricKey,
  withUnit = true,
): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const def = CNMC_METRIC_META[metricKey];
  const formatted =
    def.decimals === 0
      ? ES_INT_FORMAT.format(Math.round(value))
      : ES_DEC2_FORMAT.format(value);
  return withUnit ? `${formatted} ${def.unitShort}` : formatted;
}

export function formatCnmcAxisTick(
  value: number,
  metricKey: CnmcMetricKey,
  chartMode: CnmcChartMode,
): string {
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value) < 1e-9) return '0';
  if (chartMode === 'indexed') {
    return `${ES_INT_FORMAT.format(Math.round(value))}`;
  }
  const abs = Math.abs(value);
  const def = CNMC_METRIC_META[metricKey];
  if (def.decimals === 0) {
    if (abs >= 1_000_000) {
      const mVal = value / 1_000_000;
      return Math.abs(mVal - Math.round(mVal)) < 0.05
        ? `${ES_INT_FORMAT.format(Math.round(mVal))} M`
        : `${ES_DEC1_FORMAT.format(mVal)} M`;
    }
    if (abs >= 10_000) {
      return `${ES_INT_FORMAT.format(Math.round(value / 1_000))} k`;
    }
    return ES_INT_FORMAT.format(Math.round(value));
  }
  if (abs >= 100 || Math.abs(value - Math.round(value)) < 1e-6) {
    return `${ES_INT_FORMAT.format(Math.round(value))}`;
  }
  return ES_DEC1_FORMAT.format(value);
}

export function formatCnmcDeltaPct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return '—';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${ES_DEC1_FORMAT.format(pct)}%`;
}

export function formatCnmcSharePct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return '—';
  return `${ES_DEC1_FORMAT.format(pct)}%`;
}

export function formatCnmcDateEs(isoOrYmd: string): string {
  if (!isoOrYmd) return '—';
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(isoOrYmd)
    ? `${isoOrYmd}T12:00:00Z`
    : isoOrYmd;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return isoOrYmd;
  return new Intl.DateTimeFormat('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

function escapeCsvCell(value: string | number): string {
  const str = String(value);
  if (/[",\n\r;]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildCnmcCsvContent(view: CnmcSeriesViewModel): string {
  const header = [
    'Año',
    ...view.visibleSeries.map((s) => `${s.label} (${view.metric.unitShort})`),
    `Total sector (${view.metric.unitShort})`,
  ];

  const lines: string[] = [header.map(escapeCsvCell).join(';')];
  for (let i = 0; i < view.years.length; i++) {
    const year = view.years[i];
    const row: Array<string | number> = [year];
    for (let s = 0; s < view.visibleSeries.length; s++) {
      const val = view.visibleSeries[s].points[i]?.value;
      row.push(val === null || val === undefined ? '' : val);
    }
    const tot = view.totalPoints[i]?.value;
    row.push(tot === null || tot === undefined ? '' : tot);
    lines.push(row.map(escapeCsvCell).join(';'));
  }

  return `\uFEFF${lines.join('\r\n')}`;
}

export function buildCnmcJsonExportPayload(
  view: CnmcSeriesViewModel,
  dataset: CnmcDatasetPayload,
) {
  return {
    fuente: 'CNMC|Data — Telecomunicaciones Anual Datos Generales',
    datasetName: dataset.metadata.datasetName,
    version: dataset.metadata.version,
    resourceId: dataset.metadata.resourceId,
    actualizadoCnmc: dataset.metadata.modified || dataset.metadata.metadataModified,
    origenConsulta: dataset.source,
    parametro: view.metric.key,
    parametroEtiqueta: view.metric.label,
    unidad: view.metric.unitLabel,
    mercado: view.market,
    rangoAnual: {
      inicio: view.fromYear,
      fin: view.toYear,
    },
    series: view.visibleSeries.map((s) => ({
      serie: s.key,
      etiqueta: s.label,
      valores: s.points.map((p) => ({
        anno: p.year,
        valor: p.value,
        cuotaPct: p.sharePct !== null ? Number(p.sharePct.toFixed(2)) : null,
        variacionInteranualPct:
          p.yoyPct !== null ? Number(p.yoyPct.toFixed(2)) : null,
      })),
    })),
    totalSector: view.totalPoints.map((p) => ({
      anno: p.year,
      valor: p.value,
      variacionInteranualPct:
        p.yoyPct !== null ? Number(p.yoyPct.toFixed(2)) : null,
    })),
  };
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function exportCnmcCsv(view: CnmcSeriesViewModel): void {
  const csv = buildCnmcCsvContent(view);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(
    blob,
    `cnmc-${view.metric.key}-${view.fromYear}-${view.toYear}.csv`,
  );
}

export function exportCnmcJson(
  view: CnmcSeriesViewModel,
  dataset: CnmcDatasetPayload,
): void {
  const payload = buildCnmcJsonExportPayload(view, dataset);
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json;charset=utf-8;',
  });
  triggerDownload(
    blob,
    `cnmc-${view.metric.key}-${view.fromYear}-${view.toYear}.json`,
  );
}

export function useCnmcData() {
  const queryClient = useQueryClient();

  const query = useQuery<CnmcDatasetPayload>({
    queryKey: CNMC_ANNUAL_QUERY_KEY,
    queryFn: ({ signal }) => fetchCnmcAnnualDataset({ signal }),
    staleTime: 30 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const forceRefresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: CNMC_ANNUAL_QUERY_KEY });
    return query.refetch();
  }, [queryClient, query]);

  return {
    ...query,
    dataset: query.data ?? null,
    forceRefresh,
  };
}
