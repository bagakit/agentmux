import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'
import { radixOverlayAliases } from '../scripts/radix-overlay-aliases'
const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, [string, string, string]> = {
  'unfold-default': ['apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', "const conversationChrome = mote?.presentation === 'conversation'", "const conversationChrome = false && mote?.presentation === 'conversation'"],
  'drop-original-action': ['apps/desktop/src/renderer/src/components/MoteWorkface.tsx', 'showOriginalWorkface: () => setOriginal(owner)', 'showOriginalWorkface: () => {}'],
  'wrong-main-target': ['apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', 'session.control.agentSessionId !== currentMain.sessionId', 'false']
}
const name = process.env.AGENTMUX_MOTE_CHROME_MUTATION
if (name && !mutations[name]) throw Error('Unknown Mote chrome mutation')
export default defineConfig({ ...base, plugins: [...base.plugins ?? [], { name: 'loaded-mote-chrome-counterexample', enforce: 'pre', transform(original, id) {
  if (!name) return
  const [file, before, after] = mutations[name]!
  if (relative(root, id.split('?')[0]!) !== file) return
  if (original.split(before).length !== 2) throw Error('Mutation anchor must name one actual product branch: ' + name)
  const changed = original.replace(before, after), trace = process.env.AGENTMUX_MOTE_CHROME_TRACE
  if (!trace) throw Error('Original loading receipt is required')
  const sha = (value: string) => createHash('sha256').update(value).digest('hex')
  appendFileSync(trace, JSON.stringify({ name, file, before: sha(original), after: sha(changed) }) + '\n')
  return { code: changed, map: null }
} }], resolve: { ...base.resolve, alias: [...(base.resolve!.alias as []), ...Object.entries(radixOverlayAliases).map(([find, replacement]) => ({ find, replacement }))] }, test: { ...base.test,
  include: ['apps/desktop/test/mote-conversation-chrome.test.tsx'], passWithNoTests: false, testTimeout: 20000 } })
