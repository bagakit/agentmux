import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve(import.meta.dirname, 'src/main/index.ts') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(import.meta.dirname, 'src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' }
      }
    }
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    plugins: [react()],
    define: { __AGENTMUX_WEB_PREVIEW__: 'false' }
  }
})
