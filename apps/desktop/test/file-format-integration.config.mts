import { defineConfig } from 'vitest/config'
export default defineConfig({
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, esbuild: { jsx: 'automatic' },
  resolve: { conditions: ['browser', 'import', 'default'] },
  ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
  test: { testTimeout: 15000, server: { deps: { inline: ['@agentmux/client-ui'] } } }
})
