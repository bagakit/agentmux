import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import base from '../../../test/vitest.composer-history-cost.config.mts'

const product = 'apps/desktop/src/renderer/src/lib/session-captured-inputs.ts'
const tracked = new Set([product, 'apps/desktop/src/renderer/src/lib/use-composer-input-history.tsx',
  'apps/desktop/src/renderer/src/lib/session-mailbox-messages.ts', 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx',
  'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', 'apps/desktop/test/composer-history-merge-cost.test.tsx',
  'apps/desktop/test/composer-history-live-seed.test.tsx', 'apps/desktop/test/session-mailbox-author-boundary.test.tsx',
  'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/use-observed-app-store.ts',
  'packages/core/src/session-user-messages.ts', 'packages/core/src/session-timeline-reducer.ts', 'packages/core/src/session-timeline.ts'])
const mutations = {
  eager: ['if (previous && previous.sessionId === sessionId', 'if (false && previous && previous.sessionId === sessionId'],
  version: ['versions[index] === previous!.versions[index]', 'true /* mutation: ignore the original record revision */']
} as const
export default { ...base, plugins: [...(base.plugins ?? []), {
  name: 'original-captured-input-consumers', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const path = relative(base.root!, id.split('?')[0]!)
    if (!tracked.has(path)) return
    let code = source
    const name = process.env.AGENTMUX_CAPTURED_INPUT_MUTATION
    if (path === product && name) {
      assert.ok(Object.hasOwn(mutations, name), 'Unknown captured input mutation')
      const [from, to] = mutations[name as keyof typeof mutations]
      assert.equal(code.split(from).length - 1, 1, 'Mutation requires one actual source anchor')
      code = code.replace(from, to)
    }
    if (process.env.AGENTMUX_CAPTURED_INPUT_LOADED) appendFileSync(process.env.AGENTMUX_CAPTURED_INPUT_LOADED,
      JSON.stringify({ path, mutation: path === product ? name ?? null : null,
        sourceSHA256: createHash('sha256').update(source).digest('hex'), effectiveSHA256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return source === code ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: process.env.AGENTMUX_CAPTURED_INPUT_ADJACENT
  ? ['apps/desktop/test/composer-history-live-seed.test.tsx']
  : ['apps/desktop/test/composer-history-merge-cost.test.tsx', 'apps/desktop/test/session-mailbox-author-boundary.test.tsx'],
  maxWorkers: 1, passWithNoTests: false } }
