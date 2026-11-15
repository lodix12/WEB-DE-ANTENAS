import { useEffect } from 'react';
import { Download, ExternalLink } from 'lucide-react';
import { useAntenasData } from '../hooks/useAntenasData';
import { formatDateTimeEs } from '../utils/export';

interface SpectrumBandRow {
  freqLabel: string;
  bandCode: string;
  generation: string;
  rangeMhz: string;
  propagation: string;
  useCase: string;
}

const SPAIN_MOBILE_BANDS: SpectrumBandRow[] = [
  {
    freqLabel: '700 MHz',
    bandCode: 'n28 (B28)',
    generation: '5G NR FDD',
    rangeMhz: '703–733 / 758–788 MHz',
    propagation: 'Alcance máximo (> 10 km) y excelente penetración indoor',
    useCase:
      'Cobertura 5G rural, carreteras nacionales e interiores profundos (2.º Dividendo Digital).',
  },
  {
    freqLabel: '800 MHz',
    bandCode: 'B20',
    generation: '4G LTE',
    rangeMhz: '832–862 / 791–821 MHz',
    propagation: 'Largo alcance rural y alta penetración en muros',
    useCase:
      'Capa base de cobertura 4G en municipios rurales y viviendas aisladas (1.er Dividendo Digital).',
  },
  {
    freqLabel: '900 MHz',
    bandCode: 'B8 / n8',
    generation: '2G / 3G / 4G / 5G',
    rangeMhz: '880–915 / 925–960 MHz',
    propagation: 'Largo alcance continuo en zonas montañosas',
    useCase:
      'Voz GSM/UMTS de respaldo universal, IoT y cobertura 4G/5G mediante compartición dinámica (DSS).',
  },
  {
    freqLabel: '1800 MHz',
    bandCode: 'B3 / n3',
    generation: '4G LTE+ / 5G DSS',
    rangeMhz: '1710–1785 / 1805–1880 MHz',
    propagation: 'Alcance medio (2–5 km) y gran ancho de banda',
    useCase:
      'Banda troncal de capacidad en núcleos urbanos y agregación de portadoras (Carrier Aggregation).',
  },
  {
    freqLabel: '2100 MHz',
    bandCode: 'B1 / n1',
    generation: '4G LTE+ / 5G DSS',
    rangeMhz: '1920–1980 / 2110–2170 MHz',
    propagation: 'Alcance medio-corto enfocado en capacidad',
    useCase:
      'Refuerzo de caudal de datos en zonas urbanas y suburbanas; antiguo espectro 3G migrado a 4G/5G.',
  },
  {
    freqLabel: '2600 MHz',
    bandCode: 'B7 / B38',
    generation: '4G LTE-A',
    rangeMhz: '2500–2570 / 2620–2690 MHz',
    propagation: 'Corto alcance (0,5–2 km), requiere línea de vista cercana',
    useCase:
      'Alta densidad de usuarios en centros comerciales, estadios, estaciones y avenidas principales.',
  },
  {
    freqLabel: '3500 MHz',
    bandCode: 'n78 (Banda C)',
    generation: '5G+ TDD (SA/NSA)',
    rangeMhz: '3400–3800 MHz',
    propagation: 'Corto-medio alcance con antenas Massive MIMO (Beamforming)',
    useCase:
      '5G de ultra-alta velocidad (hasta > 1 Gbps) y mínima latencia con canales contiguos de 80–100 MHz.',
  },
];

interface ExposureReferenceRow {
  band: string;
  limitUwCm2: string;
  limitWm2: string;
  typicalMeasured: string;
}

const RD_1066_LIMITS: ExposureReferenceRow[] = [
  {
    band: '700 MHz (5G n28)',
    limitUwCm2: '350 µW/cm²',
    limitWm2: '3,5 W/m²',
    typicalMeasured: '0,001 – 0,80 µW/cm²',
  },
  {
    band: '800 MHz (4G B20)',
    limitUwCm2: '400 µW/cm²',
    limitWm2: '4,0 W/m²',
    typicalMeasured: '0,001 – 1,20 µW/cm²',
  },
  {
    band: '900 MHz (B8)',
    limitUwCm2: '450 µW/cm²',
    limitWm2: '4,5 W/m²',
    typicalMeasured: '0,001 – 1,50 µW/cm²',
  },
  {
    band: '1800 MHz (B3)',
    limitUwCm2: '900 µW/cm²',
    limitWm2: '9,0 W/m²',
    typicalMeasured: '0,002 – 2,50 µW/cm²',
  },
  {
    band: '2100 / 2600 / 3500 MHz (5G+ n78)',
    limitUwCm2: '1.000 µW/cm²',
    limitWm2: '10,0 W/m²',
    typicalMeasured: '0,002 – 3,50 µW/cm²',
  },
];

export function MetodologiaView() {
  const { derived } = useAntenasData();

  useEffect(() => {
    document.title =
      'Bandas 4G/5G en España, Exposición RF y Metodología · RadioMapa España';
  }, []);

  const baseUrl = import.meta.env.BASE_URL || './';
  const rawJsonUrl = `${baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`}data/antenas.json`;

  return (
    <main className="page-container">
      <header className="page-hero">
        <span className="page-eyebrow">Guía de Ingeniería RF y Datos Abiertos</span>
        <h1 className="page-h1">
          Bandas Móviles en España, Normativa RF y Metodología
        </h1>
        <p className="page-lead">
          Referencia técnica para interpretar las frecuencias asignadas en las
          fichas oficiales del Ministerio, orientar antenas exteriores 4G/5G,
          comprender las mediciones de exposición radioeléctrica y auditar el
          proceso de actualización diaria.
        </p>
      </header>

      {/* 1. Guía de Bandas */}
      <section className="section-block" aria-labelledby="metodologia-bandas-h2">
        <div className="section-block-header">
          <div>
            <h2 id="metodologia-bandas-h2" className="section-h2">
              Espectro de Telefonía Móvil en España (700 MHz – 3500 MHz)
            </h2>
            <p className="section-desc">
              Bandas radioeléctricas operadas por Movistar, MasOrange, Vodafone y
              Grupo MásMóvil / DIGI que aparecen en la ficha técnica{' '}
              <code>detalleEstacion.do</code>.
            </p>
          </div>
        </div>

        <div className="province-table-wrap">
          <table className="clean-table">
            <thead>
              <tr>
                <th>Frecuencia</th>
                <th>Banda 3GPP</th>
                <th>Tecnología</th>
                <th>Rango Espectral</th>
                <th>Propagación y Uso Principal</th>
              </tr>
            </thead>
            <tbody>
              {SPAIN_MOBILE_BANDS.map((b) => (
                <tr key={b.freqLabel}>
                  <td>
                    <span className="band-tag">{b.freqLabel}</span>
                  </td>
                  <td className="mono" style={{ fontWeight: 600 }}>
                    {b.bandCode}
                  </td>
                  <td>
                    <span className="tech-pill">{b.generation}</span>
                  </td>
                  <td
                    className="mono"
                    style={{ fontSize: 12, color: 'var(--text-muted)' }}
                  >
                    {b.rangeMhz}
                  </td>
                  <td style={{ maxWidth: 460 }}>
                    <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                      {b.propagation}
                    </div>
                    <div
                      style={{
                        fontSize: 12.5,
                        color: 'var(--text-secondary)',
                        marginTop: 2,
                      }}
                    >
                      {b.useCase}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 2. Cómo interpretar detalleEstacion.do + Orientación de routers 4G/5G */}
      <div className="two-col-editorial">
        <section className="section-block" aria-labelledby="ficha-minetur-h2">
          <div className="section-block-header">
            <div>
              <h2 id="ficha-minetur-h2" className="section-h2">
                Cómo Interpretar la Ficha Oficial de MINETUR
              </h2>
              <p className="section-desc">
                Qué información ofrece el enlace directo de cada estación.
              </p>
            </div>
          </div>
          <div className="section-block-body">
            <p style={{ color: 'var(--text-secondary)' }}>
              Al pulsar{' '}
              <strong>
                «Consultar niveles de exposición y bandas (MHz) en MINETUR»
              </strong>{' '}
              en cualquier antena del mapa o del explorador, se abre en tiempo
              real el expediente público{' '}
              <code>detalleEstacion.do</code> del Ministerio para la
              Transformación Digital:
            </p>
            <ul className="prose-list">
              <li>
                <strong>Identificación administrativa:</strong> Muestra el{' '}
                <code>Código de emplazamiento</code> del operador y su dirección
                exacta certificada.
              </li>
              <li>
                <strong>Características técnicas (Bandas en MHz):</strong>{' '}
                Enumera cada sistema radiante activo indicando su rango exacto de
                frecuencia (por ejemplo, <code>758.00 - 768.00 MHz</code> indica
                5G en banda <code>n28</code> de 700 MHz;{' '}
                <code>3600 - 3700 MHz</code> confirma 5G+ de alta capacidad{' '}
                <code>n78</code>).
              </li>
              <li>
                <strong>Niveles medidos en entorno próximo:</strong> Tabla de
                puntos de medición anual en calle y viviendas colindantes con la
                distancia al mástil, el acimut y el valor máximo registrado en{' '}
                <code>µW/cm²</code>.
              </li>
            </ul>
          </div>
        </section>

        <section className="section-block" aria-labelledby="orientacion-rural-h2">
          <div className="section-block-header">
            <div>
              <h2 id="orientacion-rural-h2" className="section-h2">
                Orientación de Antenas Exteriores 4G/5G Rurales
              </h2>
              <p className="section-desc">
                Uso práctico del Radar de Cercanía y Acimut de RadioMapa.
              </p>
            </div>
          </div>
          <div className="section-block-body">
            <p style={{ color: 'var(--text-secondary)' }}>
              En viviendas rurales, casas de campo o naves industriales donde la
              cobertura interior es débil, instalar un router 4G/5G con antena
              exterior directiva (panel MIMO o Yagi log-periódica) multiplica la
              velocidad y estabilidad si se apunta con precisión:
            </p>
            <ul className="prose-list">
              <li>
                <strong>1. Fija tu ubicación exacta:</strong> Usa el botón{' '}
                <em>Medir en mapa</em> sobre el tejado exacto de tu vivienda o
                introduce tus coordenadas WGS84.
              </li>
              <li>
                <strong>2. Filtra tu operador de red anfitrión:</strong> Si usas
                un OMV (por ejemplo DIGI sobre red Movistar, o Lowi sobre
                Vodafone), activa el operador de red física correspondiente.
              </li>
              <li>
                <strong>3. Verifica las bandas activas:</strong> Una estación a{' '}
                <code>3,5 km</code> con <code>1800/2100/3500 MHz</code> y línea
                de vista despejada suele ofrecer mucha mayor velocidad que una
                estación a <code>1,5 km</code> que solo emita en{' '}
                <code>800 MHz</code> o esté oculta tras una colina.
              </li>
              <li>
                <strong>4. Apunta con brújula al acimut indicado:</strong> El
                radar calcula el rumbo geodésico exacto (ej.{' '}
                <code>NNE 24°</code>) desde tu tejado hacia la torre.
              </li>
            </ul>
          </div>
        </section>
      </div>

      {/* 3. Exposición Radioeléctrica y Real Decreto 1066/2001 */}
      <section className="section-block" aria-labelledby="normativa-rd-h2">
        <div className="section-block-header">
          <div>
            <h2 id="normativa-rd-h2" className="section-h2">
              Niveles de Exposición Radioeléctrica (µW/cm²) y Real Decreto
              1066/2001
            </h2>
            <p className="section-desc">
              Comparativa entre los valores medidos habitualmente a pie de calle
              y los límites legales máximos de protección sanitaria vigentes en
              España.
            </p>
          </div>
        </div>

        <div className="section-block-body" style={{ paddingBottom: 12 }}>
          <div className="callout-note">
            La densidad de potencia equivalente de onda plana se expresa en{' '}
            <strong>microvatios por centímetro cuadrado (µW/cm²)</strong>. El{' '}
            <strong>Real Decreto 1066/2001</strong> (alineado con la
            Recomendación 1999/519/CE y las directrices científicas de ICNIRP)
            fija límites máximos que dependen de la frecuencia (`f / 200` en
            W/m² para 400–2000 MHz y `10 W/m²` por encima de 2000 MHz). En la
            práctica, las mediciones certificadas en la vía pública suelen
            situarse entre <strong>100 y 10.000 veces por debajo</strong> del
            límite reglamentario.
          </div>
        </div>

        <div className="province-table-wrap">
          <table className="clean-table">
            <thead>
              <tr>
                <th>Banda de Frecuencia</th>
                <th>Límite Máximo Legal (RD 1066/2001)</th>
                <th>Equivalencia SI</th>
                <th>Rango Habitual Medido en Calle</th>
              </tr>
            </thead>
            <tbody>
              {RD_1066_LIMITS.map((row) => (
                <tr key={row.band}>
                  <td style={{ fontWeight: 600 }}>{row.band}</td>
                  <td className="mono" style={{ fontWeight: 700 }}>
                    {row.limitUwCm2}
                  </td>
                  <td className="mono" style={{ color: 'var(--text-secondary)' }}>
                    {row.limitWm2}
                  </td>
                  <td className="mono" style={{ color: 'var(--status-ok)' }}>
                    {row.typicalMeasured}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 4. Recolección Automática cada 24h y Esquema JSON Propio */}
      <section className="section-block" aria-labelledby="pipeline-24h-h2">
        <div className="section-block-header">
          <div>
            <h2 id="pipeline-24h-h2" className="section-h2">
              Recolección Automática cada 24 Horas y Esquema JSON Propio
            </h2>
            <p className="section-desc">
              Cómo el recolector diario genera nuestro archivo estático con
              esquema JSON propio (<code>data/antenas.json</code>), importado
              directamente por la web sin cargar GeoJSON desde el navegador.
            </p>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <a
              href={rawJsonUrl}
              download="antenas-espana-radiomapa.json"
              id="download-raw-json-btn"
              className="btn btn-primary btn-sm"
            >
              <Download size={13} aria-hidden="true" />
              <span>Descargar JSON propio (data/antenas.json)</span>
            </a>
            <a
              href="https://geoportal.minetur.gob.es/VCTEL/vcne.do"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary btn-sm"
            >
              <span>Visor Oficial Infoantenas</span>
              <ExternalLink size={12} aria-hidden="true" />
            </a>
          </div>
        </div>

        <div className="section-block-body">
          <ul className="prose-list" style={{ marginTop: 0 }}>
            <li>
              <strong>Barrido diario fuera de línea (GitHub Actions · 24 h):</strong>{' '}
              Cada madrugada (`04:00 UTC`), un flujo automatizado ejecuta{' '}
              <code>scripts/fetch_antenas.py</code> recorriendo mallas de
              coordenadas (`bbox`) sobre la Península Ibérica, Islas Baleares,
              Islas Canarias, Ceuta y Melilla en el Geoportal oficial.
            </li>
            <li>
              <strong>Subdivisión adaptativa Quadtree:</strong> El Geoportal
              oficial limita cada celda espacial a un máximo de{' '}
              <code>1.000</code> estaciones. Cuando una celda en áreas
              metropolitanas densas (Madrid, Barcelona, Valencia, Málaga,
              Sevilla) alcanza ese umbral, el recolector la subdivide
              recursivamente en 4 subcuadrantes con solape de seguridad de{' '}
              <code>0,0001°</code> para garantizar pérdida cero de estaciones.
            </li>
            <li>
              <strong>
                Transformación e importación en esquema JSON propio (
                <code>public/data/antenas.json</code>):
              </strong>{' '}
              El recolector aplica una pausa mínima de <code>1,0 s</code> entre
              peticiones, decodifica <code>ISO-8859-1</code> →{' '}
              <code>UTF-8</code>, elimina duplicados por clave oficial, normaliza
              operadores y provincias INE, y consolida todas las estaciones en un{' '}
              <strong>esquema JSON propio compacto</strong> (
              <code>AntenasDataset</code>: metadatos, estadísticas agregadas y
              registros ligeros{' '}
              <code>{'{ id, gid, op, opRaw, lat, lon, dir, mun, prov }'}</code>).
            </li>
            <li>
              <strong>
                Carga exclusiva de nuestro JSON propio en el navegador:
              </strong>{' '}
              El frontend estático importa únicamente{' '}
              <code>data/antenas.json</code> (validando su esquema propio) y{' '}
              <strong>
                jamás realiza peticiones al endpoint GeoJSON de MINETUR desde el
                navegador del usuario
              </strong>
              , garantizando respuesta instantánea, independencia frente a
              caídas externas y exportación directa en JSON propio (
              <code>.json</code>) y CSV (<code>.csv</code>).
            </li>
            <li>
              <strong>Transparencia y verificación:</strong>{' '}
              {derived
                ? `El JSON propio actualmente importado contiene ${derived.dataset.total.toLocaleString('es-ES')} estaciones únicas y fue generado el ${formatDateTimeEs(derived.dataset.updatedAt)}.`
                : 'Puedes descargar el archivo JSON propio íntegro con el botón superior para tus propias aplicaciones o análisis de telecomunicaciones.'}
            </li>
          </ul>
        </div>
      </section>
    </main>
  );
}
