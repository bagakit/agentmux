import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ root, plugins: [{ name: 'original-maintenance-core-leaves', resolveId(source) {
  if (source === '@agentmux/core') return '\0original-maintenance-core-leaves'
  if (source === '@agentmux/identity') return resolve(root, 'packages/identity/src/index.ts')
}, load(id) {
  if (id === '\0original-maintenance-core-leaves') return `export { AgentMuxError } from ${JSON.stringify(resolve(root, 'packages/core/src/errors.ts'))}; export { mintObjectId } from ${JSON.stringify(resolve(root, 'packages/core/src/object-id.ts'))};`
} }], test: { include: ['apps/desktop/test/credential-launcher.test.ts'], environment: 'node', fileParallelism: false, passWithNoTests: false, testTimeout: 30000 } })
