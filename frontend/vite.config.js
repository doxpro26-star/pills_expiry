import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 3000,
    // Proxy backend for local dev where PC is on ESP32-CAM_AP and backend can reach 192.168.4.1
    proxy: {
      '/api': { target: 'http://localhost:5000', changeOrigin: true },
      '/health': { target: 'http://localhost:5000', changeOrigin: true },
      '/collect': { target: 'http://localhost:5000', changeOrigin: true },
      '/collect_upload': { target: 'http://localhost:5000', changeOrigin: true },
      '/identify': { target: 'http://localhost:5000', changeOrigin: true },
      '/identify_upload': { target: 'http://localhost:5000', changeOrigin: true },
      '/proxy': { target: 'http://localhost:5000', changeOrigin: true },
      '/esp32': { target: 'http://localhost:5000', changeOrigin: true },
      '/ping': { target: 'http://localhost:5000', changeOrigin: true },
    },
  },
})