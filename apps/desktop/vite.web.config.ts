import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  plugins: [react()],
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  server: { port: 4173 }
})
