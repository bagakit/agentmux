import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: { conditions: ['browser', 'import', 'default'] },
  ssr: { noExternal: ['@agentmux/client-ui'] },
  test: {
    include: ['apps/desktop/test/{vega-preview-lifecycle,excalidraw-preview}.test.tsx'],
    passWithNoTests: false
  }
})
