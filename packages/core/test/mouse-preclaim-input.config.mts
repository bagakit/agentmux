import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './vitest.a2a-idle-input.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, [string, string, string]> = {
  'qualification-only': ['client.ts', '{ renderObservation, protocolInput,\n            onQueued:', '{ renderObservation, protocolInput: transportQualification ? protocolInput : undefined,\n            onQueued:'],
  'early-failure-ignored': ['client.ts', 'if (preempted) for (const protocol of protocolInputs) protocol.invalid = true', '/* Original raw failure is incorrectly ignored. */'],
  'origin-gap-ignored': ['client.ts', 'protocolInput.acknowledged.endByte > protocolInput.origin.inputByte && protocolInput.acknowledged.startByte > protocolInput.origin.inputByte ||', 'false ||'],
  'dispatch-gate-reopened': ['prompt-submission.ts', '      beginClaim()\n      if (control?.authorizeDispatch && !inputDispatch)', '      if (control?.authorizeDispatch && !inputDispatch)'],
  'caller-wait-uncancellable': ['client.ts', '(preparationSignal === lifetime ? predecessor : observePromptInput(preparationSignal, () => predecessor)).then', 'predecessor.then'],
}
const mutation = process.env.AGENTMUX_MOUSE_INPUT_MUTATION
if (mutation && !mutations[mutation]) throw new Error('Unknown mouse input mutation')
export default { ...base, plugins: [...(base.plugins ?? []), {
  name: 'mouse-preclaim-owner-proof', enforce: 'pre' as const,
  transform(original: string, id: string) {
    const file = relative(root, id.split('?')[0]!)
    if (!file.startsWith('packages/') || !file.endsWith('.ts') || file.includes('/node_modules/')) return
    let code = original
    const change = mutation && mutations[mutation]
    if (change && file === 'packages/core/src/' + change[0]) {
      if (original.split(change[1]).length !== 2) throw new Error('Mouse input mutation must match exactly one owner expression')
      code = original.replace(change[1], change[2])
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_MOUSE_INPUT_LOADED) appendFileSync(process.env.AGENTMUX_MOUSE_INPUT_LOADED,
      JSON.stringify({ file, original: hash(readFileSync(id.split('?')[0]!)), loaded: hash(code), ...(code === original ? {} : { mutation }) }) + '\n')
    return code === original ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: ['packages/core/test/mouse-preclaim-input.test.ts'], passWithNoTests: false } }
