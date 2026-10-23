import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ plugins: [{ name: 'executed-shared-host-contract', enforce: 'pre', transform(source, id) {
  const path = id.split('?')[0]!
  if (!process.env.HOST_CONFIG_TRACE || !['apps/desktop/src/main/config-store.ts', 'apps/desktop/src/shared/contracts.ts',
    'apps/host/src/host-configuration.ts', 'packages/client-ui/src/lib/error-presentation.ts'].some(file => resolve(root, file) === path)) return
  const hash = createHash('sha256').update(source).digest('hex')
  const receipt = { path: path.slice(root.length + 1), pid: process.pid, originalSHA: hash, servedSHA: hash }
  return { code: source + '\nimport { appendFileSync as __hostConfigLoaded } from "node:fs"; __hostConfigLoaded(' + JSON.stringify(process.env.HOST_CONFIG_TRACE) + ', ' + JSON.stringify(JSON.stringify(receipt) + '\n') + ');\n', map: null }
} }], resolve: { alias: [
  { find: '@agentmux/host/host-configuration', replacement: resolve(root, 'apps/host/src/host-configuration.ts') },
  { find: '@agentmux/client-ui/error-presentation', replacement: resolve(root, 'packages/client-ui/src/lib/error-presentation.ts') }
] }, test: { include: ['apps/host/test/host-configuration-consumer.test.ts', 'apps/desktop/test/host-configuration-consumer.test.ts'],
  environment: 'node', fileParallelism: false, passWithNoTests: false, testTimeout: 45_000, hookTimeout: 15_000 } })
