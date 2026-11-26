import type { Feature, FeatureCollection, Point } from 'geojson';
import {
  formatUnicoDeclaredBitsList,
  formatUnicoDistance,
  isUnicoOperatorKey,
} from '../hooks/useUnico5gData';
import { OPERATOR_META } from '../types/antena';
import {
  UNICO_OPERATOR_META,
  type UnicoAntennaRecord,
  type UnicoDeclaredRealAntennaMatch,
  type UnicoFase,
  type UnicoOperatorKey,
} from '../types/unico5g';

export const UNICO_COORD_ICON_PREFIX = 'unico-coord:';
export const UNICO_PROJECT_SPRITE_PIXEL_RATIO = 2;

export const UNICO_PROJECT_ICON_STOPS: readonly [number, number][] = [
  [3, 0.12],
  [5, 0.17],
  [7, 0.25],
  [9, 0.36],
  [11, 0.48],
  [14, 0.62],
  [17, 0.74],
];

export interface UnicoProjectFeatureProperties {
  idx: number;
  id: string;
  fase: UnicoFase;
  op: UnicoOperatorKey;
  empresa: string;
  ccaa: string;
  prov: string;
  mun: string;
  lat: number;
  lon: number;
  iconKey: string;
  declaredBits: number;
  isDeclared: boolean;
  matchedAntennaId: string;
  matchedDistanceKm: number;
}

export interface UnicoProjectsPopupOptions {
  interactive?: boolean;
  hasMatchedAntenna?: boolean;
  fallbackStationLabel?: string | null;
}

const UNICO_PROJECT_SPRITE_CACHE = new Map<string, ImageData>();

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Genera en Canvas 2D (`64x64` px, `pixelRatio: 2`) un rombo de precisión con borde
 * ámbar/dorado y núcleo del color de la operadora para distinguir las coordenadas oficiales
 * exactas de proyectos UNICO 5G sobre las antenas reales circulares en mapas claros, oscuros y satélite.
 */
export function createUnicoProjectSprite(op: UnicoOperatorKey): ImageData {
  const size = 64;
  const cx = size / 2;
  const cy = size / 2;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return new ImageData(size, size);
  }

  const fillDiamond = (radius: number, fillStyle: string) => {
    ctx.beginPath();
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx + radius, cy);
    ctx.lineTo(cx, cy + radius);
    ctx.lineTo(cx - radius, cy);
    ctx.closePath();
    ctx.fillStyle = fillStyle;
    ctx.fill();
  };

  const opColor =
    OPERATOR_META[op]?.color ??
    UNICO_OPERATOR_META[op]?.color ??
    UNICO_OPERATOR_META.orange.color;

  // 1. Halo exterior oscuro de alto contraste (nitidez en mapas claros y vías amarillas)
  fillDiamond(24.6, 'rgba(15, 23, 42, 0.92)');
  // 2. Marco romboidal ámbar/dorado identificativo de coordenada oficial UNICO 5G
  fillDiamond(22.8, '#F59E0B');
  // 3. Bisel blanco interior de separación
  fillDiamond(18.6, '#FFFFFF');
  // 4. Núcleo romboidal amplio con el color oficial de la operadora adjudicataria
  fillDiamond(17.0, opColor);

  // 5. Retícula central exacta marcando el punto geodésico WGS84
  ctx.beginPath();
  ctx.arc(cx, cy, 2.2, 0, Math.PI * 2);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();

  return ctx.getImageData(0, 0, size, size);
}

export function getOrCreateUnicoProjectSprite(
  iconKey: string,
): ImageData | null {
  if (!iconKey.startsWith(UNICO_COORD_ICON_PREFIX)) {
    return null;
  }
  const existing = UNICO_PROJECT_SPRITE_CACHE.get(iconKey);
  if (existing) {
    return existing;
  }
  const rawOp = iconKey.slice(UNICO_COORD_ICON_PREFIX.length);
  const op: UnicoOperatorKey = isUnicoOperatorKey(rawOp) ? rawOp : 'orange';
  const imageData = createUnicoProjectSprite(op);
  UNICO_PROJECT_SPRITE_CACHE.set(iconKey, imageData);
  return imageData;
}

/**
 * Construye el GeoJSON puntual exacto (sin clustering ni redondeo) con todas las coordenadas
 * oficiales de los proyectos UNICO 5G (9.291 ubicaciones) enriquecidas con su estado de
 * declaración 5G (N78/N28+/N28) y la antena real emparejada si existe.
 */
export function buildUnicoProjectsGeoJson(
  projects: readonly UnicoAntennaRecord[],
  declaredMasks?: Uint16Array | null,
  unicoDeclaredById?: ReadonlyMap<string, UnicoDeclaredRealAntennaMatch>,
): FeatureCollection<Point, UnicoProjectFeatureProperties> {
  if (projects.length === 0) {
    return {
      type: 'FeatureCollection',
      features: [],
    };
  }

  const matchByUnicoId = new Map<
    string,
    { antennaId: string; declaredBits: number; distanceKm: number }
  >();
  if (unicoDeclaredById && unicoDeclaredById.size > 0) {
    for (const match of unicoDeclaredById.values()) {
      for (let e = 0; e < match.entries.length; e++) {
        const entry = match.entries[e];
        if (!matchByUnicoId.has(entry.unicoId)) {
          matchByUnicoId.set(entry.unicoId, {
            antennaId: match.antennaId,
            declaredBits: match.declaredBits,
            distanceKm: entry.distanceKm,
          });
        }
      }
    }
  }

  const features: Feature<Point, UnicoProjectFeatureProperties>[] = [];
  for (let i = 0; i < projects.length; i++) {
    const project = projects[i];
    if (!Number.isFinite(project.lat) || !Number.isFinite(project.lon)) {
      continue;
    }
    const op: UnicoOperatorKey = isUnicoOperatorKey(project.op)
      ? project.op
      : 'orange';
    const matched = matchByUnicoId.get(project.id);
    const maskBits =
      declaredMasks && i < declaredMasks.length ? declaredMasks[i] : 0;
    const declaredBits =
      maskBits !== 0 ? maskBits : (matched?.declaredBits ?? 0);

    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [project.lon, project.lat],
      },
      properties: {
        idx: i,
        id: project.id,
        fase: project.fase,
        op,
        empresa: project.empresa,
        ccaa: project.ccaa,
        prov: project.prov,
        mun: project.mun,
        lat: project.lat,
        lon: project.lon,
        iconKey: `${UNICO_COORD_ICON_PREFIX}${op}`,
        declaredBits,
        isDeclared: declaredBits !== 0,
        matchedAntennaId: matched?.antennaId ?? '',
        matchedDistanceKm:
          matched && Number.isFinite(matched.distanceKm)
            ? matched.distanceKm
            : -1,
      },
    });
  }

  return {
    type: 'FeatureCollection',
    features,
  };
}

function buildUnicoProjectStatusHtml(
  project: UnicoProjectFeatureProperties,
): string {
  if (project.isDeclared) {
    const bands = formatUnicoDeclaredBitsList(project.declaredBits);
    const bandsPart = bands.length > 0 ? ` · ${bands.join('/')}` : '';
    const distPart =
      project.matchedDistanceKm >= 0
        ? ` · ${formatUnicoDistance(project.matchedDistanceKm)}`
        : '';
    return `<span class="map-popup-unico-status-pill is-declared"><span class="map-popup-unico-dot"></span><span>Declarada${escapeHtml(bandsPart)}${escapeHtml(distPart)}</span></span>`;
  }
  return `<span class="map-popup-unico-status-pill is-pending">Sin declarar</span>`;
}

export function buildUnicoProjectsPopupHtml(
  projects: readonly UnicoProjectFeatureProperties[],
  options: UnicoProjectsPopupOptions = {},
): string {
  if (projects.length === 0) {
    return '';
  }

  const interactive = Boolean(options.interactive);
  const first = projects[0];
  const coordsText = `${first.lat.toFixed(6)}, ${first.lon.toFixed(6)}`;
  const safeCoords = escapeHtml(coordsText);
  const headClass = interactive
    ? 'map-popup-head map-popup-unico-coord-head'
    : 'map-popup-head';

  const footerHtml = interactive
    ? (() => {
        const secondaryBtn = options.hasMatchedAntenna
          ? `<button type="button" class="map-popup-unico-btn is-primary" data-unico-action="focus-matched">Ver antena declarada</button>`
          : options.fallbackStationLabel
            ? `<button type="button" class="map-popup-unico-btn is-primary" data-unico-action="focus-fallback">Ver ${escapeHtml(options.fallbackStationLabel)}</button>`
            : '';
        return `<div class="map-popup-unico-actions">
          <button type="button" class="map-popup-unico-btn" data-unico-action="copy">Copiar coords</button>
          ${secondaryBtn}
        </div>`;
      })()
    : `<div class="map-popup-hint">${
        options.hasMatchedAntenna
          ? 'Clic para copiar coordenadas o ver antena declarada'
          : 'Clic para fijar y copiar coordenadas oficiales'
      }</div>`;

  if (projects.length > 1) {
    const itemsHtml = projects
      .map((proj) => {
        const opColor =
          OPERATOR_META[proj.op]?.color ??
          UNICO_OPERATOR_META[proj.op]?.color ??
          UNICO_OPERATOR_META.orange.color;
        const opLabel =
          OPERATOR_META[proj.op]?.shortName ??
          UNICO_OPERATOR_META[proj.op]?.name ??
          'Orange';
        const safeFase = proj.fase === 2 ? 2 : 1;
        const locText = [proj.mun, proj.prov].filter(Boolean).join(', ');
        return `
          <div class="map-popup-unico-multi-item">
            <div class="map-popup-unico-multi-top">
              <span class="map-popup-unico-multi-op">
                <span class="map-popup-op-dot" style="background-color:${opColor}"></span>
                <span>${escapeHtml(opLabel)}</span>
              </span>
              <span class="map-popup-unico-fase-pill">Fase ${safeFase}</span>
            </div>
            <div class="map-popup-loc">${escapeHtml(locText || 'Ubicación oficial UNICO')}</div>
            ${proj.empresa ? `<div class="map-popup-unico-empresa">${escapeHtml(proj.empresa)}</div>` : ''}
            <div class="map-popup-unico-meta-row" style="margin-top:4px;margin-bottom:0">${buildUnicoProjectStatusHtml(proj)}</div>
          </div>
        `;
      })
      .join('');

    return `
      <div class="${headClass}">
        <span class="map-popup-unico-coord-badge">
          <span class="map-popup-unico-coord-diamond"></span>
          <span>Coordenadas UNICO 5G</span>
        </span>
        <span class="map-popup-gid">${projects.length} proy.</span>
      </div>
      <div class="map-popup-unico-multi-list">${itemsHtml}</div>
      <div class="map-popup-unico-coords-row">
        <span>WGS84</span>
        <code>${safeCoords}</code>
      </div>
      ${footerHtml}
    `;
  }

  const opColor =
    OPERATOR_META[first.op]?.color ??
    UNICO_OPERATOR_META[first.op]?.color ??
    UNICO_OPERATOR_META.orange.color;
  const opLabel =
    OPERATOR_META[first.op]?.shortName ??
    UNICO_OPERATOR_META[first.op]?.name ??
    'Orange';
  const safeFase = first.fase === 2 ? 2 : 1;
  const locationLine = [first.mun, first.prov].filter(Boolean).join(', ');
  const includeCcaa =
    Boolean(first.ccaa) &&
    first.ccaa.toUpperCase() !== first.prov.toUpperCase();
  const locationWithCcaa = [locationLine, includeCcaa ? first.ccaa : '']
    .filter(Boolean)
    .join(' · ');

  return `
    <div class="${headClass}">
      <span class="map-popup-unico-coord-badge">
        <span class="map-popup-unico-coord-diamond"></span>
        <span>Coordenada oficial UNICO 5G</span>
      </span>
      <span class="map-popup-unico-fase-pill">Fase ${safeFase}</span>
    </div>
    <div class="map-popup-unico-meta-row">
      <span class="map-popup-op-pill">
        <span class="map-popup-op-dot" style="background-color:${opColor}"></span>
        ${escapeHtml(opLabel)}
      </span>
      ${buildUnicoProjectStatusHtml(first)}
    </div>
    <div class="map-popup-loc">${escapeHtml(locationWithCcaa || 'Ubicación oficial UNICO')}</div>
    ${first.empresa ? `<div class="map-popup-unico-empresa">${escapeHtml(first.empresa)}</div>` : ''}
    <div class="map-popup-unico-coords-row">
      <span>WGS84</span>
      <code>${safeCoords}</code>
    </div>
    ${footerHtml}
  `;
}
