import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type {
  Feature,
  FeatureCollection,
  LineString,
  Point,
  Polygon,
} from 'geojson';
import {
  OPENFREEMAP_STYLES,
  OPERATOR_META,
  type AntennaRecord,
  type OperatorKey,
} from '../../types/antena';
import type { AntenasMapProps } from '../../types/map';
import {
  SPAIN_REGION_PRESETS,
  createCirclePolygonGeoJSON,
  formatDistance,
  haversineDistanceKm,
} from '../../utils/geo';
import { MapOverlays } from './MapOverlays';
import '../../styles/map.css';

const ANTENAS_SOURCE_ID = 'antenas-source';
const RADAR_SOURCE_ID = 'radar-source';

const LAYER_RADAR_FILL = 'radar-coverage-fill';
const LAYER_RADAR_OUTLINE = 'radar-coverage-outline';
const LAYER_RADAR_LOS_CASING = 'radar-los-casing';
const LAYER_RADAR_LOS_LINE = 'radar-los-line';
const LAYER_RADAR_LOS_LABEL = 'radar-los-label';
const LAYER_RADAR_ORIGIN_HALO = 'radar-origin-halo';
const LAYER_RADAR_ORIGIN_POINT = 'radar-origin-point';

const LAYER_CLUSTERS_HALO = 'antenas-clusters-halo';
const LAYER_CLUSTERS = 'antenas-clusters';
const LAYER_CLUSTER_COUNT = 'antenas-cluster-count';
const LAYER_UNCLUSTERED = 'antenas-unclustered';
const LAYER_SELECTED_HALO = 'antenas-selected-halo';
const LAYER_SELECTED_RING = 'antenas-selected-ring';

const NONE_SELECTED_SENTINEL = '__none_selected__';

interface AntennaFeatureProperties {
  idx: number;
  id: string;
  gid: string;
  op: OperatorKey;
  opRaw: string;
  dir: string;
  mun: string;
  prov: string;
  lat: number;
  lon: number;
}

interface RadarFeatureProperties {
  kind: 'coverage' | 'origin' | 'los';
  radiusKm?: number;
  label?: string;
  distanceLabel?: string;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isValidOperatorKey(value: unknown): value is OperatorKey {
  return (
    value === 'movistar' ||
    value === 'orange' ||
    value === 'vodafone' ||
    value === 'masmovil' ||
    value === 'digi' ||
    value === 'otros'
  );
}

function buildSelectedFilter(
  selectedId: string | null | undefined,
): maplibregl.FilterSpecification {
  return [
    'all',
    ['!', ['has', 'point_count']],
    ['==', ['get', 'id'], selectedId ?? NONE_SELECTED_SENTINEL],
  ];
}

function buildPopupHtml(props: AntennaFeatureProperties): string {
  const opMeta = OPERATOR_META[props.op] ?? OPERATOR_META.otros;
  const locationLine = [props.mun, props.prov].filter(Boolean).join(', ');
  const safeOpName = escapeHtml(opMeta.shortName);
  const safeGid = escapeHtml(props.gid || 'S/D');
  const safeLocation = escapeHtml(locationLine || 'Ubicación registrada');
  const safeDir = escapeHtml(props.dir || 'Sin dirección postal detallada');

  return `
    <div class="map-popup-head">
      <span class="map-popup-op-pill">
        <span class="map-popup-op-dot" style="background-color:${opMeta.color}"></span>
        ${safeOpName}
      </span>
      <span class="map-popup-gid">ID ${safeGid}</span>
    </div>
    <div class="map-popup-loc">${safeLocation}</div>
    <div class="map-popup-dir">${safeDir}</div>
    <div class="map-popup-hint">Clic para inspeccionar ficha técnica</div>
  `;
}

export function AntenasMap(props: AntenasMapProps) {
  const {
    antenas,
    selectedAntenna,
    onSelectAntenna,
    styleId,
    onStyleChange,
    flyToTarget,
    radarPoint,
    onRadarPointChange,
    radarModeActive = false,
    onToggleRadarMode,
    activeOperators,
    onToggleOperator,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const hoveredIdRef = useRef<string | null>(null);
  const appliedStyleIdRef = useRef<AntenasMapProps['styleId']>(styleId);
  const lastFlyTokenRef = useRef<number | string | null>(null);

  const [activeRegionId, setActiveRegionId] = useState<string | null>(
    'peninsula',
  );

  const currentStyleOption = useMemo(
    () =>
      OPENFREEMAP_STYLES.find((opt) => opt.id === styleId) ??
      OPENFREEMAP_STYLES[0],
    [styleId],
  );

  // Conversión memorizada de las 65.000+ estaciones a GeoJSON FeatureCollection
  const { antenasGeoJson, antenasById } = useMemo(() => {
    const byId = new Map<string, AntennaRecord>();
    const features: Feature<Point, AntennaFeatureProperties>[] = [];

    for (let i = 0; i < antenas.length; i++) {
      const ant = antenas[i];
      if (!Number.isFinite(ant.lat) || !Number.isFinite(ant.lon)) {
        continue;
      }
      byId.set(ant.id, ant);
      features.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [ant.lon, ant.lat],
        },
        properties: {
          idx: i,
          id: ant.id,
          gid: ant.gid,
          op: ant.op,
          opRaw: ant.opRaw,
          dir: ant.dir,
          mun: ant.mun,
          prov: ant.prov,
          lat: ant.lat,
          lon: ant.lon,
        },
      });
    }

    const collection: FeatureCollection<Point, AntennaFeatureProperties> = {
      type: 'FeatureCollection',
      features,
    };

    return { antenasGeoJson: collection, antenasById: byId };
  }, [antenas]);

  // Construcción memorizada de capas de radar RF (círculo de cobertura, pin central y vector LOS)
  const radarGeoJson = useMemo<
    FeatureCollection<Polygon | Point | LineString, RadarFeatureProperties>
  >(() => {
    const features: Feature<
      Polygon | Point | LineString,
      RadarFeatureProperties
    >[] = [];

    if (
      radarPoint &&
      Number.isFinite(radarPoint.lat) &&
      Number.isFinite(radarPoint.lon)
    ) {
      const radiusKm = radarPoint.radiusKm ?? 2;
      const circlePoly = createCirclePolygonGeoJSON(
        radarPoint.lon,
        radarPoint.lat,
        radiusKm,
        72,
      );
      features.push({
        type: 'Feature',
        geometry: circlePoly.geometry,
        properties: {
          kind: 'coverage',
          radiusKm,
        },
      });

      if (
        selectedAntenna &&
        Number.isFinite(selectedAntenna.lat) &&
        Number.isFinite(selectedAntenna.lon)
      ) {
        const distKm = haversineDistanceKm(
          radarPoint.lat,
          radarPoint.lon,
          selectedAntenna.lat,
          selectedAntenna.lon,
        );
        features.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              [radarPoint.lon, radarPoint.lat],
              [selectedAntenna.lon, selectedAntenna.lat],
            ],
          },
          properties: {
            kind: 'los',
            distanceLabel: formatDistance(distKm),
          },
        });
      }

      features.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [radarPoint.lon, radarPoint.lat],
        },
        properties: {
          kind: 'origin',
          label: radarPoint.label ?? 'Punto seleccionado',
        },
      });
    }

    return {
      type: 'FeatureCollection',
      features,
    };
  }, [radarPoint, selectedAntenna]);

  // Referencias vivas sincronizadas en efectos para acceso estable desde listeners imperativos de MapLibre
  const antenasGeoJsonRef = useRef(antenasGeoJson);
  const antenasByIdRef = useRef(antenasById);
  const radarGeoJsonRef = useRef(radarGeoJson);
  const selectedAntennaRef = useRef(selectedAntenna);
  const onSelectAntennaRef = useRef(onSelectAntenna);
  const radarModeActiveRef = useRef(radarModeActive);
  const radarPointRef = useRef(radarPoint);
  const onRadarPointChangeRef = useRef(onRadarPointChange);
  const isDarkStyleRef = useRef(currentStyleOption.isDark);

  useEffect(() => {
    antenasGeoJsonRef.current = antenasGeoJson;
    antenasByIdRef.current = antenasById;
  }, [antenasGeoJson, antenasById]);

  useEffect(() => {
    radarGeoJsonRef.current = radarGeoJson;
  }, [radarGeoJson]);

  useEffect(() => {
    selectedAntennaRef.current = selectedAntenna;
    onSelectAntennaRef.current = onSelectAntenna;
  }, [selectedAntenna, onSelectAntenna]);

  useEffect(() => {
    radarModeActiveRef.current = radarModeActive;
    radarPointRef.current = radarPoint;
    onRadarPointChangeRef.current = onRadarPointChange;
  }, [radarModeActive, radarPoint, onRadarPointChange]);

  useEffect(() => {
    isDarkStyleRef.current = currentStyleOption.isDark;
  }, [currentStyleOption.isDark]);

  // Registro idempotente de fuentes y capas tras carga inicial o cambio de estilo OpenFreeMap
  const ensureCustomSourcesAndLayers = useCallback((map: maplibregl.Map) => {
    if (!map.getStyle()) {
      return;
    }

    const isDark = isDarkStyleRef.current;

    // 1. Fuente GeoJSON de análisis radar RF y vector de línea de vista (LOS)
    if (!map.getSource(RADAR_SOURCE_ID)) {
      map.addSource(RADAR_SOURCE_ID, {
        type: 'geojson',
        data: radarGeoJsonRef.current,
      });
    }

    if (!map.getLayer(LAYER_RADAR_FILL)) {
      map.addLayer({
        id: LAYER_RADAR_FILL,
        type: 'fill',
        source: RADAR_SOURCE_ID,
        filter: ['==', ['get', 'kind'], 'coverage'],
        paint: {
          'fill-color': isDark ? '#38BDF8' : '#0284C7',
          'fill-opacity': isDark ? 0.14 : 0.1,
        },
      });
    }

    if (!map.getLayer(LAYER_RADAR_OUTLINE)) {
      map.addLayer({
        id: LAYER_RADAR_OUTLINE,
        type: 'line',
        source: RADAR_SOURCE_ID,
        filter: ['==', ['get', 'kind'], 'coverage'],
        paint: {
          'line-color': isDark ? '#38BDF8' : '#0284C7',
          'line-width': 2,
          'line-opacity': 0.85,
          'line-dasharray': [3, 2],
        },
      });
    }

    if (!map.getLayer(LAYER_RADAR_LOS_CASING)) {
      map.addLayer({
        id: LAYER_RADAR_LOS_CASING,
        type: 'line',
        source: RADAR_SOURCE_ID,
        filter: ['==', ['get', 'kind'], 'los'],
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': isDark ? 'rgba(15, 23, 42, 0.85)' : 'rgba(255, 255, 255, 0.9)',
          'line-width': 4.5,
        },
      });
    }

    if (!map.getLayer(LAYER_RADAR_LOS_LINE)) {
      map.addLayer({
        id: LAYER_RADAR_LOS_LINE,
        type: 'line',
        source: RADAR_SOURCE_ID,
        filter: ['==', ['get', 'kind'], 'los'],
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': isDark ? '#38BDF8' : '#0284C7',
          'line-width': 2.4,
          'line-dasharray': [2.2, 1.6],
        },
      });
    }

    if (!map.getLayer(LAYER_RADAR_LOS_LABEL)) {
      map.addLayer({
        id: LAYER_RADAR_LOS_LABEL,
        type: 'symbol',
        source: RADAR_SOURCE_ID,
        filter: ['==', ['get', 'kind'], 'los'],
        layout: {
          'symbol-placement': 'line-center',
          'text-field': ['get', 'distanceLabel'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
          'text-offset': [0, -0.7],
        },
        paint: {
          'text-color': isDark ? '#F8FAFC' : '#0F172A',
          'text-halo-color': isDark ? '#0F172A' : '#FFFFFF',
          'text-halo-width': 1.8,
        },
      });
    }

    // 2. Fuente GeoJSON clusterizada de 65.000+ estaciones móviles
    if (!map.getSource(ANTENAS_SOURCE_ID)) {
      map.addSource(ANTENAS_SOURCE_ID, {
        type: 'geojson',
        data: antenasGeoJsonRef.current,
        cluster: true,
        clusterMaxZoom: 12,
        clusterRadius: 46,
      });
    }

    if (!map.getLayer(LAYER_CLUSTERS_HALO)) {
      map.addLayer({
        id: LAYER_CLUSTERS_HALO,
        type: 'circle',
        source: ANTENAS_SOURCE_ID,
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': [
            'step',
            ['get', 'point_count'],
            '#0284C7',
            50,
            '#0369A1',
            250,
            '#0F4C81',
            1000,
            '#1E293B',
            5000,
            '#0F172A',
          ],
          'circle-radius': [
            'step',
            ['get', 'point_count'],
            20,
            50,
            24,
            250,
            28,
            1000,
            33,
            5000,
            38,
          ],
          'circle-opacity': isDark ? 0.28 : 0.18,
        },
      });
    }

    if (!map.getLayer(LAYER_CLUSTERS)) {
      map.addLayer({
        id: LAYER_CLUSTERS,
        type: 'circle',
        source: ANTENAS_SOURCE_ID,
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': [
            'step',
            ['get', 'point_count'],
            '#0284C7',
            50,
            '#0369A1',
            250,
            '#0F4C81',
            1000,
            '#1E293B',
            5000,
            '#0F172A',
          ],
          'circle-radius': [
            'step',
            ['get', 'point_count'],
            15.5,
            50,
            19,
            250,
            23,
            1000,
            27.5,
            5000,
            32,
          ],
          'circle-stroke-width': 2,
          'circle-stroke-color': isDark ? '#E2E8F0' : '#FFFFFF',
        },
      });
    }

    if (!map.getLayer(LAYER_CLUSTER_COUNT)) {
      map.addLayer({
        id: LAYER_CLUSTER_COUNT,
        type: 'symbol',
        source: ANTENAS_SOURCE_ID,
        filter: ['has', 'point_count'],
        layout: {
          'text-field': '{point_count_abbreviated}',
          'text-font': ['Noto Sans Regular'],
          'text-size': [
            'step',
            ['get', 'point_count'],
            11,
            250,
            12,
            1000,
            13,
          ],
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': '#FFFFFF',
        },
      });
    }

    if (!map.getLayer(LAYER_UNCLUSTERED)) {
      map.addLayer({
        id: LAYER_UNCLUSTERED,
        type: 'circle',
        source: ANTENAS_SOURCE_ID,
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': [
            'match',
            ['get', 'op'],
            'movistar',
            OPERATOR_META.movistar.color,
            'orange',
            OPERATOR_META.orange.color,
            'vodafone',
            OPERATOR_META.vodafone.color,
            'masmovil',
            OPERATOR_META.masmovil.color,
            'digi',
            OPERATOR_META.digi.color,
            OPERATOR_META.otros.color,
          ],
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            5,
            3.2,
            8,
            4.5,
            11,
            5.8,
            14,
            7.6,
            17,
            10.5,
          ],
          'circle-stroke-color': '#FFFFFF',
          'circle-stroke-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            5,
            0.9,
            8,
            1.3,
            13,
            1.8,
            17,
            2.4,
          ],
        },
      });
    }

    const selectedFilter = buildSelectedFilter(selectedAntennaRef.current?.id);

    if (!map.getLayer(LAYER_SELECTED_HALO)) {
      map.addLayer({
        id: LAYER_SELECTED_HALO,
        type: 'circle',
        source: ANTENAS_SOURCE_ID,
        filter: selectedFilter,
        paint: {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            6,
            14,
            12,
            19,
            17,
            25,
          ],
          'circle-color': '#0EA5E9',
          'circle-opacity': 0.24,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': 'rgba(14, 165, 233, 0.6)',
        },
      });
    }

    if (!map.getLayer(LAYER_SELECTED_RING)) {
      map.addLayer({
        id: LAYER_SELECTED_RING,
        type: 'circle',
        source: ANTENAS_SOURCE_ID,
        filter: selectedFilter,
        paint: {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            6,
            8.5,
            12,
            11.5,
            17,
            15.5,
          ],
          'circle-color': 'rgba(14, 165, 233, 0.08)',
          'circle-stroke-width': 3,
          'circle-stroke-color': isDark ? '#38BDF8' : '#0F172A',
        },
      });
    }

    // 3. Pin central del punto de radar encima de las antenas para máxima visibilidad
    if (!map.getLayer(LAYER_RADAR_ORIGIN_HALO)) {
      map.addLayer({
        id: LAYER_RADAR_ORIGIN_HALO,
        type: 'circle',
        source: RADAR_SOURCE_ID,
        filter: ['==', ['get', 'kind'], 'origin'],
        paint: {
          'circle-radius': 13,
          'circle-color': '#0EA5E9',
          'circle-opacity': 0.26,
        },
      });
    }

    if (!map.getLayer(LAYER_RADAR_ORIGIN_POINT)) {
      map.addLayer({
        id: LAYER_RADAR_ORIGIN_POINT,
        type: 'circle',
        source: RADAR_SOURCE_ID,
        filter: ['==', ['get', 'kind'], 'origin'],
        paint: {
          'circle-radius': 6.5,
          'circle-color': '#0EA5E9',
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#FFFFFF',
        },
      });
    }
  }, []);

  // Inicialización única del lienzo WebGL MapLibre GL
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const peninsulaPreset = SPAIN_REGION_PRESETS[0];
    const initialStyle =
      OPENFREEMAP_STYLES.find((opt) => opt.id === appliedStyleIdRef.current) ??
      OPENFREEMAP_STYLES[0];

    const map = new maplibregl.Map({
      container,
      style: initialStyle.url,
      center: [peninsulaPreset.lon, peninsulaPreset.lat],
      zoom: peninsulaPreset.zoom,
      minZoom: 3.5,
      maxZoom: 19,
      attributionControl: false,
    });

    map.addControl(
      new maplibregl.NavigationControl({
        visualizePitch: true,
        showCompass: true,
        showZoom: true,
      }),
      'bottom-right',
    );
    map.addControl(
      new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }),
      'bottom-right',
    );
    map.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      'bottom-right',
    );

    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 12,
      maxWidth: '300px',
      className: 'antenas-map-popup',
    });

    mapRef.current = map;
    popupRef.current = popup;

    const handleStyleLoad = () => {
      ensureCustomSourcesAndLayers(map);
    };

    const handleStyleData = () => {
      if (map.isStyleLoaded()) {
        ensureCustomSourcesAndLayers(map);
      }
    };

    const handleMapClick = (event: maplibregl.MapMouseEvent) => {
      const hasUnclusteredLayer = Boolean(map.getLayer(LAYER_UNCLUSTERED));
      const hasClusterLayer = Boolean(map.getLayer(LAYER_CLUSTERS));

      // 1. Priorizar clic directo sobre una estación desagrupada
      if (hasUnclusteredLayer) {
        const stationFeatures = map.queryRenderedFeatures(event.point, {
          layers: [LAYER_UNCLUSTERED],
        });
        if (stationFeatures.length > 0) {
          const topFeature = stationFeatures[0];
          const rawProps = topFeature.properties as Record<string, unknown>;
          const featureId = String(rawProps.id ?? '');
          const matchedRecord = antenasByIdRef.current.get(featureId);

          if (matchedRecord) {
            onSelectAntennaRef.current(matchedRecord);
            return;
          }

          if (featureId) {
            const fallbackGeometry =
              topFeature.geometry.type === 'Point'
                ? topFeature.geometry.coordinates
                : [event.lngLat.lng, event.lngLat.lat];

            const reconstructed: AntennaRecord = {
              id: featureId,
              gid: String(rawProps.gid ?? ''),
              op: isValidOperatorKey(rawProps.op) ? rawProps.op : 'otros',
              opRaw: String(rawProps.opRaw ?? ''),
              lat: Number(rawProps.lat ?? fallbackGeometry[1]),
              lon: Number(rawProps.lon ?? fallbackGeometry[0]),
              dir: String(rawProps.dir ?? ''),
              mun: String(rawProps.mun ?? ''),
              prov: String(rawProps.prov ?? ''),
            };
            onSelectAntennaRef.current(reconstructed);
            return;
          }
        }
      }

      // 2. Expansión suave al hacer clic en un clúster de antenas
      if (hasClusterLayer) {
        const clusterFeatures = map.queryRenderedFeatures(event.point, {
          layers: [LAYER_CLUSTERS],
        });
        if (clusterFeatures.length > 0) {
          const clusterFeature = clusterFeatures[0];
          const clusterId = Number(clusterFeature.properties?.cluster_id);
          const source = map.getSource(ANTENAS_SOURCE_ID) as
            | maplibregl.GeoJSONSource
            | undefined;

          if (
            source &&
            Number.isFinite(clusterId) &&
            clusterFeature.geometry.type === 'Point'
          ) {
            const [lon, lat] = clusterFeature.geometry.coordinates;
            void source
              .getClusterExpansionZoom(clusterId)
              .then((expansionZoom) => {
                map.easeTo({
                  center: [lon, lat],
                  zoom: Math.min(expansionZoom, 17),
                  duration: 480,
                });
              })
              .catch(() => {
                // Ignorar si el estilo o la fuente cambiaron durante la transición
              });
            return;
          }
        }
      }

      // 3. Clic en el fondo del mapa: fijar radar si modo medición está activo, o limpiar selección
      if (radarModeActiveRef.current) {
        onRadarPointChangeRef.current?.({
          lat: Number(event.lngLat.lat.toFixed(6)),
          lon: Number(event.lngLat.lng.toFixed(6)),
          radiusKm: radarPointRef.current?.radiusKm ?? 2,
          label: 'Punto seleccionado',
        });
        return;
      }

      if (selectedAntennaRef.current) {
        onSelectAntennaRef.current(null);
      }
    };

    const handleMouseMove = (event: maplibregl.MapMouseEvent) => {
      const interactiveLayers: string[] = [];
      if (map.getLayer(LAYER_UNCLUSTERED)) {
        interactiveLayers.push(LAYER_UNCLUSTERED);
      }
      if (map.getLayer(LAYER_CLUSTERS)) {
        interactiveLayers.push(LAYER_CLUSTERS);
      }

      if (interactiveLayers.length === 0) {
        map.getCanvas().style.cursor = radarModeActiveRef.current
          ? 'crosshair'
          : '';
        return;
      }

      const hits = map.queryRenderedFeatures(event.point, {
        layers: interactiveLayers,
      });

      if (hits.length === 0) {
        map.getCanvas().style.cursor = radarModeActiveRef.current
          ? 'crosshair'
          : '';
        if (hoveredIdRef.current !== null) {
          hoveredIdRef.current = null;
          popup.remove();
        }
        return;
      }

      const topHit = hits[0];
      map.getCanvas().style.cursor = 'pointer';

      if (
        topHit.layer.id === LAYER_UNCLUSTERED &&
        topHit.geometry.type === 'Point'
      ) {
        const raw = topHit.properties as Record<string, unknown>;
        const stationId = String(raw.id ?? '');
        const [lon, lat] = topHit.geometry.coordinates;

        if (hoveredIdRef.current !== stationId) {
          hoveredIdRef.current = stationId;
          const popupProps: AntennaFeatureProperties = {
            idx: Number(raw.idx ?? 0),
            id: stationId,
            gid: String(raw.gid ?? ''),
            op: isValidOperatorKey(raw.op) ? raw.op : 'otros',
            opRaw: String(raw.opRaw ?? ''),
            dir: String(raw.dir ?? ''),
            mun: String(raw.mun ?? ''),
            prov: String(raw.prov ?? ''),
            lat: Number(raw.lat ?? lat),
            lon: Number(raw.lon ?? lon),
          };
          popup.setHTML(buildPopupHtml(popupProps));
        }

        popup.setLngLat([lon, lat]).addTo(map);
      } else if (hoveredIdRef.current !== null) {
        hoveredIdRef.current = null;
        popup.remove();
      }
    };

    const handleCanvasLeave = () => {
      hoveredIdRef.current = null;
      popup.remove();
    };

    map.on('load', handleStyleLoad);
    map.on('style.load', handleStyleLoad);
    map.on('styledata', handleStyleData);
    map.on('click', handleMapClick);
    map.on('mousemove', handleMouseMove);
    map.getCanvas().addEventListener('mouseleave', handleCanvasLeave);

    return () => {
      map.getCanvas().removeEventListener('mouseleave', handleCanvasLeave);
      popup.remove();
      map.remove();
      mapRef.current = null;
      popupRef.current = null;
      hoveredIdRef.current = null;
    };
  }, [ensureCustomSourcesAndLayers]);

  // Cambio resiliente de estilo OpenFreeMap preservando todas las fuentes y capas
  useEffect(() => {
    isDarkStyleRef.current = currentStyleOption.isDark;
    const map = mapRef.current;
    if (!map || appliedStyleIdRef.current === styleId) {
      return;
    }

    appliedStyleIdRef.current = styleId;
    hoveredIdRef.current = null;
    popupRef.current?.remove();

    map.setStyle(currentStyleOption.url, { diff: false });
  }, [styleId, currentStyleOption.url, currentStyleOption.isDark]);

  // Sincronización reactiva del dataset filtrado de antenas
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const source = map.getSource(ANTENAS_SOURCE_ID) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (source) {
      source.setData(antenasGeoJson);
    }
  }, [antenasGeoJson]);

  // Sincronización reactiva del círculo de cobertura radar y enlace LOS
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const source = map.getSource(RADAR_SOURCE_ID) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (source) {
      source.setData(radarGeoJson);
    }
  }, [radarGeoJson]);

  // Actualización instantánea del anillo de selección en GPU
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const filter = buildSelectedFilter(selectedAntenna?.id);
    if (map.getLayer(LAYER_SELECTED_HALO)) {
      map.setFilter(LAYER_SELECTED_HALO, filter);
    }
    if (map.getLayer(LAYER_SELECTED_RING)) {
      map.setFilter(LAYER_SELECTED_RING, filter);
    }
  }, [selectedAntenna]);

  // Cursor de retícula al activar/desactivar el modo medición
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    map.getCanvas().style.cursor = radarModeActive ? 'crosshair' : '';
  }, [radarModeActive]);

  // Desplazamiento animado de cámara cuando cambia `flyToTarget.token`
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !flyToTarget) {
      return;
    }
    if (lastFlyTokenRef.current === flyToTarget.token) {
      return;
    }

    lastFlyTokenRef.current = flyToTarget.token;
    setActiveRegionId(null);

    map.flyTo({
      center: [flyToTarget.lon, flyToTarget.lat],
      zoom: flyToTarget.zoom ?? 15,
      duration: 1200,
      essential: true,
    });
  }, [flyToTarget]);

  const handleFlyToRegion = useCallback(
    (lon: number, lat: number, zoom: number, presetId?: string) => {
      setActiveRegionId(presetId ?? null);
      const map = mapRef.current;
      if (!map) {
        return;
      }
      map.flyTo({
        center: [lon, lat],
        zoom,
        duration: 1200,
        essential: true,
      });
    },
    [],
  );

  return (
    <div
      className="antenas-map-root"
      data-map-dark={currentStyleOption.isDark ? 'true' : 'false'}
    >
      <div
        ref={containerRef}
        className="antenas-map-canvas"
        aria-label="Mapa interactivo de estaciones base de telefonía móvil en España"
      />

      <MapOverlays
        antenas={antenas}
        selectedAntenna={selectedAntenna}
        styleId={styleId}
        onStyleChange={onStyleChange}
        radarPoint={radarPoint}
        onRadarPointChange={onRadarPointChange}
        radarModeActive={radarModeActive}
        onToggleRadarMode={onToggleRadarMode}
        activeOperators={activeOperators}
        onToggleOperator={onToggleOperator}
        activeRegionId={activeRegionId}
        onFlyToRegion={handleFlyToRegion}
      />
    </div>
  );
}
