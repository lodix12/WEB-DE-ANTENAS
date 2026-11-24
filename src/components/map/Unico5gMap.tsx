import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Check,
  Copy,
  ExternalLink,
  RadioTower,
  X,
} from 'lucide-react';
import * as maplibregl from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Feature, FeatureCollection, Point } from 'geojson';
import {
  OPENFREEMAP_STYLES,
  computeHighQualityMapPixelRatio,
  resolveMapStyleInput,
  type OpenFreeMapStyleOption,
} from '../../types/antena';
import {
  UNICO_FASE_META,
  UNICO_OPERATOR_META,
  UNICO_OPERATOR_ORDER,
  type UnicoAntennaRecord,
  type UnicoBounds,
  type UnicoColorMode,
  type UnicoFase,
  type UnicoOperatorKey,
} from '../../types/unico5g';

if (typeof window !== 'undefined') {
  maplibregl.setWorkerUrl(
    new URL(maplibreWorkerUrl, window.location.href).href,
  );
}

export interface Unico5gMapProps {
  antenas: readonly UnicoAntennaRecord[];
  selectedAntenna: UnicoAntennaRecord | null;
  onSelectAntenna: (antenna: UnicoAntennaRecord | null) => void;
  colorMode: UnicoColorMode;
  onColorModeChange: (mode: UnicoColorMode) => void;
  focusBounds: UnicoBounds | null;
  focusBoundsKey: string;
  focusPoint: { lat: number; lon: number; zoom?: number; seq: number } | null;
  styleId: OpenFreeMapStyleOption['id'];
  onStyleChange: (styleId: OpenFreeMapStyleOption['id']) => void;
}

interface UnicoFeatureProperties {
  id: string;
  fase: UnicoFase;
  op: UnicoOperatorKey;
  empresa: string;
  ccaa: string;
  prov: string;
  mun: string;
  lat: number;
  lon: number;
}

const UNICO_SOURCE_ID = 'unico-antenas-source';
const LAYER_CLUSTERS = 'unico-clusters';
const LAYER_CLUSTER_COUNT = 'unico-cluster-count';
const LAYER_FASE2_HALO = 'unico-fase2-halo';
const LAYER_UNCLUSTERED = 'unico-unclustered';
const LAYER_SELECTED_HALO = 'unico-selected-halo';
const LAYER_SELECTED_RING = 'unico-selected-ring';

const NONE_SELECTED_ID = '__none__';

const DEFAULT_CENTER: [number, number] = [-3.7038, 40.2];
const DEFAULT_ZOOM = 5.3;

const UNICO_REGION_JUMPS = [
  { id: 'peninsula', label: 'Península', lon: -3.7038, lat: 40.2, zoom: 5.3 },
  { id: 'canarias', label: 'Canarias', lon: -15.6, lat: 28.32, zoom: 6.8 },
  { id: 'baleares', label: 'Baleares', lon: 2.95, lat: 39.58, zoom: 7.5 },
] as const;

function isOpenFreeMapStyleId(
  value: string,
): value is OpenFreeMapStyleOption['id'] {
  return OPENFREEMAP_STYLES.some((opt) => opt.id === value);
}

function isUnicoOperatorKey(value: unknown): value is UnicoOperatorKey {
  return (
    value === 'movistar' ||
    value === 'orange' ||
    value === 'vodafone' ||
    value === 'avatel'
  );
}

function normalizeUnicoFase(value: unknown): UnicoFase {
  return Number(value) === 2 ? 2 : 1;
}

function buildUnclusteredColorExpr(
  colorMode: UnicoColorMode,
): maplibregl.ExpressionSpecification {
  if (colorMode === 'fase') {
    return [
      'match',
      ['get', 'fase'],
      1,
      UNICO_FASE_META[1].color,
      2,
      UNICO_FASE_META[2].color,
      UNICO_FASE_META[1].color,
    ] as maplibregl.ExpressionSpecification;
  }

  return [
    'match',
    ['get', 'op'],
    'movistar',
    UNICO_OPERATOR_META.movistar.color,
    'orange',
    UNICO_OPERATOR_META.orange.color,
    'vodafone',
    UNICO_OPERATOR_META.vodafone.color,
    'avatel',
    UNICO_OPERATOR_META.avatel.color,
    UNICO_OPERATOR_META.movistar.color,
  ] as maplibregl.ExpressionSpecification;
}

function buildSelectedFilter(
  selectedId: string | null | undefined,
): maplibregl.FilterSpecification {
  return [
    'all',
    ['!', ['has', 'point_count']],
    ['==', ['get', 'id'], selectedId ?? NONE_SELECTED_ID],
  ];
}

export function Unico5gMap({
  antenas,
  selectedAntenna,
  onSelectAntenna,
  colorMode,
  onColorModeChange,
  focusBounds,
  focusBoundsKey,
  focusPoint,
  styleId,
  onStyleChange,
}: Unico5gMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const appliedStyleIdRef = useRef<OpenFreeMapStyleOption['id']>(styleId);
  const lastAppliedGeoJsonRef = useRef<FeatureCollection<
    Point,
    UnicoFeatureProperties
  > | null>(null);
  const lastFocusBoundsKeyRef = useRef<string>('all');
  const lastFocusPointSeqRef = useRef<number | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  const [copiedForId, setCopiedForId] = useState<string | null>(null);

  const currentStyle = useMemo(
    () =>
      OPENFREEMAP_STYLES.find((opt) => opt.id === styleId) ??
      OPENFREEMAP_STYLES[0],
    [styleId],
  );

  const { antenasGeoJson, antenasById } = useMemo(() => {
    const byId = new Map<string, UnicoAntennaRecord>();
    const features: Feature<Point, UnicoFeatureProperties>[] = [];

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
          id: ant.id,
          fase: ant.fase,
          op: ant.op,
          empresa: ant.empresa,
          ccaa: ant.ccaa,
          prov: ant.prov,
          mun: ant.mun,
          lat: ant.lat,
          lon: ant.lon,
        },
      });
    }

    const collection: FeatureCollection<Point, UnicoFeatureProperties> = {
      type: 'FeatureCollection',
      features,
    };

    return {
      antenasGeoJson: collection,
      antenasById: byId,
    };
  }, [antenas]);

  const antenasGeoJsonRef = useRef(antenasGeoJson);
  const antenasByIdRef = useRef(antenasById);
  const colorModeRef = useRef(colorMode);
  const selectedAntennaRef = useRef(selectedAntenna);
  const onSelectAntennaRef = useRef(onSelectAntenna);
  const isDarkStyleRef = useRef(currentStyle.isDark);

  useEffect(() => {
    antenasGeoJsonRef.current = antenasGeoJson;
    antenasByIdRef.current = antenasById;
  }, [antenasGeoJson, antenasById]);

  useEffect(() => {
    colorModeRef.current = colorMode;
  }, [colorMode]);

  useEffect(() => {
    selectedAntennaRef.current = selectedAntenna;
    onSelectAntennaRef.current = onSelectAntenna;
  }, [selectedAntenna, onSelectAntenna]);

  useEffect(() => {
    isDarkStyleRef.current = currentStyle.isDark;
  }, [currentStyle.isDark]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!selectedAntenna) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onSelectAntennaRef.current(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectedAntenna]);

  const ensureCustomSourcesAndLayers = useCallback((map: maplibregl.Map) => {
    if (!map.getStyle()) {
      return;
    }

    const isDark = isDarkStyleRef.current;
    const activeColorMode = colorModeRef.current;
    const selectedFilter = buildSelectedFilter(selectedAntennaRef.current?.id);
    const clusterStrokeColor = isDark
      ? 'rgba(15, 23, 42, 0.9)'
      : 'rgba(255, 255, 255, 0.92)';
    const pointStrokeColor = isDark ? 'rgba(15, 23, 42, 0.92)' : '#FFFFFF';
    const selectedRingStroke = isDark ? '#38BDF8' : '#0F172A';
    const fase2HaloVisibility =
      activeColorMode === 'operator' ? 'visible' : 'none';

    if (!map.getSource(UNICO_SOURCE_ID)) {
      map.addSource(UNICO_SOURCE_ID, {
        type: 'geojson',
        data: antenasGeoJsonRef.current,
        cluster: true,
        clusterMaxZoom: 12,
        clusterRadius: 44,
      });
      lastAppliedGeoJsonRef.current = antenasGeoJsonRef.current;
    }

    if (!map.getLayer(LAYER_CLUSTERS)) {
      map.addLayer({
        id: LAYER_CLUSTERS,
        type: 'circle',
        source: UNICO_SOURCE_ID,
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': [
            'step',
            ['get', 'point_count'],
            '#0284C7',
            25,
            '#0369A1',
            100,
            '#0F4C81',
            400,
            '#1E293B',
          ] as maplibregl.ExpressionSpecification,
          'circle-radius': [
            'step',
            ['get', 'point_count'],
            15,
            25,
            18.5,
            100,
            22.5,
            400,
            26.5,
          ] as maplibregl.ExpressionSpecification,
          'circle-stroke-width': 2,
          'circle-stroke-color': clusterStrokeColor,
        },
      });
    } else {
      map.setPaintProperty(
        LAYER_CLUSTERS,
        'circle-stroke-color',
        clusterStrokeColor,
      );
    }

    if (!map.getLayer(LAYER_CLUSTER_COUNT)) {
      map.addLayer({
        id: LAYER_CLUSTER_COUNT,
        type: 'symbol',
        source: UNICO_SOURCE_ID,
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11.5,
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          'text-color': '#FFFFFF',
          'text-halo-color': 'rgba(15, 23, 42, 0.35)',
          'text-halo-width': 0.8,
        },
      });
    }

    if (!map.getLayer(LAYER_FASE2_HALO)) {
      map.addLayer({
        id: LAYER_FASE2_HALO,
        type: 'circle',
        source: UNICO_SOURCE_ID,
        filter: [
          'all',
          ['!', ['has', 'point_count']],
          ['==', ['get', 'fase'], 2],
        ],
        layout: {
          visibility: fase2HaloVisibility,
        },
        paint: {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            4,
            6.6,
            7,
            8,
            10,
            9.6,
            13,
            11.5,
            16,
            14,
          ],
          'circle-color': 'rgba(245, 158, 11, 0.14)',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#F59E0B',
          'circle-pitch-scale': 'viewport',
        },
      });
    } else {
      map.setLayoutProperty(
        LAYER_FASE2_HALO,
        'visibility',
        fase2HaloVisibility,
      );
    }

    if (!map.getLayer(LAYER_UNCLUSTERED)) {
      map.addLayer({
        id: LAYER_UNCLUSTERED,
        type: 'circle',
        source: UNICO_SOURCE_ID,
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': buildUnclusteredColorExpr(activeColorMode),
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            4,
            4,
            7,
            5.2,
            10,
            6.5,
            13,
            8,
            16,
            10,
          ],
          'circle-stroke-width': 1.4,
          'circle-stroke-color': pointStrokeColor,
          'circle-pitch-scale': 'viewport',
        },
      });
    } else {
      map.setPaintProperty(
        LAYER_UNCLUSTERED,
        'circle-color',
        buildUnclusteredColorExpr(activeColorMode),
      );
      map.setPaintProperty(
        LAYER_UNCLUSTERED,
        'circle-stroke-color',
        pointStrokeColor,
      );
    }

    if (!map.getLayer(LAYER_SELECTED_HALO)) {
      map.addLayer({
        id: LAYER_SELECTED_HALO,
        type: 'circle',
        source: UNICO_SOURCE_ID,
        filter: selectedFilter,
        paint: {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            4,
            12,
            8,
            15,
            12,
            19,
            16,
            24,
          ],
          'circle-color': '#0EA5E9',
          'circle-opacity': 0.22,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': 'rgba(14, 165, 233, 0.65)',
          'circle-pitch-scale': 'viewport',
        },
      });
    } else {
      map.setFilter(LAYER_SELECTED_HALO, selectedFilter);
    }

    if (!map.getLayer(LAYER_SELECTED_RING)) {
      map.addLayer({
        id: LAYER_SELECTED_RING,
        type: 'circle',
        source: UNICO_SOURCE_ID,
        filter: selectedFilter,
        paint: {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            4,
            8,
            8,
            10.2,
            12,
            13,
            16,
            16.5,
          ],
          'circle-color': 'rgba(14, 165, 233, 0.06)',
          'circle-stroke-width': 3,
          'circle-stroke-color': selectedRingStroke,
          'circle-pitch-scale': 'viewport',
        },
      });
    } else {
      map.setFilter(LAYER_SELECTED_RING, selectedFilter);
      map.setPaintProperty(
        LAYER_SELECTED_RING,
        'circle-stroke-color',
        selectedRingStroke,
      );
    }
  }, []);

  // Inicialización única del lienzo MapLibre GL dentro de useEffect (seguro para SSR / Node)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const initialStyle =
      OPENFREEMAP_STYLES.find((opt) => opt.id === appliedStyleIdRef.current) ??
      OPENFREEMAP_STYLES[0];

    const map = new maplibregl.Map({
      container,
      style: resolveMapStyleInput(initialStyle),
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      pitch: 0,
      maxPitch: 0,
      pitchWithRotate: false,
      dragRotate: false,
      minZoom: 2,
      maxZoom: 20,
      anisotropicFilterPitch: 0,
      pixelRatio: computeHighQualityMapPixelRatio(
        typeof window !== 'undefined' ? window.devicePixelRatio : 1,
      ),
      maxCanvasSize: [8192, 8192],
      canvasContextAttributes: {
        antialias: true,
      },
      attributionControl: false,
    });

    map.touchPitch?.disable();
    map.touchZoomRotate?.disableRotation();

    map.addControl(
      new maplibregl.NavigationControl({
        visualizePitch: false,
        showCompass: false,
        showZoom: true,
      }),
      'bottom-right',
    );
    map.addControl(
      new maplibregl.ScaleControl({ maxWidth: 100, unit: 'metric' }),
      'bottom-right',
    );
    map.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      'bottom-right',
    );

    mapRef.current = map;

    const handleStyleLoad = () => {
      map.setMaxPitch(0);
      map.touchPitch?.disable();
      ensureCustomSourcesAndLayers(map);
      const source = map.getSource(UNICO_SOURCE_ID) as
        | maplibregl.GeoJSONSource
        | undefined;
      if (source && lastAppliedGeoJsonRef.current !== antenasGeoJsonRef.current) {
        source.setData(antenasGeoJsonRef.current);
        lastAppliedGeoJsonRef.current = antenasGeoJsonRef.current;
      }
    };

    const handleStyleData = () => {
      if (map.isStyleLoaded()) {
        ensureCustomSourcesAndLayers(map);
      }
    };

    const getUnclusteredQueryLayers = (): string[] => {
      const layers: string[] = [];
      if (map.getLayer(LAYER_UNCLUSTERED)) {
        layers.push(LAYER_UNCLUSTERED);
      }
      if (
        colorModeRef.current === 'operator' &&
        map.getLayer(LAYER_FASE2_HALO)
      ) {
        layers.push(LAYER_FASE2_HALO);
      }
      return layers;
    };

    const handleMapClick = (event: maplibregl.MapMouseEvent) => {
      const unclusteredLayers = getUnclusteredQueryLayers();

      if (unclusteredLayers.length > 0) {
        const pointFeatures = map.queryRenderedFeatures(event.point, {
          layers: unclusteredLayers,
        });
        if (pointFeatures.length > 0) {
          const topFeature = pointFeatures[0];
          const rawProps = topFeature.properties as Record<string, unknown>;
          const featureId = String(rawProps.id ?? '');
          const matchedRecord = antenasByIdRef.current.get(featureId);

          if (matchedRecord) {
            onSelectAntennaRef.current(matchedRecord);
            return;
          }

          if (featureId) {
            const fallbackCoords =
              topFeature.geometry.type === 'Point'
                ? topFeature.geometry.coordinates
                : [event.lngLat.lng, event.lngLat.lat];

            const reconstructed: UnicoAntennaRecord = {
              id: featureId,
              fase: normalizeUnicoFase(rawProps.fase),
              op: isUnicoOperatorKey(rawProps.op) ? rawProps.op : 'movistar',
              empresa: String(rawProps.empresa ?? ''),
              ccaa: String(rawProps.ccaa ?? ''),
              prov: String(rawProps.prov ?? ''),
              mun: String(rawProps.mun ?? ''),
              lat: Number(rawProps.lat ?? fallbackCoords[1]),
              lon: Number(rawProps.lon ?? fallbackCoords[0]),
            };
            onSelectAntennaRef.current(reconstructed);
            return;
          }
        }
      }

      if (map.getLayer(LAYER_CLUSTERS)) {
        const clusterFeatures = map.queryRenderedFeatures(event.point, {
          layers: [LAYER_CLUSTERS],
        });
        if (clusterFeatures.length > 0) {
          const clusterFeature = clusterFeatures[0];
          const clusterId = Number(clusterFeature.properties?.cluster_id);
          const source = map.getSource(UNICO_SOURCE_ID) as
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
                  zoom: Math.min(expansionZoom, 16.5),
                  duration: 480,
                });
              })
              .catch(() => {
                // Ignorar si el estilo o la fuente cambian durante la expansión
              });
            return;
          }
        }
      }

      onSelectAntennaRef.current(null);
    };

    const handleMouseMove = (event: maplibregl.MapMouseEvent) => {
      const interactiveLayers = getUnclusteredQueryLayers();
      if (map.getLayer(LAYER_CLUSTERS)) {
        interactiveLayers.push(LAYER_CLUSTERS);
      }

      if (interactiveLayers.length === 0) {
        map.getCanvas().style.cursor = '';
        return;
      }

      const hits = map.queryRenderedFeatures(event.point, {
        layers: interactiveLayers,
      });
      map.getCanvas().style.cursor = hits.length > 0 ? 'pointer' : '';
    };

    const handleCanvasLeave = () => {
      map.getCanvas().style.cursor = '';
    };

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            map.resize();
          })
        : null;
    resizeObserver?.observe(container);

    map.on('load', handleStyleLoad);
    map.on('style.load', handleStyleLoad);
    map.on('styledata', handleStyleData);
    map.on('click', handleMapClick);
    map.on('mousemove', handleMouseMove);
    map.getCanvas().addEventListener('mouseleave', handleCanvasLeave);

    return () => {
      resizeObserver?.disconnect();
      map.getCanvas().removeEventListener('mouseleave', handleCanvasLeave);
      map.remove();
      mapRef.current = null;
      lastAppliedGeoJsonRef.current = null;
    };
  }, [ensureCustomSourcesAndLayers]);

  // Cambio dinámico de estilo cartográfico preservando la fuente GeoJSON y las capas personalizadas
  useEffect(() => {
    isDarkStyleRef.current = currentStyle.isDark;
    const map = mapRef.current;
    if (!map || appliedStyleIdRef.current === styleId) {
      return;
    }

    appliedStyleIdRef.current = styleId;
    lastAppliedGeoJsonRef.current = null;
    map.setStyle(resolveMapStyleInput(currentStyle), { diff: false });
  }, [styleId, currentStyle]);

  // Sincronización reactiva de datos filtrados hacia la fuente clusterizada
  useEffect(() => {
    antenasGeoJsonRef.current = antenasGeoJson;
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const source = map.getSource(UNICO_SOURCE_ID) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (source && lastAppliedGeoJsonRef.current !== antenasGeoJson) {
      source.setData(antenasGeoJson);
      lastAppliedGeoJsonRef.current = antenasGeoJson;
    }
  }, [antenasGeoJson]);

  // Sincronización inmediata en GPU del modo de color (Operador + halo Fase 2 vs Fase)
  useEffect(() => {
    colorModeRef.current = colorMode;
    const map = mapRef.current;
    if (!map) {
      return;
    }
    if (map.getLayer(LAYER_UNCLUSTERED)) {
      map.setPaintProperty(
        LAYER_UNCLUSTERED,
        'circle-color',
        buildUnclusteredColorExpr(colorMode),
      );
    }
    if (map.getLayer(LAYER_FASE2_HALO)) {
      map.setLayoutProperty(
        LAYER_FASE2_HALO,
        'visibility',
        colorMode === 'operator' ? 'visible' : 'none',
      );
    }
  }, [colorMode]);

  // Sincronización instantánea en GPU del halo y anillo de selección
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

  // Encuadre automático al cambiar el ámbito territorial (focusBoundsKey / focusBounds)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || lastFocusBoundsKeyRef.current === focusBoundsKey) {
      return;
    }

    if (focusBoundsKey === 'all') {
      lastFocusBoundsKeyRef.current = 'all';
      map.flyTo({
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        duration: 750,
        essential: true,
      });
      return;
    }

    if (
      focusBounds &&
      Number.isFinite(focusBounds.minLon) &&
      Number.isFinite(focusBounds.minLat) &&
      Number.isFinite(focusBounds.maxLon) &&
      Number.isFinite(focusBounds.maxLat)
    ) {
      lastFocusBoundsKeyRef.current = focusBoundsKey;
      map.fitBounds(
        [
          [focusBounds.minLon, focusBounds.minLat],
          [focusBounds.maxLon, focusBounds.maxLat],
        ],
        {
          padding: 48,
          maxZoom: 13.5,
          duration: 750,
          essential: true,
        },
      );
    }
  }, [focusBounds, focusBoundsKey]);

  // Vuelo puntual al seleccionar una fila de la tabla o una coordenada específica
  useEffect(() => {
    const map = mapRef.current;
    if (
      !map ||
      !focusPoint ||
      !Number.isFinite(focusPoint.lat) ||
      !Number.isFinite(focusPoint.lon)
    ) {
      return;
    }
    if (lastFocusPointSeqRef.current === focusPoint.seq) {
      return;
    }
    lastFocusPointSeqRef.current = focusPoint.seq;
    map.resize();
    map.flyTo({
      center: [focusPoint.lon, focusPoint.lat],
      zoom: focusPoint.zoom ?? 14,
      duration: 750,
      essential: true,
    });
  }, [focusPoint]);

  const handleJumpToRegion = useCallback(
    (lon: number, lat: number, zoom: number) => {
      const map = mapRef.current;
      if (!map) {
        return;
      }
      map.flyTo({
        center: [lon, lat],
        zoom,
        duration: 750,
        essential: true,
      });
    },
    [],
  );

  const handleCopyCoordinates = useCallback(() => {
    if (!selectedAntenna) {
      return;
    }
    const text = `${selectedAntenna.lat.toFixed(6)}, ${selectedAntenna.lon.toFixed(6)}`;
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).catch(() => {
        // Ignorar si el navegador restringe el acceso al portapapeles
      });
    }
    setCopiedForId(selectedAntenna.id);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => {
      setCopiedForId(null);
      copyTimerRef.current = null;
    }, 1800);
  }, [selectedAntenna]);

  const selectedOperatorMeta = selectedAntenna
    ? UNICO_OPERATOR_META[selectedAntenna.op]
    : null;
  const selectedFaseMeta = selectedAntenna
    ? UNICO_FASE_META[selectedAntenna.fase]
    : null;
  const isCoordsCopied =
    selectedAntenna !== null && copiedForId === selectedAntenna.id;

  return (
    <div
      className="unico-map-shell"
      data-map-dark={currentStyle.isDark ? 'true' : 'false'}
    >
      <div
        ref={containerRef}
        className="unico-map-canvas"
        id="unico-5g-map-canvas"
        aria-label="Mapa interactivo de antenas subvencionadas del programa UNICO 5G Redes Activas"
      />

      {/* Barra flotante superior izquierda: Modo de color y saltos geográficos rápidos */}
      <div
        className="unico-map-toolbar-tl"
        role="toolbar"
        aria-label="Controles de visualización del mapa UNICO 5G"
      >
        <div
          className="unico-map-pill-group"
          role="group"
          aria-label="Colorear antenas por"
        >
          <button
            id="unico-map-color-operator"
            type="button"
            className={`unico-map-pill unico-map-pill-btn${colorMode === 'operator' ? ' is-active' : ''}`}
            aria-pressed={colorMode === 'operator'}
            onClick={() => onColorModeChange('operator')}
          >
            Por operador
          </button>
          <button
            id="unico-map-color-fase"
            type="button"
            className={`unico-map-pill unico-map-pill-btn${colorMode === 'fase' ? ' is-active' : ''}`}
            aria-pressed={colorMode === 'fase'}
            onClick={() => onColorModeChange('fase')}
          >
            Por fase
          </button>
        </div>

        <div
          className="unico-map-pill-group"
          role="group"
          aria-label="Saltos rápidos de región"
        >
          {UNICO_REGION_JUMPS.map((region) => (
            <button
              key={region.id}
              id={`unico-map-region-${region.id}`}
              type="button"
              className="unico-map-pill unico-map-pill-btn"
              onClick={() =>
                handleJumpToRegion(region.lon, region.lat, region.zoom)
              }
              title={`Centrar vista en ${region.label}`}
            >
              {region.label}
            </button>
          ))}
        </div>
      </div>

      {/* Selector de estilo cartográfico superior derecho */}
      <select
        id="unico-map-style-select"
        className="unico-map-style-select"
        aria-label="Estilo cartográfico del mapa"
        value={currentStyle.id}
        onChange={(event) => {
          const nextValue = event.target.value;
          if (isOpenFreeMapStyleId(nextValue)) {
            onStyleChange(nextValue);
          }
        }}
      >
        {OPENFREEMAP_STYLES.map((styleOpt) => (
          <option key={styleOpt.id} value={styleOpt.id}>
            Mapa: {styleOpt.label}
          </option>
        ))}
      </select>

      {/* Leyenda viva compacta inferior izquierda */}
      <div
        className="unico-map-legend"
        aria-label="Leyenda del mapa UNICO 5G Redes Activas"
      >
        <div className="unico-map-legend-head">
          <span className="unico-map-legend-title">
            {colorMode === 'operator' ? 'Adjudicatarios' : 'Convocatorias'}
          </span>
          <span
            className="unico-map-legend-badge"
            title="Total de antenas visibles en el filtro activo"
          >
            {new Intl.NumberFormat('es-ES', { useGrouping: 'always' }).format(
              antenas.length,
            )}{' '}
            antenas
          </span>
        </div>

        <div className="unico-map-legend-items">
          {colorMode === 'operator' ? (
            <>
              {UNICO_OPERATOR_ORDER.map((opKey) => {
                const meta = UNICO_OPERATOR_META[opKey];
                return (
                  <span key={opKey} className="unico-map-legend-item">
                    <span
                      className="unico-map-legend-dot"
                      style={{
                        display: 'inline-block',
                        width: 9,
                        height: 9,
                        borderRadius: '50%',
                        backgroundColor: meta.color,
                        flexShrink: 0,
                      }}
                      aria-hidden="true"
                    />
                    <span className="unico-map-legend-label">
                      {meta.shortName}
                    </span>
                  </span>
                );
              })}
              <span className="unico-map-legend-item unico-map-legend-note">
                <span
                  className="unico-map-legend-ring"
                  style={{
                    display: 'inline-block',
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    border: '2px solid #F59E0B',
                    backgroundColor: 'rgba(245, 158, 11, 0.16)',
                    flexShrink: 0,
                  }}
                  aria-hidden="true"
                />
                <span className="unico-map-legend-label">Anillo = Fase 2</span>
              </span>
            </>
          ) : (
            <>
              {([1, 2] as const).map((faseNum) => {
                const fMeta = UNICO_FASE_META[faseNum];
                return (
                  <span key={faseNum} className="unico-map-legend-item">
                    <span
                      className="unico-map-legend-dot"
                      style={{
                        display: 'inline-block',
                        width: 9,
                        height: 9,
                        borderRadius: '50%',
                        backgroundColor: fMeta.color,
                        flexShrink: 0,
                      }}
                      aria-hidden="true"
                    />
                    <span className="unico-map-legend-label">
                      {fMeta.shortLabel} · {fMeta.convocatoria}
                    </span>
                  </span>
                );
              })}
            </>
          )}
        </div>
      </div>

      {/* Ficha flotante de antena seleccionada (sin códigos de emplazamiento ni IDs de propietario) */}
      {selectedAntenna && selectedOperatorMeta && selectedFaseMeta && (
        <aside
          className="unico-map-selected-card"
          aria-label={`Detalle de antena subvencionada en ${selectedAntenna.mun}`}
        >
          <div className="unico-map-selected-head">
            <div className="unico-map-selected-badges">
              <span
                className="unico-map-op-badge"
                style={{
                  backgroundColor: selectedOperatorMeta.softBg,
                  borderColor: selectedOperatorMeta.borderTint,
                }}
              >
                <span
                  className="unico-map-op-dot"
                  style={{
                    display: 'inline-block',
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    backgroundColor: selectedOperatorMeta.color,
                    flexShrink: 0,
                  }}
                  aria-hidden="true"
                />
                <span>{selectedOperatorMeta.shortName}</span>
              </span>

              <span
                className="unico-map-fase-badge"
                style={{
                  backgroundColor: selectedFaseMeta.softBg,
                }}
              >
                {selectedFaseMeta.shortLabel} · {selectedFaseMeta.convocatoria}
              </span>
            </div>

            <button
              type="button"
              className="unico-map-selected-close"
              onClick={() => onSelectAntenna(null)}
              aria-label="Cerrar ficha de antena seleccionada"
              title="Cerrar (Esc)"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>

          <div className="unico-map-selected-body">
            <h3 className="unico-map-selected-mun">{selectedAntenna.mun}</h3>
            <p className="unico-map-selected-terr">
              {selectedAntenna.prov} · {selectedAntenna.ccaa}
            </p>

            <div className="unico-map-selected-field">
              <span className="unico-map-selected-field-label">
                Entidad adjudicataria
              </span>
              <span className="unico-map-selected-field-value">
                {selectedAntenna.empresa}
              </span>
            </div>

            <div className="unico-map-selected-coords-row">
              <div className="unico-map-selected-coords">
                <span className="unico-map-selected-field-label">
                  Coordenadas WGS84
                </span>
                <code className="unico-map-selected-coords-code">
                  {selectedAntenna.lat.toFixed(6)},{' '}
                  {selectedAntenna.lon.toFixed(6)}
                </code>
              </div>

              <button
                type="button"
                className={`unico-map-copy-btn${isCoordsCopied ? ' is-copied' : ''}`}
                onClick={handleCopyCoordinates}
                title="Copiar coordenadas decimales WGS84"
              >
                {isCoordsCopied ? (
                  <>
                    <Check size={13} aria-hidden="true" />
                    <span>Copiado</span>
                  </>
                ) : (
                  <>
                    <Copy size={13} aria-hidden="true" />
                    <span>Copiar</span>
                  </>
                )}
              </button>
            </div>
          </div>

          <div className="unico-map-selected-actions">
            <Link
              to="/"
              search={{
                lat: selectedAntenna.lat,
                lon: selectedAntenna.lon,
              }}
              className="unico-map-action-btn is-primary"
            >
              <RadioTower size={13} aria-hidden="true" />
              <span>Ver entorno en RadioMapa</span>
            </Link>

            <a
              href={`https://www.google.com/maps?q=&layer=c&cbll=${selectedAntenna.lat},${selectedAntenna.lon}`}
              target="_blank"
              rel="noopener noreferrer"
              className="unico-map-action-btn"
            >
              <ExternalLink size={13} aria-hidden="true" />
              <span>Street View</span>
            </a>
          </div>
        </aside>
      )}
    </div>
  );
}
