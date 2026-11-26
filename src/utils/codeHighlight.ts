import type { FeatureCollection, Point } from 'geojson';
import type { OperatorKey } from '../types/antena';
import {
  CODE_HIGHLIGHT_DURATION_MS,
  type HighlightedAntennaTarget,
} from '../types/map';

export interface CodeHighlightFeatureProperties {
  antennaId: string;
  gid: string;
  matchedCode: string;
  label: string;
  op: OperatorKey;
}

export interface CodeHighlightAnimationFrame {
  fade: number;
  pulse1Radius: number;
  pulse1FillOpacity: number;
  pulse1StrokeOpacity: number;
  pulse2Radius: number;
  pulse2FillOpacity: number;
  pulse2StrokeOpacity: number;
  ringFillOpacity: number;
  ringStrokeOpacity: number;
  casingStrokeOpacity: number;
  labelOpacity: number;
}

export const EMPTY_CODE_HIGHLIGHT_GEOJSON: FeatureCollection<
  Point,
  CodeHighlightFeatureProperties
> = {
  type: 'FeatureCollection',
  features: [],
};

const CODE_HIGHLIGHT_PULSE_CYCLE_MS = 1400;
const CODE_HIGHLIGHT_FADEOUT_MS = 1000;

/**
 * Construye el GeoJSON puntual (sin clustering) del marcador resaltado durante 10 s
 * tras localizar una antena específica mediante el buscador por código.
 */
export function buildCodeHighlightGeoJson(
  target: HighlightedAntennaTarget | null | undefined,
  resolvedCoords?: { lat: number; lon: number } | null,
): FeatureCollection<Point, CodeHighlightFeatureProperties> {
  if (!target) {
    return EMPTY_CODE_HIGHLIGHT_GEOJSON;
  }
  const lat = resolvedCoords?.lat ?? target.antenna.lat;
  const lon = resolvedCoords?.lon ?? target.antenna.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return EMPTY_CODE_HIGHLIGHT_GEOJSON;
  }
  const displayCode = target.matchedCode.trim() || target.antenna.gid.trim();
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [lon, lat],
        },
        properties: {
          antennaId: target.antenna.id,
          gid: target.antenna.gid,
          matchedCode: displayCode,
          label: displayCode ? `#${displayCode}` : '',
          op: target.antenna.op,
        },
      },
    ],
  };
}

/**
 * Calcula los parámetros de radio y opacidad de las ondas de pulso radar y del aro
 * de contraste durante los 10 segundos de resaltado (con desvanecimiento en el último segundo).
 */
export function computeCodeHighlightAnimationFrame(
  elapsedMs: number,
  durationMs: number = CODE_HIGHLIGHT_DURATION_MS,
  reducedMotion = false,
): CodeHighlightAnimationFrame {
  const safeDuration = Math.max(1, durationMs);
  const clampedElapsed = Math.max(0, Math.min(elapsedMs, safeDuration));
  const remaining = Math.max(0, safeDuration - clampedElapsed);
  const fade =
    remaining < CODE_HIGHLIGHT_FADEOUT_MS
      ? Math.max(0, Math.min(1, remaining / CODE_HIGHLIGHT_FADEOUT_MS))
      : 1;

  if (reducedMotion) {
    return {
      fade,
      pulse1Radius: 27,
      pulse1FillOpacity: 0.14 * fade,
      pulse1StrokeOpacity: 0.72 * fade,
      pulse2Radius: 19,
      pulse2FillOpacity: 0,
      pulse2StrokeOpacity: 0,
      ringFillOpacity: 0.16 * fade,
      ringStrokeOpacity: 1 * fade,
      casingStrokeOpacity: 0.92 * fade,
      labelOpacity: fade,
    };
  }

  const p1 =
    (clampedElapsed % CODE_HIGHLIGHT_PULSE_CYCLE_MS) /
    CODE_HIGHLIGHT_PULSE_CYCLE_MS;
  const e1 = 1 - (1 - p1) * (1 - p1);
  const p2 =
    ((clampedElapsed + CODE_HIGHLIGHT_PULSE_CYCLE_MS / 2) %
      CODE_HIGHLIGHT_PULSE_CYCLE_MS) /
    CODE_HIGHLIGHT_PULSE_CYCLE_MS;
  const e2 = 1 - (1 - p2) * (1 - p2);
  const breathe = 0.5 + 0.5 * Math.sin((clampedElapsed / 420) * Math.PI);

  return {
    fade,
    pulse1Radius: 15 + e1 * 34,
    pulse1FillOpacity: (1 - p1) * 0.22 * fade,
    pulse1StrokeOpacity: (1 - p1) * 0.92 * fade,
    pulse2Radius: 15 + e2 * 34,
    pulse2FillOpacity: (1 - p2) * 0.14 * fade,
    pulse2StrokeOpacity: (1 - p2) * 0.76 * fade,
    ringFillOpacity: (0.1 + 0.1 * breathe) * fade,
    ringStrokeOpacity: 1 * fade,
    casingStrokeOpacity: 0.92 * fade,
    labelOpacity: fade,
  };
}
