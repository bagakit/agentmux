import { radixOverlayAliases } from './scripts/radix-overlay-aliases'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { pdfjsViewerAssets } from './scripts/pdfjs-viewer-assets'
import { fileDiagramAssets } from './scripts/file-diagram-assets'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@agentmux/client-ui'] })],
    resolve: {
      // Main consumes this pure module from the same source as Renderer, without a UI runtime dependency.
      alias: {
        '@agentmux/client-ui/pasted-images': resolve(import.meta.dirname, '../../packages/client-ui/src/lib/pasted-images.ts')
      }
    },
    build: { rollupOptions: { input: { index: resolve(import.meta.dirname, 'src/main/index.ts'), 'agentmux-host': resolve(import.meta.dirname, '../host/src/index.ts') } } }
  },
  preload: {
    build: {
      // Sandboxed preload can load Electron, but not external workspace packages.
      externalizeDeps: false,
      rollupOptions: {
        input: resolve(import.meta.dirname, 'src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' }
      }
    }
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    resolve: { alias: radixOverlayAliases },
    worker: { format: 'es' },
    plugins: [react(), pdfjsViewerAssets(), fileDiagramAssets(import.meta.dirname)],
    build: { rollupOptions: { input: { index: resolve(import.meta.dirname, 'src/renderer/index.html'), 'file-diagram': resolve(import.meta.dirname, 'src/renderer/file-diagram/index.html') } } },
    define: { __AGENTMUX_WEB_PREVIEW__: 'false' }
  }
})
