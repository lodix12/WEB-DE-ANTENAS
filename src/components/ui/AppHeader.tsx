import { useEffect } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import {
  BarChart3,
  LayoutGrid,
  Map as MapIcon,
  Moon,
  Sparkles,
  Sun,
  X,
} from 'lucide-react';
import { useAntenasData } from '../../hooks/useAntenasData';
import { useNovedadesData } from '../../hooks/useNovedadesData';
import { useWorkspace } from '../../hooks/useWorkspace';
import {
  formatDateTimeEs,
  formatRelativeDateEs,
} from '../../utils/export';

export function AppHeader() {
  const { derived, isLoading } = useAntenasData();
  const { data: novedadesData } = useNovedadesData();
  const {
    theme,
    toggleTheme,
    sectionsMenuOpen,
    setSectionsMenuOpen,
  } = useWorkspace();

  const pathname = useLocation({ select: (loc) => loc.pathname });
  const isMapRoute = pathname === '/' || pathname === '';

  useEffect(() => {
    if (!sectionsMenuOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSectionsMenuOpen(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [sectionsMenuOpen, setSectionsMenuOpen]);

  const totalFormatted = derived
    ? derived.dataset.total.toLocaleString('es-ES')
    : null;
  const novedadesCount =
    novedadesData && novedadesData.total > 0 ? novedadesData.total : 0;
  const relativeDate = derived
    ? formatRelativeDateEs(derived.dataset.updatedAt)
    : '';
  const exactDate = derived
    ? formatDateTimeEs(derived.dataset.updatedAt)
    : '';

  return (
    <>
      {!isMapRoute && (
        <button
          type="button"
          id="page-open-sections-btn"
          className="btn btn-secondary btn-sm page-floating-sections-btn"
          onClick={() => setSectionsMenuOpen(true)}
          aria-expanded={sectionsMenuOpen}
          aria-controls="sections-drawer"
        >
          <LayoutGrid size={14} aria-hidden="true" />
          <span>Secciones</span>
        </button>
      )}

      {sectionsMenuOpen && (
        <div
          className="sections-backdrop"
          onClick={() => setSectionsMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        id="sections-drawer"
        className={`sections-drawer ${sectionsMenuOpen ? 'is-open' : ''}`}
        aria-label="Menú de secciones y apariencia"
        aria-hidden={!sectionsMenuOpen}
      >
        <div className="sidebar-header">
          <div className="sidebar-header-stats">
            <span className="sidebar-header-title">Secciones</span>
            <span className="sidebar-header-sub">
              Navegación y apariencia · RadioMapa España
            </span>
          </div>

          <button
            type="button"
            id="sections-drawer-close-btn"
            className="icon-btn"
            aria-label="Cerrar menú de secciones"
            title="Cerrar menú de secciones"
            onClick={() => setSectionsMenuOpen(false)}
            style={{ padding: '0 8px' }}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="sidebar-scroll">
          <section className="panel-section">
            <div className="field-label">
              <span>Navegación principal</span>
            </div>

            <nav className="sections-nav-list" aria-label="Navegación principal">
              <Link
                to="/"
                activeOptions={{ exact: true }}
                id="nav-tab-mapa"
                className="sections-nav-item"
                onClick={() => setSectionsMenuOpen(false)}
              >
                <span className="sections-nav-icon" aria-hidden="true">
                  <MapIcon size={17} />
                </span>
                <span className="sections-nav-copy">
                  <span className="sections-nav-title">Mapa Interactivo</span>
                  <span className="sections-nav-sub">
                    Cartografía de estaciones, bandas y filtros
                  </span>
                </span>
              </Link>

              <Link
                to="/novedades"
                id="nav-tab-novedades"
                className="sections-nav-item"
                onClick={() => setSectionsMenuOpen(false)}
              >
                <span className="sections-nav-icon" aria-hidden="true">
                  <Sparkles size={17} />
                </span>
                <span className="sections-nav-copy">
                  <span className="sections-nav-title-row">
                    <span className="sections-nav-title">Novedades</span>
                    {novedadesCount > 0 && (
                      <span
                        className="nav-tab-badge mono"
                        title={`${novedadesCount.toLocaleString('es-ES')} novedades respecto al escaneo anterior`}
                      >
                        {novedadesCount.toLocaleString('es-ES')}
                      </span>
                    )}
                  </span>
                  <span className="sections-nav-sub">
                    Altas diarias de antenas y nuevas frecuencias
                  </span>
                </span>
              </Link>

              <Link
                to="/estadisticas"
                id="nav-tab-estadisticas"
                className="sections-nav-item"
                onClick={() => setSectionsMenuOpen(false)}
              >
                <span className="sections-nav-icon" aria-hidden="true">
                  <BarChart3 size={17} />
                </span>
                <span className="sections-nav-copy">
                  <span className="sections-nav-title">Datos y Estadísticas</span>
                  <span className="sections-nav-sub">
                    Métricas por operadora, banda y provincia
                  </span>
                </span>
              </Link>
            </nav>
          </section>

          <section className="panel-section">
            <div className="field-label">
              <span>Apariencia</span>
            </div>

            <button
              type="button"
              id="theme-toggle-btn"
              role="switch"
              aria-checked={theme === 'dark'}
              aria-label={
                theme === 'dark'
                  ? 'Cambiar a modo claro'
                  : 'Cambiar a modo oscuro'
              }
              className="sections-theme-toggle"
              onClick={toggleTheme}
            >
              <span className="sections-theme-left">
                <span className="sections-nav-icon" aria-hidden="true">
                  {theme === 'dark' ? <Moon size={17} /> : <Sun size={17} />}
                </span>
                <span className="sections-nav-copy">
                  <span className="sections-nav-title">Modo oscuro</span>
                  <span className="sections-nav-sub">
                    {theme === 'dark'
                      ? 'Activado · Pulsa para cambiar a modo claro'
                      : 'Desactivado · Modo claro activo'}
                  </span>
                </span>
              </span>
              <span
                className={`sections-switch-pill ${theme === 'dark' ? 'is-on' : ''}`}
                aria-hidden="true"
              >
                <span className="sections-switch-thumb" />
              </span>
            </button>
          </section>

          <section className="panel-section">
            <div className="field-label">
              <span>Estado del censo oficial</span>
            </div>

            <div
              className="dataset-live-badge sections-dataset-badge"
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
                <div className="sections-dataset-copy">
                  <span className="dataset-live-count">
                    {totalFormatted} est. registradas
                  </span>
                  {relativeDate && (
                    <span className="dataset-live-date">
                      {relativeDate}
                      {exactDate ? ` · ${exactDate}` : ''}
                    </span>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>
      </aside>
    </>
  );
}
