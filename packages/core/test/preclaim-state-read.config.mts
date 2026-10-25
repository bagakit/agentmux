import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_PRECLAIM_READ_MUTATION
if (mutation && !['disconnect-cancellation', 'outer-race'].includes(mutation)) throw Error('Unknown preclaim read mutation')
export default defineConfig({ cacheDir: '.cache/preclaim-state-read',
  plugins: [{ name: 'original-preclaim-read-source', enforce: 'pre', transform(original, id) {
    const path = relative(root, id)
    if (!['agent-session-registry.ts', 'prompt-submission.ts', 'client.ts', 'agent-session-store.ts', 'observation-read.ts']
      .some(name => path === 'packages/core/src/' + name)) return
    let code = original, changed = false
    const replace = (from: string, to: string) => {
      if (code.split(from).length !== 2) throw Error('Expected one original preclaim read mutation site')
      code = code.replace(from, to); changed = true
    }
    if (mutation === 'disconnect-cancellation' && path === 'packages/core/src/prompt-submission.ts') {
      replace('this.deps.registry.refresh(session.agentSessionId, session.run, undefined, renderSignal)',
        'this.deps.registry.refresh(session.agentSessionId, session.run)')
    }
    if (mutation === 'outer-race' && path === 'packages/core/src/agent-session-registry.ts') {
      // Abandoning only the caller leaves the old registry operation running.
      replace('return await this.enqueue(agentSessionId, async readSignal => {\n      const previous = this.get(agentSessionId)',
        'return await observeRead(this.enqueue(agentSessionId, async readSignal => {\n      const previous = this.get(agentSessionId)')
      replace('return { ...current, ...(future ? { futurePromptIntents: { [futureIntentId]: future } } : {}) }\n    }, signal)',
        'return { ...current, ...(future ? { futurePromptIntents: { [futureIntentId]: future } } : {}) }\n    }), signal)')
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_PRECLAIM_READ_LOADED) appendFileSync(process.env.AGENTMUX_PRECLAIM_READ_LOADED,
      JSON.stringify({ path, original: hash(original), loaded: hash(code), mutation: changed ? mutation : null }) + '\n')
    return { code, map: null }
  } }], test: { include: ['packages/core/test/initial-transport-preparation.test.ts'],
    setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, fileParallelism: false,
    passWithNoTests: false, testTimeout: 15000, hookTimeout: 15000 }
})
