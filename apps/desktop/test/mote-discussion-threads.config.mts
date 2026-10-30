import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'
import { radixOverlayAliases } from '../scripts/radix-overlay-aliases'
const root = resolve(import.meta.dirname, '../../..')
const variants: Record<string, [string, string, string]> = {
  'member-input-becomes-main': ['apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', "motePresentation.moteInputIntent !== 'member' && !moteWorkface?.memberIntent && moteDialogue?.target", 'moteDialogue?.target'],
  'known-main-generic-fallback': ['apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', "if (logicalMain && !moteMain)", "if (false && !moteMain)"],
  'member-conversation-hidden': ['apps/desktop/src/renderer/src/components/MoteWorkface.tsx', "const memberIntent = section === 'threads' && currentLocal.member", "const memberIntent = false"],
  'same-location-keeps-member-intent': ['apps/desktop/src/renderer/src/components/MoteWorkface.tsx', "matches && !onReferenceSelect || selectReference(next, 'main')", "matches || selectReference(next, 'main')"],
  'publisher-drops-input-intent': ['apps/desktop/src/renderer/src/lib/pmo-teams-topic-floating.ts', 'resolved.conversationIntent === current.conversationIntent && ', ''],
  'drop-main-dom-retention': ['apps/desktop/src/renderer/src/App.tsx', 'const previous = retainedMoteViews.current.owner === owner ? retainedMoteViews.current.targets : {}', 'const previous = {}'],
  'drop-main-pagination': ['packages/client-ui/src/components/MoteConversationThreads.tsx', 'current && page?.next ? <button', 'false ? <button'],
  'chrome-needs-live-agent': ['apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', "const conversationChrome = Boolean(mote && mote.presentation !== 'workface')", "const conversationChrome = Boolean(mote && mote.presentation !== 'workface' && activeRuntimeSession?.kind === 'agent')"],
  'threads-wrong-source-pair': ['packages/client-ui/src/components/MoteConversationThreads.tsx', 'return { source, value }', 'return { source: event.sources.find(item => item.origin.messageId === source.origin.messageId)!, value }']
}
const name = process.env.AGENTMUX_MOTE_NAV_MUTATION
if (name && !variants[name]) throw Error('Unknown navigation mutation')
export default defineConfig({ ...base,
  plugins: [...base.plugins ?? [], { name: 'loaded-mote-navigation-counterexample', enforce: 'pre', transform(original, id) {
    if (!name) return
    const [file, before, after] = variants[name]!
    if (relative(root, id.split('?')[0]!) !== file) return
    if (original.split(before).length !== 2) throw Error('Expected one current production mutation anchor: ' + name)
    const changed = original.replace(before, after), trace = process.env.AGENTMUX_MOTE_NAV_TRACE
    if (!trace) throw Error('Loaded production trace is required')
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    appendFileSync(trace, JSON.stringify({ name, file, original: sha(original), changed: sha(changed) }) + '\n')
    return { code: changed, map: null }
  } }],
  resolve: { ...base.resolve, alias: [...base.resolve!.alias as [], ...Object.entries(radixOverlayAliases).map(([find, replacement]) => ({ find, replacement }))] },
  test: { ...base.test, include: ['apps/desktop/test/mote-discussion-threads.test.tsx', 'apps/desktop/test/mote-threads-source.test.tsx'], passWithNoTests: false, testTimeout: 20000 }
})
