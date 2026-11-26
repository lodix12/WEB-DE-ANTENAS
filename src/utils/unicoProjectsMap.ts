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
export const UNICO_PROJECT_ICON_ANCHOR = 'bottom' as const;
/**
 * Desplazamiento lógico (`icon-offset`) en píxeles CSS del sprite `64×76` (`pixelRatio: 2`,
 * tamaño lógico `32×38`) para apoyar exactamente la punta del pin (`y = 68` px físicos -> `34` px
 * lógicos, 4 px por encima del borde inferior de la sombra) sobre la coordenada WGS84.
 */
export const UNICO_PROJECT_ICON_OFFSET: readonly [number, number] = [0, 4];

export const UNICO_PROJECT_ICON_STOPS: readonly [number, number][] = [
  [3, 0.18],
  [5, 0.26],
  [7, 0.36],
  [9, 0.48],
  [11, 0.62],
  [14, 0.78],
  [17, 0.94],
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
 * Genera en Canvas 2D (`64×76` px, `pixelRatio: 2`) un pin GPS clásico en lágrima con el color
 * oficial de la operadora, borde blanco de alto contraste, sombra suave en la punta y círculo
 * interno blanco reducido (`r = 1.6` u.), anclado exactamente en la punta sobre la coordenada WGS84.
 */
export function createUnicoProjectSprite(op: UnicoOperatorKey): ImageData {
  const width = 64;
  const height = 76;
  const cx = width / 2;
  const tipY = 68;
  const scale = 2.4;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return new ImageData(width, height);
  }

  const opColor =
    OPERATOR_META[op]?.color ??
    UNICO_OPERATOR_META[op]?.color ??
    UNICO_OPERATOR_META.orange.color;

  ctx.save();
  ctx.translate(cx, tipY);
  ctx.scale(scale, scale);

  const tracePinPath = () => {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(-5.5, -6.5, -9, -11.5, -9, -15.5);
    ctx.arc(0, -15.5, 9, Math.PI, 0, false);
    ctx.bezierCurveTo(9, -11.5, 5.5, -6.5, 0, 0);
    ctx.closePath();
  };

  // 1. Sombra elíptica suave apoyada bajo la punta exacta (0, 0)
  ctx.beginPath();
  ctx.ellipse(0, 0.5, 4.2, 1.8, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.38)';
  ctx.fill();

  // 2. Halo exterior oscuro de contraste (nitidez en mapas claros, oscuros y satélite)
  tracePinPath();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3.2;
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.55)';
  ctx.stroke();

  // 3. Cuerpo del pin con el color de la operadora + borde blanco limpio
  tracePinPath();
  ctx.fillStyle = opColor;
  ctx.fill();
  ctx.lineWidth = 1.9;
  ctx.strokeStyle = '#FFFFFF';
  ctx.stroke();

  // 4. Círculo interno blanco compacto (mitad de tamaño: radio 1.6 frente a 3.2)
  ctx.beginPath();
  ctx.arc(0, -15.5, 1.6, 0, Math.PI * 2);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();

  ctx.restore();

  return ctx.getImageData(0, 0, width, height);
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

    const pinBadgeSvg =
      '<svg class="map-popup-unico-coord-pin" viewBox="0 0 12 16" width="9" height="12" aria-hidden="true"><path d="M6 15.5C3.5 12.2 1 9.5 1 6a5 5 0 1 1 10 0c0 3.5-2.5 6.2-5 9.5Z" fill="currentColor"/><circle cx="6" cy="6" r="1.15" fill="#0f172a"/></svg>';

    return `
      <div class="${headClass}">
        <span class="map-popup-unico-coord-badge">
          ${pinBadgeSvg}
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
        <svg class="map-popup-unico-coord-pin" viewBox="0 0 12 16" width="9" height="12" aria-hidden="true"><path d="M6 15.5C3.5 12.2 1 9.5 1 6a5 5 0 1 1 10 0c0 3.5-2.5 6.2-5 9.5Z" fill="currentColor"/><circle cx="6" cy="6" r="1.15" fill="#0f172a"/></svg>
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
