import { noteParsingAliases } from '../../packages/client-ui/scripts/note-parsing-aliases'
import { radixOverlayAliases } from './scripts/radix-overlay-aliases'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { pdfjsViewerAssets } from './scripts/pdfjs-viewer-assets'
import { fileDiagramAssets } from './scripts/file-diagram-assets'

export default defineConfig({
  main: {
    // The shared Note schema runs in Main too. Keep its existing dependencies
    // and required peers in the bundle rather than relying on workspace modules.
    plugins: [externalizeDepsPlugin({ exclude: [
      '@agentmux/host', '@agentmux/connectors', '@agentmux/client-ui', '@tiptap/core', '@tiptap/extension-unique-id', '@tiptap/starter-kit',
      'unified', 'remark-parse', 'remark-gfm', 'remark-directive', 'remark-stringify'
    ], include: ['@larksuiteoapi/node-sdk', '@discordjs/ws', '@discordjs/rest', 'discord-api-types'] })],
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
      isolatedEntries: true,
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts'), capsule: resolve(import.meta.dirname, 'src/preload/capsule.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    resolve: { alias: { ...radixOverlayAliases, ...noteParsingAliases }, dedupe: ['react', 'react-dom'] },
    worker: { format: 'es' },
    plugins: [react(), pdfjsViewerAssets(), fileDiagramAssets(import.meta.dirname)],
    build: { rollupOptions: { input: { index: resolve(import.meta.dirname, 'src/renderer/index.html'), 'workbench-window': resolve(import.meta.dirname, 'src/renderer/workbench-window.html'), 'file-diagram': resolve(import.meta.dirname, 'src/renderer/file-diagram/index.html') } } },
    define: { __AGENTMUX_WEB_PREVIEW__: 'false' }
  }
})
