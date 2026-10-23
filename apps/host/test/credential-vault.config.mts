import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { credentialSource } from './credential-source.mjs'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({
  plugins: [{ name: 'credential-owning-source', enforce: 'pre', load(id) { return credentialSource(root, id)?.contents ?? null } }],
  test: { include: ['apps/host/test/credential-vault.test.ts', 'apps/host/test/credential-process-consumer.test.ts', 'apps/desktop/test/connector-secrets-async.test.ts'], environment: 'node', fileParallelism: false },
  resolve: { alias: { '@agentmux/core': resolve(import.meta.dirname, 'credential-core-exports.ts'), '@agentmux/identity': resolve(root, 'packages/identity/src/index.ts'), '@agentmux/connectors': resolve(root, 'packages/connectors/src/index.ts') } }
})
