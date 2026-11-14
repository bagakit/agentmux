import { noteParsingAliases } from '../../packages/client-ui/scripts/note-parsing-aliases'
import { radixOverlayAliases } from './scripts/radix-overlay-aliases'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { pdfjsViewerAssets } from '@agentmux/editor-extensions/build/pdfjs-viewer-assets'
import { editorExtensionNotices } from '@agentmux/editor-extensions/build/extension-notices'
import { fileDiagramAssets } from '@agentmux/editor-extensions/build/file-diagram-assets'

export default defineConfig({
  main: {
    // The shared Note schema runs in Main too. Keep its existing dependencies
    // and required peers in the bundle rather than relying on workspace modules.
    plugins: [externalizeDepsPlugin({ exclude: [
      '@agentmux/browser', '@agentmux/editor-extensions', 'tar-stream', '@agentmux/host', '@agentmux/connectors', '@agentmux/client-ui', '@agentmux/native-desktop', '@tiptap/core', '@tiptap/extension-unique-id', '@tiptap/starter-kit',
      'unified', 'remark-parse', 'remark-gfm', 'remark-directive', 'remark-stringify'
    ], include: ['@larksuiteoapi/node-sdk', '@discordjs/ws', '@discordjs/rest', 'discord-api-types', '@resvg/resvg-js'] })],
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
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts'), 'book-reader': resolve(import.meta.dirname, 'src/preload/book-reader.ts'), capsule: resolve(import.meta.dirname, 'src/preload/capsule.ts'), 'screenshot-editor': resolve(import.meta.dirname, 'src/preload/screenshot-editor.ts'), 'screenshot-pin': resolve(import.meta.dirname, 'src/preload/screenshot-pin.ts'), 'screenshot-source': resolve(import.meta.dirname, 'src/preload/screenshot-source.ts'), 'screenshot-countdown': resolve(import.meta.dirname, 'src/preload/screenshot-countdown.ts'), 'capture-surface': resolve(import.meta.dirname, 'src/preload/capture-surface.ts'), 'capture-sequence': resolve(import.meta.dirname, 'src/preload/capture-sequence.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    resolve: { alias: { ...radixOverlayAliases, ...noteParsingAliases }, dedupe: ['react', 'react-dom'] },
    worker: { format: 'es' },
    plugins: [react(), pdfjsViewerAssets(), fileDiagramAssets(), editorExtensionNotices()],
    build: { rollupOptions: { input: { index: resolve(import.meta.dirname, 'src/renderer/index.html'), 'workbench-window': resolve(import.meta.dirname, 'src/renderer/workbench-window.html'), 'file-diagram': resolve(import.meta.dirname, 'src/renderer/file-diagram/index.html'), 'book-reader': resolve(import.meta.dirname, 'src/renderer/book-reader/index.html'), 'screenshot-editor': resolve(import.meta.dirname, 'src/renderer/screenshot-editor/index.html'), 'screenshot-pin': resolve(import.meta.dirname, 'src/renderer/screenshot-pin/index.html') } } },
    define: { __AGENTMUX_WEB_PREVIEW__: 'false' }
  }
})
