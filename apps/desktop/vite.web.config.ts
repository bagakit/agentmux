import { noteParsingAliases } from '../../packages/client-ui/scripts/note-parsing-aliases'
import { radixOverlayAliases } from '../../packages/client-ui/scripts/radix-overlay-aliases'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { pdfjsViewerAssets } from '@agentmux/editor-extensions/build/pdfjs-viewer-assets'

export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  resolve: { alias: { ...radixOverlayAliases, ...noteParsingAliases }, dedupe: ['react', 'react-dom'] },
  plugins: [react(), pdfjsViewerAssets()],
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  server: { port: 4173 }
})
