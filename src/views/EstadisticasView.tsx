import { useEffect } from 'react';

export function EstadisticasView() {
  useEffect(() => {
    document.title = 'Datos y Estadísticas · Redes Moviles España';
  }, []);

  return (
    <main
      id="estadisticas-blank-page"
      className="estadisticas-blank-page"
      aria-label="Datos y Estadísticas"
    />
  );
}
