import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// This renderer/asset boundary imports no Core or generated workspace package.
export default defineConfig({ root: fileURLToPath(new URL('../../../../../', import.meta.url)),
  esbuild: { jsx: 'automatic' },
  server: { fs: { allow: [process.cwd(), ...(process.env.AGENTMUX_FILE_MEDIA_DEPENDENCY_ROOT ? [process.env.AGENTMUX_FILE_MEDIA_DEPENDENCY_ROOT] : [])] } },
  test: { include: ['apps/desktop/test/pdf-content.test.tsx', 'apps/desktop/test/pdfjs-viewer-assets.test.ts', 'apps/desktop/test/pdf-engine.test.ts'] } })
