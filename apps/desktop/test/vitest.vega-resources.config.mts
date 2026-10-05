import { defineConfig } from 'vitest/config'
export default defineConfig({
  resolve: { conditions: ['browser', 'import', 'default'] },
  ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  test: { include: ['apps/desktop/test/{vega-resource-consumer,workspace-vega-loader}.test.ts'], maxWorkers: 1 }
})
