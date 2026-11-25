import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Download } from 'lucide-react';
import type { AntennaRecord } from '../../types/antena';
import type { RadarPoint } from '../../types/map';
import {
  exportAntenasToCSV,
  exportAntenasToGeoJSON,
  exportAntenasToJSON,
} from '../../utils/export';

export interface ExportMenuProps {
  antenas: AntennaRecord[];
  radarPoint?: RadarPoint | null;
  align?: 'left' | 'right';
  idPrefix?: string;
}

export function ExportMenu({
  antenas,
  radarPoint,
  align = 'right',
  idPrefix = 'export',
}: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleOutside(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleEsc(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [open]);

  const countFormatted = antenas.length.toLocaleString('es-ES');

  return (
    <div className="export-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        id={`${idPrefix}-menu-trigger`}
        className="icon-btn"
        disabled={antenas.length === 0}
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Exportar ${countFormatted} estaciones filtradas`}
      >
        <Download size={14} aria-hidden="true" />
        <span>Exportar</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>

      {open && (
        <div
          className={`export-dropdown ${align === 'left' ? 'align-left' : ''}`}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            id={`${idPrefix}-json-btn`}
            className="export-option"
            onClick={() => {
              exportAntenasToJSON(antenas, radarPoint);
              setOpen(false);
            }}
          >
            <span className="export-option-title">
              <span>JSON Propio (.json)</span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--accent-primary)' }}>
                {countFormatted}
              </span>
            </span>
            <span className="export-option-desc">
              Esquema compacto nativo de Redes Moviles España para integraciones y datos abiertos
              {radarPoint ? ' (incluye distancia y acimut)' : ''}
            </span>
          </button>

          <button
            type="button"
            role="menuitem"
            id={`${idPrefix}-csv-btn`}
            className="export-option"
            onClick={() => {
              exportAntenasToCSV(antenas, radarPoint);
              setOpen(false);
            }}
          >
            <span className="export-option-title">
              <span>Tabla CSV (.csv)</span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--accent-primary)' }}>
                {countFormatted}
              </span>
            </span>
            <span className="export-option-desc">
              Compatible con Excel, LibreOffice y análisis de cobertura
              {radarPoint ? ' (incluye distancia y acimut)' : ''}
            </span>
          </button>

          <button
            type="button"
            role="menuitem"
            id={`${idPrefix}-geojson-btn`}
            className="export-option"
            onClick={() => {
              exportAntenasToGeoJSON(antenas);
              setOpen(false);
            }}
          >
            <span className="export-option-title">
              <span>GeoJSON (.geojson)</span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                SIG externo
              </span>
            </span>
            <span className="export-option-desc">
              Opción secundaria de compatibilidad para QGIS o ArcGIS
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
