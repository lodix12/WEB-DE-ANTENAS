import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  // Rutas relativas para que el bundle funcione igual en raíz (`/`) que bajo subruta (`/WEB-DE-ANTENAS/`)
  base: './',
  plugins: [react()],
  server: {
    host: true,
    port: 4173,
    allowedHosts: true,
  },
  preview: {
    host: true,
    port: 4173,
    allowedHosts: true,
  },
  // MapLibre GL JS v6.18.0 instancia su Web Worker como módulo ES (`{ type: 'module' }`)
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Mantener el chunk principal de MapLibre separado sin absorber jamás el entry del worker
          if (id.includes('maplibre-gl') && !id.includes('worker')) {
            return 'maplibre'
          }
          if (id.includes('@tanstack/')) {
            return 'tanstack'
          }
        },
      },
    },
  },
})

