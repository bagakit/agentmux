import { defineConfig } from 'vitest/config'

// These readers consume pure parsers/client-ui source, not Core's compiled runtime.
export default defineConfig({
  resolve: { conditions: ['browser', 'import', 'default'] },
  ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
  test: {
    include: ['apps/desktop/test/{data-structured-preview,data-notebook-preview,structured-data-preview-component,notebook-file-preview-component}.test.{ts,tsx}'],
    server: { deps: { inline: ['@agentmux/client-ui'] } }
  }
})
