import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './browser-operator-avatar.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const surface = 'apps/desktop/src/renderer/src/components/BrowserOperationSurface.tsx'
const identity = 'apps/desktop/src/renderer/src/lib/browser-operator-identity.ts'
const store = 'apps/desktop/src/renderer/src/store.ts'
const pane = 'apps/desktop/src/renderer/src/components/BrowserPane.tsx'
const mutations: Record<string, { file: string; edits: [string, string][] }> = {
  'lose-decoration': { file: surface, edits: [['api.browser.setOperatorAvatar({ ...target, png })', 'Promise.resolve(false)']] },
  'lose-exact-control': { file: surface, edits: [['control.activeOperationId === operation.id', 'true']] },
  'lose-current-control': { file: surface, edits: [['const control = props.control', 'const control = props.control ?? operation?.control']] },
  'lose-known-takeover': { file: surface, edits: [["const canTakeControl = control?.owner === 'agent'", 'const canTakeControl = controlled']] },
  'lose-cancellation': { file: surface, edits: [['if (current) void api.browser.setOperatorAvatar', 'void api.browser.setOperatorAvatar'], ['if (!current) return', 'void current']] },
  'lose-avatar-appearance': { file: surface, edits: [['operatorAppearance={appearance}', 'operatorAppearance={undefined}']] },
  'lose-unique-identity': { file: identity, edits: [['candidates?.length === 1', 'Boolean(candidates?.length)']] },
  'lose-replay-identity': { file: store, edits: [[
    'api.browser.runReplay(request.browserId, runPlan, request.caller\n        ? browserOperatorForSession(request.caller.agentSessionId, get().sessions)',
    'api.browser.runReplay(request.browserId, runPlan, request.caller\n        ? { id: request.caller.agentSessionId, name: request.caller.agentSessionId }'
  ]] },
  'lose-current-handoff': { file: pane, edits: [[
    "const operationId = tab.control?.owner === 'agent' ? tab.control.activeOperationId : tab.activity?.operation?.id",
    'const operationId = tab.activity?.operation?.id'
  ]] }
}
const proof = { name: 'original-browser-operator-consumer', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const file = relative(root, id.split('?')[0]!)
    if (![surface, identity, store, pane].includes(file)) return
    const selected = process.env.AGENTMUX_PRESENCE_MUTATION, edit = selected ? mutations[selected] : undefined
    if (selected && !edit) throw new Error('Unknown Browser presence mutation')
    let output = source
    if (edit?.file === file) for (const [from, to] of edit.edits) {
      if (output.split(from).length !== 2) throw new Error('The Browser presence mutation must match exactly once')
      output = output.replace(from, to)
    }
    if (process.env.AGENTMUX_PRESENCE_LOADED) appendFileSync(process.env.AGENTMUX_PRESENCE_LOADED,
      JSON.stringify({ file, sourceSha256: createHash('sha256').update(source).digest('hex'),
        loadedSha256: createHash('sha256').update(output).digest('hex'), mutation: output === source ? null : selected }) + '\n')
    return output === source ? undefined : output
  } }
export default defineConfig({ ...base, cacheDir: `.cache/browser-operator-presence-consumer-${process.env.AGENTMUX_PRESENCE_MUTATION ?? 'baseline'}`,
  plugins: [...base.plugins ?? [], proof], test: { ...base.test, include: ['apps/desktop/test/browser-operator-presence-consumer.test.tsx',
    'apps/desktop/test/browser-operator-identity.test.ts', 'apps/desktop/test/browser-operation-surface.test.tsx'] } })
