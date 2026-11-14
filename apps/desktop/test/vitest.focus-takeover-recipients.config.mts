import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'

const renderer = 'apps/desktop/src/renderer/src/'
const projection = `${renderer}lib/focus-takeover-recipients.ts`
const feedback = `${renderer}components/FocusTakeoverRecipients.tsx`
const binding = `${renderer}lib/desktop-agent-presentation.ts`
const locationPicker = `${renderer}components/QuickSwitcher.tsx`
const consumerModules = new Set([projection, feedback, binding, `${renderer}components/FocusContextRow.tsx`,
  `${renderer}components/GlobalFocusSurface.tsx`, `${renderer}components/AgentOperationFeedback.tsx`, locationPicker, `${renderer}store.ts`])
const mutations: Record<string, { path: string; edits: [original: string, mutated: string][] }> = {
  'sid-without-runtime': { path: projection, edits: [
    ['identity(original.runtimeId, original.agentSessionId)', 'original.agentSessionId'],
    ['identity(source.runtimeId, source.agentSessionId)', 'source.agentSessionId'],
  ] },
  'creation-is-handoff': { path: projection, edits: [["creation.initialPrompt === 'confirmed'", 'true']] },
  'wrong-location': { path: feedback, edits: [[
    'state.selectSession(recipient.sessionId, undefined, { reference: choices[0]! })',
    "state.selectSession(recipient.sessionId, undefined, { reference: { ...choices[0]!, regionId: 'wrong-region' } })",
  ]] },
  'ignore-execution-cwd': { path: binding, edits: [[' && execution.cwd === session.workspacePath', '']] },
  'picker-offers-stale-location': { path: locationPicker, edits: [[
    'return execution?.hostId === subject.hostId && execution.runtimeId === subject.runtimeId',
    'return true',
  ]] },
}
const mode = process.env.AGENTMUX_TAKEOVER_RECIPIENTS_MUTATION
const mutation = mode ? mutations[mode] : undefined
if (mode) assert.ok(mutation, 'Known Focus recipient mutation')
const hash = (input: string) => createHash('sha256').update(input).digest('hex')

export default defineConfig({
  ...base,
  cacheDir: resolve(base.root!, '.tmp/focus-takeover-recipients-cache', mode ?? 'baseline'),
  plugins: [...base.plugins ?? [], {
    name: 'loaded-focus-takeover-recipient-mutation', enforce: 'pre',
    transform(source, id) {
      const path = relative(base.root!, id.split('?')[0]!)
      if (!consumerModules.has(path)) return
      let loaded = source
      if (mutation?.path === path) for (const [original, mutated] of mutation.edits) {
        assert.equal(loaded.split(original).length, 2, 'Unique loaded source mutation anchor')
        loaded = loaded.replace(original, mutated)
      }
      const receipt = process.env.AGENTMUX_TAKEOVER_RECIPIENTS_LOADED
      if (receipt) appendFileSync(receipt, JSON.stringify({ path, mutation: loaded === source ? null : mode,
        originalSHA256: hash(source), loadedSHA256: hash(loaded) }) + '\n')
      if (loaded !== source) return { code: loaded, map: null }
    },
  }],
  test: { ...base.test, include: ['apps/desktop/test/focus-takeover-recipients.test.tsx'], passWithNoTests: false },
})
