import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'

const owner = 'apps/desktop/src/renderer/src/lib/focus-context.ts'
const files = [owner, ...['GlobalFocusSurface', 'FocusContextCards', 'FocusContextCardBody'].map(name => `apps/desktop/src/renderer/src/components/${name}.tsx`)]
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({
  ...source, cacheDir: resolve(source.root!, '.tmp/focus-service-recap-vitest-cache'),
  plugins: [{ name: 'actual-service-recap-consumer', enforce: 'pre', transform(original, id) {
    const path = relative(source.root!, id.split('?')[0]!)
    if (!files.includes(path)) return
    let code = original
    const mutant = process.env.AGENTMUX_SERVICE_RECAP_MUTANT
    if (mutant && path === owner) {
      assert(['eager', 'blind-version'].includes(mutant), 'Known service recap inverse')
      const [from, to] = mutant === 'eager'
        ? ['conversation = deferred ? undefined : focusConversationFacts(timeline, old)', 'conversation = focusConversationFacts(timeline, old)']
        : ['revision: timeline?.revision, sourceHostId: timeline?.sourceHostId,\n    agentSessionId: timeline?.agentSessionId, streamEpoch: timeline?.stream?.epoch',
          'revision: undefined, sourceHostId: undefined,\n    agentSessionId: undefined, streamEpoch: undefined']
      assert.equal(code.split(from!).length - 1, 1, 'Unique actual service recap inverse')
      code = code.replace(from!, to!); process.stderr.write(`MUTATION_APPLIED=${mutant}\n`)
    }
    if (process.env.AGENTMUX_SERVICE_RECAP_LOADED) appendFileSync(process.env.AGENTMUX_SERVICE_RECAP_LOADED,
      JSON.stringify({ path, originalSHA256: hash(original), loadedSHA256: hash(code), mutant: code !== original ? mutant : null }) + '\n')
    if (code !== original) return { code, map: null }
  } }],
  test: { ...source.test, include: process.env.AGENTMUX_SERVICE_RECAP_ADJACENT
    ? ['apps/desktop/test/focus-conversation-facts.test.tsx', 'apps/desktop/test/focus-context-cost.test.ts']
    : ['apps/desktop/test/focus-service-recap.test.tsx'], setupFiles: [], globalSetup: [], maxWorkers: 1, fileParallelism: false, passWithNoTests: false }
})
