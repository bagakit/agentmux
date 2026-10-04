import { defineConfig } from 'vitest/config'
export default defineConfig({
  resolve: { conditions: ['browser', 'import', 'default'] },
  ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
  test: { include: ['apps/desktop/test/{file-delimited-dialects,workspace-vega-loader,workspace-file-format,monaco-registry,language-detect}.test.{ts,tsx}'], server: { deps: { inline: ['@agentmux/client-ui'] } } }
})
