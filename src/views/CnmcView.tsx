import { useEffect, useMemo, useState } from 'react';
import { useSearch } from '@tanstack/react-router';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpDown,
  ArrowUpRight,
  BarChart3,
  CheckCircle2,
  Database,
  Download,
  ExternalLink,
  RefreshCw,
} from 'lucide-react';
import { CnmcAnnualChart } from '../components/cnmc/CnmcAnnualChart';
import { CnmcYearRangeControl } from '../components/cnmc/CnmcYearRangeControl';
import {
  buildCnmcSeriesView,
  exportCnmcCsv,
  exportCnmcJson,
  formatCnmcDateEs,
  formatCnmcDeltaPct,
  formatCnmcSharePct,
  formatCnmcValue,
  getMetricAvailableYears,
  useCnmcData,
  validateCnmcSearch,
} from '../hooks/useCnmcData';
import {
  CNMC_CHART_MODE_OPTIONS,
  CNMC_MARKET_OPTIONS,
  CNMC_METRIC_META,
  CNMC_METRIC_ORDER,
  type CnmcChartMode,
  type CnmcMarketFilter,
  type CnmcMetricKey,
} from '../types/cnmc';
import { formatDateTimeEs } from '../utils/export';
import '../styles/cnmc.css';

const AUTO_TOP_SERIES_LIMIT = 6;

function parseSeriesSearchParam(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const tokens = raw
    .split('|')
    .map((t) => t.trim())
    .filter(Boolean);
  return tokens.length > 0 ? tokens : null;
}

export function CnmcView() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const initialSearch = useMemo(
    () => validateCnmcSearch(rawSearch),
    [rawSearch],
  );

  const [activeMetric, setActiveMetric] = useState<CnmcMetricKey>(
    () => initialSearch.metric ?? 'ingresos_por_operador',
  );
  const [activeMarket, setActiveMarket] = useState<CnmcMarketFilter>(
    () => initialSearch.market ?? 'all',
  );
  const [chartMode, setChartMode] = useState<CnmcChartMode>(
    () => initialSearch.chart ?? 'line',
  );
  const [showTotalLine, setShowTotalLine] = useState<boolean>(
    () => initialSearch.total !== '0',
  );
  const [requestedFromYear, setRequestedFromYear] = useState<
    number | undefined
  >(() => initialSearch.from);
  const [requestedToYear, setRequestedToYear] = useState<number | undefined>(
    () => initialSearch.to,
  );
  const [selectedSeriesKeys, setSelectedSeriesKeys] = useState<string[] | null>(
    () => parseSeriesSearchParam(initialSearch.series),
  );
  const [tableDescending, setTableDescending] = useState(true);

  const {
    dataset,
    isLoading,
    isFetching,
    isError,
    error,
    forceRefresh,
  } = useCnmcData();

  useEffect(() => {
    document.title =
      'CNMC · Telecomunicaciones Anual · Datos Oficiales API · Redes Moviles España';
  }, []);

  // Vista completa sin filtrar series para conocer todas las series disponibles y aplicar defaults legibles
  const baseView = useMemo(() => {
    if (!dataset) return null;
    return buildCnmcSeriesView(dataset.records, {
      metric: activeMetric,
      market: activeMarket,
      fromYear: requestedFromYear,
      toYear: requestedToYear,
      selectedSeriesKeys: null,
    });
  }, [dataset, activeMetric, activeMarket, requestedFromYear, requestedToYear]);

  // Selección efectiva de series: si el usuario no ha tocado selección y hay > 8 series, mostrar Top 6 por defecto
  const effectiveSelectedKeys = useMemo<string[] | null>(() => {
    if (!baseView) return null;
    if (selectedSeriesKeys !== null) {
      const valid = selectedSeriesKeys.filter((k) =>
        baseView.allSeries.some((s) => s.key === k),
      );
      if (valid.length > 0) return valid;
    }
    if (baseView.allSeries.length > 8) {
      return baseView.allSeries
        .slice(0, AUTO_TOP_SERIES_LIMIT)
        .map((s) => s.key);
    }
    return null;
  }, [baseView, selectedSeriesKeys]);

  const view = useMemo(() => {
    if (!dataset) return null;
    return buildCnmcSeriesView(dataset.records, {
      metric: activeMetric,
      market: activeMarket,
      fromYear: requestedFromYear,
      toYear: requestedToYear,
      selectedSeriesKeys: effectiveSelectedKeys,
    });
  }, [
    dataset,
    activeMetric,
    activeMarket,
    requestedFromYear,
    requestedToYear,
    effectiveSelectedKeys,
  ]);

  const activeKeySet = useMemo(
    () => new Set(view ? view.visibleSeries.map((s) => s.key) : []),
    [view],
  );

  function handleSelectMetric(nextMetric: CnmcMetricKey) {
    if (nextMetric === activeMetric) return;
    setActiveMetric(nextMetric);
    setSelectedSeriesKeys(null);
    if (!CNMC_METRIC_META[nextMetric].supportsMarket) {
      setActiveMarket('all');
    }
    if (dataset) {
      const nextYears = getMetricAvailableYears(
        dataset.records,
        nextMetric,
        CNMC_METRIC_META[nextMetric].supportsMarket ? activeMarket : 'all',
      );
      if (nextYears.length > 0) {
        const minY = nextYears[0];
        const maxY = nextYears[nextYears.length - 1];
        if (requestedFromYear !== undefined && requestedFromYear < minY) {
          setRequestedFromYear(minY);
        }
        if (requestedToYear !== undefined && requestedToYear > maxY) {
          setRequestedToYear(maxY);
        }
      }
    }
  }

  function handleSelectMarket(nextMarket: CnmcMarketFilter) {
    if (nextMarket === activeMarket) return;
    setActiveMarket(nextMarket);
    setSelectedSeriesKeys(null);
  }

  function handleChangeRange(nextFrom: number, nextTo: number) {
    setRequestedFromYear(nextFrom);
    setRequestedToYear(nextTo);
  }

  function handleToggleSeries(seriesKey: string) {
    if (!view) return;
    const currentVisibleKeys = view.visibleSeries.map((s) => s.key);
    const hasKey = currentVisibleKeys.includes(seriesKey);
    if (hasKey) {
      if (currentVisibleKeys.length <= 1) {
        return;
      }
      setSelectedSeriesKeys(currentVisibleKeys.filter((k) => k !== seriesKey));
    } else {
      setSelectedSeriesKeys([...currentVisibleKeys, seriesKey]);
    }
  }

  function handleSelectAllSeries() {
    if (!view) return;
    setSelectedSeriesKeys(view.allSeries.map((s) => s.key));
  }

  function handleSelectTop5Series() {
    if (!view) return;
    setSelectedSeriesKeys(view.allSeries.slice(0, 5).map((s) => s.key));
  }

  const orderedTableIndices = useMemo(() => {
    if (!view) return [];
    const list = view.years.map((_, idx) => idx);
    return tableDescending ? list.reverse() : list;
  }, [view, tableDescending]);

  const shareRankingSeries = useMemo(() => {
    if (!view) return [];
    return [...view.visibleSeries].sort(
      (a, b) => (b.endValue ?? -1) - (a.endValue ?? -1),
    );
  }, [view]);

  if (isLoading && !dataset) {
    return (
      <main className="page-container cnmc-page">
        <div className="cnmc-card state-center-box">
          <div className="spinner-ring" aria-hidden="true" />
          <h1 className="cnmc-loading-title">
            Consultando API de CNMC|Data…
          </h1>
          <p className="cnmc-loading-sub">
            Ejecutando consulta CKAN en 2 pasos (catálogo + datastore anual)
          </p>
        </div>
      </main>
    );
  }

  if ((isError && !dataset) || !dataset || !view) {
    return (
      <main className="page-container cnmc-page">
        <div className="cnmc-card state-center-box">
          <AlertTriangle size={28} className="cnmc-error-icon" aria-hidden="true" />
          <h1 className="cnmc-loading-title">
            No se pudieron cargar los datos de la CNMC
          </h1>
          <p className="cnmc-error-msg">
            {error instanceof Error
              ? error.message
              : 'Error al consultar la API oficial y el respaldo estático.'}
          </p>
          <button
            type="button"
            id="cnmc-retry-btn"
            className="btn btn-primary btn-sm"
            onClick={() => void forceRefresh()}
          >
            <RefreshCw size={14} aria-hidden="true" />
            <span>Reintentar conexión</span>
          </button>
        </div>
      </main>
    );
  }

  const { metadata } = dataset;
  const isAllSeriesSelected =
    view.visibleSeries.length === view.allSeries.length;
  const kpis = view.kpis;
  const maxShareValue =
    shareRankingSeries.reduce(
      (acc, s) => Math.max(acc, s.endValue ?? 0),
      0,
    ) || 1;

  return (
    <main className="page-container cnmc-page">
      {/* Cabecera y estado en directo de la API CNMC */}
      <header className="cnmc-hero">
        <div className="cnmc-hero-copy">
          <div className="cnmc-hero-eyebrow">
            <BarChart3 size={16} aria-hidden="true" />
            <span>CNMC|Data · Datos Abiertos Oficiales</span>
          </div>
          <h1 className="cnmc-hero-title">CNMC · Telecomunicaciones Anual</h1>
          <p className="cnmc-hero-sub">
            Evolución anual oficial de ingresos, inversiones, gastos de
            explotación, empleados y paquetes en España (
            <span className="mono">
              {metadata.periodo || `${view.availableYears[0]}–${view.availableYears[view.availableYears.length - 1]}`}
            </span>
            ). Datos consultados directamente mediante la API CKAN en 2 pasos.
          </p>
        </div>

        <div className="cnmc-hero-actions">
          <div
            id="cnmc-source-status"
            className={`cnmc-status-pill is-${dataset.source}`}
            title={
              dataset.source === 'live'
                ? `Sincronizado en directo el ${formatDateTimeEs(dataset.fetchedAt)}`
                : dataset.liveError || 'Mostrando copia de respaldo'
            }
          >
            {dataset.source === 'live' ? (
              <CheckCircle2 size={14} aria-hidden="true" />
            ) : (
              <AlertTriangle size={14} aria-hidden="true" />
            )}
            <span>
              {dataset.source === 'live'
                ? 'API CNMC en directo'
                : dataset.source === 'cache'
                  ? 'Caché local (CNMC sin respuesta)'
                  : 'Respaldo estático (CNMC sin respuesta)'}
            </span>
          </div>

          <div className="cnmc-hero-btn-row">
            <button
              type="button"
              id="cnmc-sync-btn"
              className="btn btn-secondary btn-sm"
              disabled={isFetching}
              onClick={() => void forceRefresh()}
            >
              <RefreshCw
                size={14}
                className={isFetching ? 'cnmc-spin' : undefined}
                aria-hidden="true"
              />
              <span>{isFetching ? 'Sincronizando…' : 'Sincronizar API'}</span>
            </button>

            <a
              href={metadata.portalUrl}
              target="_blank"
              rel="noopener noreferrer"
              id="cnmc-portal-link"
              className="btn btn-secondary btn-sm"
            >
              <span>Portal CNMC</span>
              <ExternalLink size={13} aria-hidden="true" />
            </a>
          </div>

          <div className="cnmc-meta-inline mono">
            <span>
              Actualizado CNMC:{' '}
              <strong>
                {formatCnmcDateEs(metadata.modified || metadata.metadataModified)}
              </strong>
            </span>
            {metadata.version && (
              <>
                <span aria-hidden="true">·</span>
                <span>v{metadata.version}</span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span>{dataset.records.length.toLocaleString('es-ES')} registros</span>
          </div>
        </div>
      </header>

      {/* Aviso no bloqueante cuando se está sirviendo el respaldo */}
      {dataset.source !== 'live' && (
        <div
          id="cnmc-fallback-banner"
          className="cnmc-fallback-banner"
          role="status"
        >
          <AlertTriangle size={16} aria-hidden="true" />
          <div className="cnmc-fallback-copy">
            <strong>
              La API de CNMC|Data no responde temporalmente.
            </strong>{' '}
            Se está mostrando el respaldo de datos oficiales (actualizado el{' '}
            <span className="mono">
              {formatCnmcDateEs(metadata.modified || dataset.fetchedAt)}
            </span>
            ).
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={isFetching}
            onClick={() => void forceRefresh()}
          >
            Reintentar API
          </button>
        </div>
      )}

      {/* Tarjeta de Controles: Parámetro, Mercado, Año inicio/fin y Series */}
      <section
        id="cnmc-controls-card"
        className="cnmc-card cnmc-controls-card"
        aria-label="Parámetros y filtros temporales CNMC"
      >
        {/* Pestañas de los 6 parámetros */}
        <div className="cnmc-tabs-header">
          <div
            className="cnmc-underline-tabs"
            role="tablist"
            aria-label="Parámetro anual de la CNMC"
          >
            {CNMC_METRIC_ORDER.map((metricKey) => {
              const def = CNMC_METRIC_META[metricKey];
              const isActive = activeMetric === metricKey;
              return (
                <button
                  key={metricKey}
                  type="button"
                  role="tab"
                  id={`cnmc-metric-tab-${metricKey}`}
                  className={`cnmc-underline-tab${isActive ? ' is-active' : ''}`}
                  aria-selected={isActive}
                  onClick={() => handleSelectMetric(metricKey)}
                >
                  <span>{def.label}</span>
                  <span className="cnmc-tab-unit mono">{def.unitShort}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="cnmc-controls-body">
          {/* Descripción + Filtro de mercado si aplica */}
          <div className="cnmc-metric-info-row">
            <p className="cnmc-metric-desc">{view.metric.description}</p>

            {view.metric.supportsMarket && (
              <div
                className="cnmc-segmented"
                role="group"
                aria-label="Filtrar por tipo de mercado"
              >
                {CNMC_MARKET_OPTIONS.map((opt) => {
                  const isActive = activeMarket === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      id={`cnmc-market-${opt.id}`}
                      className={`cnmc-segmented-btn${isActive ? ' is-active' : ''}`}
                      aria-pressed={isActive}
                      onClick={() => handleSelectMarket(opt.id)}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Selector sincronizado de Año Inicio y Año Fin */}
          <CnmcYearRangeControl
            availableYears={view.availableYears}
            fromYear={view.fromYear}
            toYear={view.toYear}
            onChangeRange={handleChangeRange}
          />

          {/* Selector de series/operadores/servicios */}
          <div className="cnmc-series-selector">
            <div className="cnmc-series-selector-head">
              <div className="cnmc-series-selector-title">
                <span className="cnmc-control-heading">
                  {view.metric.dimensionLabel}
                </span>
                <span className="cnmc-series-count mono">
                  {view.visibleSeries.length}/{view.allSeries.length} activas
                </span>
              </div>
              <div className="cnmc-series-actions">
                <button
                  type="button"
                  id="cnmc-series-select-all"
                  className={`cnmc-mini-btn${isAllSeriesSelected ? ' is-active' : ''}`}
                  onClick={handleSelectAllSeries}
                >
                  Todas
                </button>
                {view.allSeries.length > 5 && (
                  <button
                    type="button"
                    id="cnmc-series-select-top5"
                    className="cnmc-mini-btn"
                    onClick={handleSelectTop5Series}
                  >
                    Top 5 ({view.toYear})
                  </button>
                )}
              </div>
            </div>

            <div
              className="cnmc-series-pills"
              role="group"
              aria-label={`Seleccionar series de ${view.metric.dimensionLabel}`}
            >
              {view.allSeries.map((s) => {
                const isSelected = activeKeySet.has(s.key);
                return (
                  <button
                    key={s.key}
                    type="button"
                    className={`cnmc-series-pill${isSelected ? ' is-selected' : ''}`}
                    aria-pressed={isSelected}
                    onClick={() => handleToggleSeries(s.key)}
                  >
                    <span
                      className="cnmc-series-dot"
                      style={{ backgroundColor: s.color }}
                      aria-hidden="true"
                    />
                    <span className="cnmc-series-pill-label">{s.label}</span>
                    {s.endValue !== null && (
                      <span className="cnmc-series-pill-val mono">
                        {formatCnmcValue(s.endValue, view.metric.key, false)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* Banda de 4 KPIs del periodo seleccionado */}
      <section
        id="cnmc-kpi-strip"
        className="cnmc-kpi-grid"
        aria-label={`Resumen del periodo ${view.fromYear} a ${view.toYear}`}
      >
        <article className="cnmc-card cnmc-kpi-card">
          <span className="cnmc-kpi-label">
            {isAllSeriesSelected ? 'Total sector' : 'Suma selección'} ({kpis.endYear})
          </span>
          <strong className="cnmc-kpi-value mono">
            {formatCnmcValue(kpis.endTotal, view.metric.key, true)}
          </strong>
          <span className="cnmc-kpi-sub mono">
            {kpis.startYear !== kpis.endYear && kpis.startTotal !== null
              ? `En ${kpis.startYear}: ${formatCnmcValue(kpis.startTotal, view.metric.key, true)}`
              : `Unidad: ${view.metric.unitLabel}`}
          </span>
        </article>

        <article className="cnmc-card cnmc-kpi-card">
          <span className="cnmc-kpi-label">
            Cambio periodo ({kpis.startYear} → {kpis.endYear})
          </span>
          <strong
            className={`cnmc-kpi-value mono ${
              kpis.periodDeltaPct !== null && kpis.periodDeltaPct > 0
                ? 'is-up'
                : kpis.periodDeltaPct !== null && kpis.periodDeltaPct < 0
                  ? 'is-down'
                  : ''
            }`}
          >
            {kpis.periodDeltaPct !== null && (
              <span className="cnmc-kpi-arrow" aria-hidden="true">
                {kpis.periodDeltaPct >= 0 ? (
                  <ArrowUpRight size={18} />
                ) : (
                  <ArrowDownRight size={18} />
                )}
              </span>
            )}
            <span>{formatCnmcDeltaPct(kpis.periodDeltaPct)}</span>
          </strong>
          <span className="cnmc-kpi-sub mono">
            {kpis.periodDeltaAbs !== null
              ? `${kpis.periodDeltaAbs > 0 ? '+' : ''}${formatCnmcValue(kpis.periodDeltaAbs, view.metric.key, true)}`
              : 'Selecciona un rango ≥ 2 años'}
            {kpis.cagrPct !== null
              ? ` · CAGR ${formatCnmcDeltaPct(kpis.cagrPct)}/año`
              : ''}
          </span>
        </article>

        <article className="cnmc-card cnmc-kpi-card">
          <span className="cnmc-kpi-label">
            Variación interanual (
            {kpis.prevYear !== null
              ? `${kpis.prevYear} → ${kpis.endYear}`
              : kpis.endYear}
            )
          </span>
          <strong
            className={`cnmc-kpi-value mono ${
              kpis.yoyDeltaPct !== null && kpis.yoyDeltaPct > 0
                ? 'is-up'
                : kpis.yoyDeltaPct !== null && kpis.yoyDeltaPct < 0
                  ? 'is-down'
                  : ''
            }`}
          >
            {kpis.yoyDeltaPct !== null && (
              <span className="cnmc-kpi-arrow" aria-hidden="true">
                {kpis.yoyDeltaPct >= 0 ? (
                  <ArrowUpRight size={18} />
                ) : (
                  <ArrowDownRight size={18} />
                )}
              </span>
            )}
            <span>{formatCnmcDeltaPct(kpis.yoyDeltaPct)}</span>
          </strong>
          <span className="cnmc-kpi-sub mono">
            {kpis.yoyDeltaAbs !== null
              ? `${kpis.yoyDeltaAbs > 0 ? '+' : ''}${formatCnmcValue(kpis.yoyDeltaAbs, view.metric.key, true)}`
              : 'Sin año previo comparable'}
          </span>
        </article>

        <article className="cnmc-card cnmc-kpi-card">
          <span className="cnmc-kpi-label">Mayor valor en {kpis.endYear}</span>
          <strong className="cnmc-kpi-value cnmc-kpi-leader">
            {kpis.leaderColor && (
              <span
                className="cnmc-series-dot is-lg"
                style={{ backgroundColor: kpis.leaderColor }}
                aria-hidden="true"
              />
            )}
            <span className="cnmc-kpi-leader-name">
              {kpis.leaderLabel ?? '—'}
            </span>
          </strong>
          <span className="cnmc-kpi-sub mono">
            {kpis.leaderValue !== null
              ? `${formatCnmcValue(kpis.leaderValue, view.metric.key, true)} · ${formatCnmcSharePct(kpis.leaderSharePct)} del sector`
              : 'Sin dato en el año fin'}
          </span>
        </article>
      </section>

      {/* Tarjeta Principal: Gráfica Anual Interactiva */}
      <section
        id="cnmc-chart-card"
        className="cnmc-card cnmc-chart-card"
        aria-labelledby="cnmc-chart-heading"
      >
        <div className="cnmc-card-head">
          <div className="cnmc-card-head-copy">
            <h2 id="cnmc-chart-heading" className="cnmc-section-title">
              Evolución anual · {view.metric.label}
            </h2>
            <span className="cnmc-card-head-sub mono">
              {view.fromYear === view.toYear
                ? `Año ${view.toYear}`
                : `${view.fromYear} – ${view.toYear}`}{' '}
              ·{' '}
              {chartMode === 'indexed'
                ? 'Índice Base 100 (primer año disponible en el rango = 100)'
                : view.metric.unitLabel}
            </span>
          </div>

          <div className="cnmc-chart-toolbar">
            <div
              className="cnmc-segmented"
              role="group"
              aria-label="Modo de visualización de la gráfica"
            >
              {CNMC_CHART_MODE_OPTIONS.map((opt) => {
                const isActive = chartMode === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    id={`cnmc-chart-mode-${opt.id}`}
                    className={`cnmc-segmented-btn${isActive ? ' is-active' : ''}`}
                    aria-pressed={isActive}
                    onClick={() => setChartMode(opt.id)}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            {(chartMode === 'line' || chartMode === 'indexed') && (
              <label className="cnmc-total-toggle">
                <input
                  type="checkbox"
                  id="cnmc-toggle-total-line"
                  checked={showTotalLine}
                  onChange={(e) => setShowTotalLine(e.target.checked)}
                />
                <span>Línea Total</span>
              </label>
            )}

            <div className="cnmc-export-group">
              <button
                type="button"
                id="cnmc-export-csv"
                className="btn btn-secondary btn-sm"
                onClick={() => exportCnmcCsv(view)}
              >
                <Download size={13} aria-hidden="true" />
                <span>CSV</span>
              </button>
              <button
                type="button"
                id="cnmc-export-json"
                className="btn btn-secondary btn-sm"
                onClick={() => exportCnmcJson(view, dataset)}
              >
                <Download size={13} aria-hidden="true" />
                <span>JSON</span>
              </button>
            </div>
          </div>
        </div>

        <CnmcAnnualChart
          view={view}
          chartMode={chartMode}
          showTotalLine={showTotalLine}
          onToggleSeries={handleToggleSeries}
        />
      </section>

      {/* Tarjeta de Comparativa de Cuota (Año Inicio vs Año Fin) */}
      <section
        id="cnmc-share-card"
        className="cnmc-card cnmc-share-card"
        aria-labelledby="cnmc-share-heading"
      >
        <div className="cnmc-card-head">
          <div className="cnmc-card-head-copy">
            <h2 id="cnmc-share-heading" className="cnmc-section-title">
              Reparto en {view.toYear} y variación desde {view.fromYear}
            </h2>
            <span className="cnmc-card-head-sub">
              Cuota sobre el total del sector en {view.toYear} y cambio relativo
              frente a {view.fromYear}
            </span>
          </div>
        </div>

        <div className="cnmc-share-list">
          {shareRankingSeries.map((s) => {
            const barWidthPct =
              s.endValue !== null
                ? Math.min(100, Math.max(1.5, (s.endValue / maxShareValue) * 100))
                : 0;
            return (
              <div key={s.key} className="cnmc-share-row">
                <div className="cnmc-share-row-head">
                  <div className="cnmc-share-row-label">
                    <span
                      className="cnmc-series-dot"
                      style={{ backgroundColor: s.color }}
                      aria-hidden="true"
                    />
                    <span className="cnmc-share-name">{s.label}</span>
                  </div>
                  <div className="cnmc-share-row-nums mono">
                    <strong>
                      {formatCnmcValue(s.endValue, view.metric.key, true)}
                    </strong>
                    <span className="cnmc-share-pct">
                      {s.endSharePct !== null
                        ? formatCnmcSharePct(s.endSharePct)
                        : 'Sin dato'}
                    </span>
                    {view.fromYear !== view.toYear && (
                      <span
                        className={`cnmc-delta-chip ${
                          s.deltaPct !== null && s.deltaPct > 0
                            ? 'is-up'
                            : s.deltaPct !== null && s.deltaPct < 0
                              ? 'is-down'
                              : ''
                        }`}
                      >
                        {s.deltaPct !== null
                          ? formatCnmcDeltaPct(s.deltaPct)
                          : s.startValue === null && s.endValue !== null
                            ? `Sin dato ${view.fromYear}`
                            : '—'}
                      </span>
                    )}
                  </div>
                </div>
                <div className="cnmc-share-bar-track">
                  <div
                    className="cnmc-share-bar-fill"
                    style={{
                      width: `${barWidthPct}%`,
                      backgroundColor: s.color,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Tarjeta de Tabla Anual Detallada */}
      <section
        id="cnmc-table-card"
        className="cnmc-card cnmc-table-card"
        aria-labelledby="cnmc-table-heading"
      >
        <div className="cnmc-card-head">
          <div className="cnmc-card-head-copy">
            <h2 id="cnmc-table-heading" className="cnmc-section-title">
              Serie histórica anual ({view.years.length}{' '}
              {view.years.length === 1 ? 'año' : 'años'})
            </h2>
            <span className="cnmc-card-head-sub">
              Valores exactos oficiales de la CNMC en {view.metric.unitLabel}
            </span>
          </div>

          <button
            type="button"
            id="cnmc-table-sort-btn"
            className="btn btn-secondary btn-sm"
            onClick={() => setTableDescending((prev) => !prev)}
          >
            <ArrowUpDown size={13} aria-hidden="true" />
            <span>
              {tableDescending ? 'Más recientes primero' : 'Cronológico ascendente'}
            </span>
          </button>
        </div>

        <div className="cnmc-table-scroll">
          <table className="cnmc-data-table">
            <thead>
              <tr>
                <th scope="col" className="cnmc-col-year">
                  Año
                </th>
                {view.visibleSeries.map((s) => (
                  <th key={s.key} scope="col" className="cnmc-col-num">
                    <span className="cnmc-th-series">
                      <span
                        className="cnmc-series-dot"
                        style={{ backgroundColor: s.color }}
                        aria-hidden="true"
                      />
                      <span>{s.label}</span>
                    </span>
                  </th>
                ))}
                <th scope="col" className="cnmc-col-num cnmc-col-total">
                  Total sector
                </th>
                <th scope="col" className="cnmc-col-num">
                  YoY %
                </th>
              </tr>
            </thead>
            <tbody>
              {orderedTableIndices.map((idx) => {
                const year = view.years[idx];
                const totalPt = view.totalPoints[idx];
                return (
                  <tr key={year}>
                    <td className="cnmc-col-year mono">
                      <strong>{year}</strong>
                    </td>
                    {view.visibleSeries.map((s) => {
                      const val = s.points[idx]?.value ?? null;
                      return (
                        <td key={s.key} className="cnmc-col-num mono">
                          {formatCnmcValue(val, view.metric.key, false)}
                        </td>
                      );
                    })}
                    <td className="cnmc-col-num cnmc-col-total mono">
                      <strong>
                        {formatCnmcValue(
                          totalPt?.value ?? null,
                          view.metric.key,
                          false,
                        )}
                      </strong>
                    </td>
                    <td className="cnmc-col-num mono">
                      <span
                        className={`cnmc-delta-text ${
                          totalPt?.yoyPct !== null &&
                          totalPt?.yoyPct !== undefined &&
                          totalPt.yoyPct > 0
                            ? 'is-up'
                            : totalPt?.yoyPct !== null &&
                                totalPt?.yoyPct !== undefined &&
                                totalPt.yoyPct < 0
                              ? 'is-down'
                              : ''
                        }`}
                      >
                        {formatCnmcDeltaPct(totalPt?.yoyPct ?? null)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Detalles técnicos colapsables de la API en 2 pasos */}
      <details id="cnmc-api-details" className="cnmc-card cnmc-api-details">
        <summary className="cnmc-api-details-summary">
          <Database size={15} aria-hidden="true" />
          <span>Detalles de la conexión API CKAN de CNMC|Data (2 pasos)</span>
          <span className="cnmc-api-summary-meta mono">
            {metadata.datasetName} · {metadata.licenseTitle}
          </span>
        </summary>
        <div className="cnmc-api-details-body">
          <div className="cnmc-api-meta-grid">
            <div>
              <span className="cnmc-api-k">Dataset CNMC</span>
              <span className="cnmc-api-v mono">
                {metadata.datasetTitle} ({metadata.datasetName})
              </span>
            </div>
            <div>
              <span className="cnmc-api-k">Resource ID activo</span>
              <span className="cnmc-api-v mono">{metadata.resourceId}</span>
            </div>
            <div>
              <span className="cnmc-api-k">Última novedad CNMC</span>
              <span className="cnmc-api-v">
                {metadata.novedad || 'Sin nota adicional'}
              </span>
            </div>
            <div>
              <span className="cnmc-api-k">Licencia</span>
              <a
                href={metadata.licenseUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="cnmc-api-v"
              >
                {metadata.licenseTitle}
              </a>
            </div>
          </div>

          <div className="cnmc-api-steps">
            <div className="cnmc-api-step">
              <span className="cnmc-api-step-num mono">Paso 1</span>
              <div className="cnmc-api-step-copy">
                <strong>Descubrimiento en el catálogo CKAN</strong>
                <code className="cnmc-api-code">{metadata.step1Url}</code>
              </div>
            </div>
            <div className="cnmc-api-step">
              <span className="cnmc-api-step-num mono">Paso 2</span>
              <div className="cnmc-api-step-copy">
                <strong>Descarga de registros del Datastore</strong>
                <code className="cnmc-api-code">{metadata.step2Url}</code>
              </div>
            </div>
          </div>
        </div>
      </details>
    </main>
  );
}
