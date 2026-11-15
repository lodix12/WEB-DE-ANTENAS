import { Link, Outlet } from '@tanstack/react-router';
import { AppHeader } from './AppHeader';

export function RootLayout() {
  return (
    <>
      <AppHeader />
      <Outlet />
    </>
  );
}

export function NotFoundView() {
  return (
    <main className="page-container">
      <div className="state-center-box">
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>
          Ruta no encontrada
        </h1>
        <p>La sección solicitada no existe en RadioMapa España.</p>
        <Link to="/" className="btn btn-primary">
          Volver al Mapa Interactivo
        </Link>
      </div>
    </main>
  );
}
