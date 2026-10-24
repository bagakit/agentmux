import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// Exercise the same shared source modules as the Renderer, not a prior dist build.
export default defineConfig({
  resolve: { conditions: ['browser', 'import', 'default'] },
  ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  test: {
    include: [
      'apps/desktop/test/note-block-authors.test.tsx', 'apps/desktop/test/note-participants.test.tsx',
      'apps/desktop/test/note-file-attribution-notice.test.tsx', 'apps/desktop/test/note-recovery-drawer.test.tsx',
      'apps/desktop/test/note-file-surface.test.tsx', 'apps/desktop/test/note-shared-reader.test.tsx',
      'apps/desktop/test/note-footer-shared.test.tsx',
      'apps/desktop/test/note-canvas.test.tsx', 'apps/desktop/test/note-canvas-content.test.tsx'
    ],
    setupFiles: [resolve(import.meta.dirname, '../../../vitest.setup.ts')],
    server: { deps: { inline: ['@agentmux/client-ui'] } },
    passWithNoTests: false
  }
})
