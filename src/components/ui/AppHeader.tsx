import { Link } from '@tanstack/react-router';
import {
  BarChart3,
  Map as MapIcon,
  Moon,
  Sun,
  Table2,
} from 'lucide-react';
import { useAntenasData } from '../../hooks/useAntenasData';
import { useWorkspace } from '../../hooks/useWorkspace';
import {
  formatDateTimeEs,
  formatRelativeDateEs,
} from '../../utils/export';

export function AppHeader() {
  const { derived, isLoading } = useAntenasData();
  const { theme, toggleTheme } = useWorkspace();

  const totalFormatted = derived
    ? derived.dataset.total.toLocaleString('es-ES')
    : null;
  const relativeDate = derived
    ? formatRelativeDateEs(derived.dataset.updatedAt)
    : '';
  const exactDate = derived
    ? formatDateTimeEs(derived.dataset.updatedAt)
    : '';

  return (
    <header className="app-header" role="banner">
      <nav className="header-nav" aria-label="Navegación principal">
        <Link
          to="/"
          activeOptions={{ exact: true }}
          className="nav-tab"
          id="nav-tab-mapa"
        >
          <MapIcon size={15} aria-hidden="true" />
          <span className="nav-label-full">Mapa Interactivo</span>
          <span className="nav-label-short">Mapa</span>
        </Link>
        <Link
          to="/explorar"
          className="nav-tab"
          id="nav-tab-explorar"
        >
          <Table2 size={15} aria-hidden="true" />
          <span className="nav-label-full">Explorador de Datos</span>
          <span className="nav-label-short">Explorar</span>
        </Link>
        <Link
          to="/estadisticas"
          className="nav-tab"
          id="nav-tab-estadisticas"
        >
          <BarChart3 size={15} aria-hidden="true" />
          <span className="nav-label-full">Estadísticas</span>
          <span className="nav-label-short">Datos</span>
        </Link>
      </nav>

      <div className="header-actions">
        <div
          className="dataset-live-badge"
          title={
            exactDate
              ? `Última sincronización oficial: ${exactDate}`
              : 'Cargando censo oficial de estaciones...'
          }
        >
          <span className="dataset-live-dot" aria-hidden="true" />
          {isLoading || !totalFormatted ? (
            <span className="dataset-live-date">Sincronizando censo…</span>
          ) : (
            <>
              <span className="dataset-live-count">{totalFormatted} est.</span>
              {relativeDate && (
                <>
                  <span className="dataset-live-sep" aria-hidden="true">
                    ·
                  </span>
                  <span className="dataset-live-date">{relativeDate}</span>
                </>
              )}
            </>
          )}
        </div>

        <button
          type="button"
          className="icon-btn"
          onClick={toggleTheme}
          id="theme-toggle-btn"
          aria-label={
            theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'
          }
          title={
            theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'
          }
        >
          {theme === 'dark' ? (
            <Sun size={15} aria-hidden="true" />
          ) : (
            <Moon size={15} aria-hidden="true" />
          )}
        </button>
      </div>
    </header>
  );
}
