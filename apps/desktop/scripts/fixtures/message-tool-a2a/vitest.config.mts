import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { defineConfig } from 'vitest/config'
import base from '../settings-overview/vitest.config.mts'

const root = resolve(import.meta.dirname, '../../../../..')
const mutation = process.env.AGENTMUX_A2A_SOURCE_MUTATION ? JSON.parse(readFileSync(process.env.AGENTMUX_A2A_SOURCE_MUTATION, 'utf8')) : null
export default defineConfig({ ...base,
  plugins: mutation ? [{ name: 'actual-a2a-owner-source-mutation', enforce: 'pre', transform(source, id) {
    if (id.split('?')[0] !== resolve(root, mutation.file)) return
    if (source.split(mutation.before).length !== 2) throw new Error('Expected one actual owning Source mutation anchor')
    const changed = source.replace(mutation.before, mutation.after)
    writeFileSync(mutation.receipt, JSON.stringify({ file: mutation.file, loaded: true,
      before: createHash('sha256').update(source).digest('hex'), after: createHash('sha256').update(changed).digest('hex') }))
    return { code: changed, map: null }
  } }] : [],
  test: { ...base.test, include: [
    'packages/core/test/agent-message-observer.test.ts',
    'apps/desktop/test/a2a-settings-control.test.ts',
    'apps/desktop/test/a2a-settings.test.tsx',
    'apps/desktop/test/a2a-notification-flow.test.ts'
  ], testTimeout: 15000 }
})
