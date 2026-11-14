import { resolve, relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'
import { radixOverlayAliases } from '../../../packages/client-ui/scripts/radix-overlay-aliases'
const root = resolve(import.meta.dirname, '../../..')
const variants: Record<string, [string, string, string]> = {
  'unqualified-mote-receipt': ['packages/core/src/desktop-focus-parser.ts', "if (requested.kind === 'mote' && (actual.surface", "if (false && (actual.surface"],
  'mote-as-generic-space': ['apps/desktop/src/main/spatial-link-ingress.ts', "request = { ...base, target: { kind: 'mote', spaceId: target.spaceId,", "request = { ...base, target: { kind: 'space', spaceId: target.spaceId,"],
  'bare-topic-id': ['apps/desktop/src/renderer/src/lib/desktop-focus-navigation.ts', 'const spaces = catalog.spaces.filter(space => space.spaceId === spaceId)', 'const spaces = catalog.spaces.filter(space => space.topicId === spaceId)'],
  'drop-direct-event': ['packages/client-ui/src/lib/use-mote-dialogue.ts', 'const query: MoteDialogueRead = { target, ...selection, limit: 50,', 'const query: MoteDialogueRead = { target, limit: 50,'],
  'generic-presentation-success': ['apps/desktop/src/renderer/src/lib/desktop-presentation.ts', "return thread ? { spaceId, page: 'threads', eventId: thread.dataset.moteWorkThread! } : null", "return { spaceId, page: 'threads', eventId: target.eventId! }"],
  'skip-thread-open': ['packages/client-ui/src/components/MoteConversationThreads.tsx', 'setExpanded(previous => new Set(previous).add(requestedEvent.eventId)); setSelected(requestedEvent.eventId)', 'setSelected(null)']
}
const mutant = process.env.AGENTMUX_MOTE_LINK_NAV_MUTANT
if (mutant && !variants[mutant]) throw Error('Unknown Mote link navigation mutant')
export default defineConfig({ ...base,
  resolve: { ...base.resolve, alias: [...base.resolve!.alias as [], { find: '@agentmux/browser', replacement: resolve(import.meta.dirname, '../../../packages/browser/src') }, ...Object.entries(radixOverlayAliases).map(([find, replacement]) => ({ find, replacement }))] },
  plugins: [...base.plugins ?? [], { name: 'original-mote-navigation-counterexample', enforce: 'pre', transform(source, id) {
    if (!mutant) return
    const [file, before, after] = variants[mutant]!
    if (relative(root, id.split('?')[0]!) !== file) return
    if (source.split(before).length !== 2) throw Error('Expected one current production mutation anchor: ' + mutant)
    const changed = source.replace(before, after), trace = process.env.AGENTMUX_MOTE_LINK_NAV_TRACE
    if (!trace) throw Error('Loaded original source trace is required')
    const digest = (value: string) => createHash('sha256').update(value).digest('hex')
    appendFileSync(trace, JSON.stringify({ mutant, file, original: digest(source), changed: digest(changed) }) + '\n')
    return { code: changed, map: null }
  } }],
  test: { ...base.test, include: ['apps/desktop/test/mote-object-navigation.test.tsx', 'apps/desktop/test/spatial-link-ingress.test.ts', 'apps/desktop/test/mote-threads-source.test.tsx'], passWithNoTests: false, testTimeout: 20000 }
})
