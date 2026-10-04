import { defineConfig } from 'vitest/config'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import source from '../settings-overview/vitest.config.mts'
import { readFileSync } from 'node:fs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
export default defineConfig({ ...source, esbuild: { jsx: 'automatic' }, plugins: process.env.AGENTMUX_DIAGNOSTIC_BASELINE ? [{ name: 'original-feedback-control', enforce: 'pre', transform(_source, id) {
  if (id === resolve(root, 'apps/desktop/src/renderer/src/components/ComposerFeedback.tsx')) return readFileSync(resolve(root, ".local/state/message-recovery-fixture/baseline-ComposerFeedback.tsx"), 'utf8')
} }] : [], resolve: { alias: [
  { find: /^@agentmux\/client-ui\/input$/, replacement: resolve(root, 'packages/client-ui/src/input/index.ts') },
  { find: /^@agentmux\/client-ui\/note\/(.+)$/, replacement: resolve(root, 'packages/client-ui/src/note/$1.ts') },
  { find: /^@agentmux\/client-ui\/terminal\/(.+)$/, replacement: resolve(root, 'packages/client-ui/src/terminal/$1.ts') },
  { find: /^@agentmux\/client-ui\/components\/(.+)$/, replacement: resolve(root, 'packages/client-ui/src/components/$1.tsx') },
  { find: /^@agentmux\/client-ui\/platform$/, replacement: resolve(root, 'packages/client-ui/src/platform.tsx') },
  { find: /^@agentmux\/client-ui\/(.+)$/, replacement: resolve(root, 'packages/client-ui/src/lib/$1.ts') },
  { find: /^@agentmux\/client-ui$/, replacement: resolve(root, 'packages/client-ui/src/index.ts') },
  { find: /^@agentmux\/layout$/, replacement: resolve(root, 'packages/layout/src/index.ts') },
  { find: /^@agentmux\/demand\/goals$/, replacement: resolve(root, 'packages/demand/src/goals.ts') },
  ...source.resolve!.alias
] }, test: { ...source.test, environment: 'happy-dom', include: [
  'packages/client-ui/test/message-delivery-failure.test.tsx', 'apps/desktop/test/message-tool-diagnostic-report.test.tsx',
  ...(process.env.AGENTMUX_DIAGNOSTIC_REGRESSION ? ['apps/desktop/test/composer-local-feedback.test.tsx'] : [])
] } })
