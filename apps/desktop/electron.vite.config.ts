import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { pdfjsViewerAssets } from './scripts/pdfjs-viewer-assets'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@agentmux/client-ui'] })],
    resolve: {
      // Main consumes this pure module from the same source as Renderer, without a UI runtime dependency.
      alias: {
        '@agentmux/client-ui/pasted-images': resolve(import.meta.dirname, '../../packages/client-ui/src/lib/pasted-images.ts')
      }
    },
    build: { rollupOptions: { input: { index: resolve(import.meta.dirname, 'src/main/index.ts'), 'agentmux-host': resolve(import.meta.dirname, '../host/src/index.ts'), 'prepare-private-access': resolve(import.meta.dirname, '../host/src/prepare-private-access.ts') } } }
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
    plugins: [react(), pdfjsViewerAssets()],
    define: { __AGENTMUX_WEB_PREVIEW__: 'false' }
  }
})
