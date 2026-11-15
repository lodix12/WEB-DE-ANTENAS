import { Link } from '@tanstack/react-router';
import {
  BarChart3,
  BookOpen,
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
      <Link to="/" className="brand-link" id="header-brand-link">
        <span className="brand-mark" aria-hidden="true">
          <svg
            width="20"
            height="20"
            viewBox="0 0 32 32"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M8.5 21.8a10.2 10.2 0 0 1 0-14.2M23.5 7.6a10.2 10.2 0 0 1 0 14.2"
              stroke="currentColor"
              strokeWidth="2.3"
              strokeLinecap="round"
            />
            <path
              d="M12 18.6a5.5 5.5 0 0 1 0-7.8M20 10.8a5.5 5.5 0 0 1 0 7.8"
              stroke="#38BDF8"
              strokeWidth="2.3"
              strokeLinecap="round"
            />
            <circle cx="16" cy="14.7" r="2.3" fill="#F8FAFC" />
            <path
              d="M16 17v8.5M12.2 25.5h7.6"
              stroke="#F8FAFC"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <span className="brand-text">
          <span className="brand-title">RadioMapa España</span>
          <span className="brand-subtitle">
            Censo de Estaciones Móviles · Fuente Infoantenas
          </span>
        </span>
      </Link>

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
        <Link
          to="/metodologia"
          className="nav-tab"
          id="nav-tab-metodologia"
        >
          <BookOpen size={15} aria-hidden="true" />
          <span className="nav-label-full">Bandas y Metodología</span>
          <span className="nav-label-short">Bandas RF</span>
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
