import { CalendarRange } from 'lucide-react';

export interface CnmcYearRangeControlProps {
  availableYears: readonly number[];
  fromYear: number;
  toYear: number;
  onChangeRange: (nextFrom: number, nextTo: number) => void;
}

interface YearPreset {
  id: string;
  label: string;
  from: number;
  to: number;
}

export function CnmcYearRangeControl({
  availableYears,
  fromYear,
  toYear,
  onChangeRange,
}: CnmcYearRangeControlProps) {
  if (availableYears.length === 0) {
    return null;
  }

  const minYear = availableYears[0];
  const maxYear = availableYears[availableYears.length - 1];
  const span = Math.max(1, maxYear - minYear);
  const startPct = ((fromYear - minYear) / span) * 100;
  const endPct = ((toYear - minYear) / span) * 100;
  const yearsSelectedCount = availableYears.filter(
    (y) => y >= fromYear && y <= toYear,
  ).length;

  const presets: YearPreset[] = [
    {
      id: 'last-5',
      label: 'Últimos 5 años',
      from: Math.max(minYear, maxYear - 4),
      to: maxYear,
    },
    {
      id: 'last-10',
      label: 'Últimos 10 años',
      from: Math.max(minYear, maxYear - 9),
      to: maxYear,
    },
    ...(minYear < 2015 && maxYear >= 2015
      ? [
          {
            id: 'since-2015',
            label: 'Desde 2015',
            from: 2015,
            to: maxYear,
          },
        ]
      : []),
    {
      id: 'all',
      label: `Todo (${minYear}–${maxYear})`,
      from: minYear,
      to: maxYear,
    },
  ];

  function handleFromSelect(rawValue: string) {
    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsed)) return;
    onChangeRange(parsed, Math.max(parsed, toYear));
  }

  function handleToSelect(rawValue: string) {
    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsed)) return;
    onChangeRange(Math.min(fromYear, parsed), parsed);
  }

  function handleFromSlider(rawValue: string) {
    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(parsed, toYear);
    onChangeRange(clamped, toYear);
  }

  function handleToSlider(rawValue: string) {
    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.max(parsed, fromYear);
    onChangeRange(fromYear, clamped);
  }

  return (
    <div className="cnmc-year-control" aria-label="Selector de rango anual">
      <div className="cnmc-year-control-top">
        <div className="cnmc-year-title-group">
          <CalendarRange size={15} aria-hidden="true" className="cnmc-muted-icon" />
          <span className="cnmc-control-heading">Rango anual</span>
          <span className="cnmc-year-span-badge mono">
            {fromYear === toYear
              ? `${fromYear} · 1 año`
              : `${fromYear}–${toYear} · ${yearsSelectedCount} años`}
          </span>
        </div>

        <div className="cnmc-year-presets" role="group" aria-label="Rangos rápidos">
          {presets.map((preset) => {
            const isActive =
              fromYear === preset.from && toYear === preset.to;
            return (
              <button
                key={preset.id}
                type="button"
                id={`cnmc-preset-${preset.id}`}
                className={`cnmc-preset-btn${isActive ? ' is-active' : ''}`}
                aria-pressed={isActive}
                onClick={() => onChangeRange(preset.from, preset.to)}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="cnmc-year-inputs-row">
        <label className="cnmc-year-select-field" htmlFor="cnmc-year-from">
          <span className="cnmc-year-select-label">Año inicio</span>
          <select
            id="cnmc-year-from"
            className="cnmc-select mono"
            value={fromYear}
            onChange={(e) => handleFromSelect(e.target.value)}
          >
            {availableYears.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>

        <div className="cnmc-dual-slider-wrap" aria-hidden={minYear === maxYear}>
          <div className="cnmc-dual-slider-bar">
            <div className="cnmc-dual-slider-track">
              <div
                className="cnmc-dual-slider-fill"
                style={{
                  left: `${startPct}%`,
                  width: `${Math.max(0, endPct - startPct)}%`,
                }}
              />
            </div>
            <input
              type="range"
              id="cnmc-range-from"
              aria-label="Deslizador de año de inicio"
              className="cnmc-dual-slider-input is-from"
              min={minYear}
              max={maxYear}
              step={1}
              value={fromYear}
              disabled={minYear === maxYear}
              onChange={(e) => handleFromSlider(e.target.value)}
            />
            <input
              type="range"
              id="cnmc-range-to"
              aria-label="Deslizador de año de fin"
              className="cnmc-dual-slider-input is-to"
              min={minYear}
              max={maxYear}
              step={1}
              value={toYear}
              disabled={minYear === maxYear}
              onChange={(e) => handleToSlider(e.target.value)}
            />
          </div>
          <div className="cnmc-dual-slider-ticks mono">
            <span>{minYear}</span>
            <span>{Math.round((minYear + maxYear) / 2)}</span>
            <span>{maxYear}</span>
          </div>
        </div>

        <label className="cnmc-year-select-field" htmlFor="cnmc-year-to">
          <span className="cnmc-year-select-label">Año fin</span>
          <select
            id="cnmc-year-to"
            className="cnmc-select mono"
            value={toYear}
            onChange={(e) => handleToSelect(e.target.value)}
          >
            {availableYears.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
