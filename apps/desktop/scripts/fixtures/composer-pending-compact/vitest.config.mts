import { defineConfig } from 'vitest/config'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import source from '../composer-pending-delivery/vitest.config.mts'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const actual = ['ComposerPendingDelivery', 'ComposerQueuedMessageEditor', 'SessionMailbox', 'AgentSessionComposer'].map(name => `apps/desktop/src/renderer/src/components/${name}.tsx`)
export default defineConfig({ ...source, plugins: [...source.plugins ?? [], {
  name: 'pending-compact-actual-loaded', enforce: 'pre', transform(code, id) {
    const path = id.replace(root + '/', '')
    if (!process.env.AGENTMUX_PENDING_LOADED || !actual.includes(path)) return
    const record = JSON.stringify({ path, sha256: createHash('sha256').update(code).digest('hex') })
    return { code: `import { appendFileSync as __pendingLoaded } from 'node:fs'; __pendingLoaded(${JSON.stringify(process.env.AGENTMUX_PENDING_LOADED)}, ${JSON.stringify(record + '\n')});\n` + code, map: null }
  }
}], cacheDir: resolve(root, '.tmp/pending-compact/cache'),
  test: { ...source.test, include: ['apps/desktop/test/composer-pending-compact.integration.test.tsx', 'apps/desktop/test/composer-pending-delivery.integration.test.tsx', 'apps/desktop/test/composer-pending-edit.test.ts'],
    env: { ...source.test?.env, AGENTMUX_TEST_OBJECT_CLI: resolve(root, 'packages/core/bin/agentmux') },
    reporters: ['default', 'json'], outputFile: { json: resolve(root, '.tmp/pending-compact/results.json') }, passWithNoTests: false } })
