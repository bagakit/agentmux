import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import base from './mote-session-reading.config.mts'
const variants: Record<string, { path: string; edits: [string, string][] }> = {
  'flat-process': { path: 'packages/client-ui/src/components/ConversationView.tsx', edits: [["renderProcess={renderProcess ?? (props => <NativeProcessObservation {...props} compact />)}", 'renderProcess={renderProcess}']] },
  'expanded-process': { path: 'packages/client-ui/src/components/ConversationRecordSequence.tsx', edits: [['return renderProcess({ id: row.id, records: row.records,', 'return renderProcess({ id: row.id, records: row.records, initiallyExpanded: true,']] },
  'no-detach': { path: 'apps/desktop/src/renderer/src/lib/mote-session-reading.ts', edits: [[': onScroll(state.current, readable)', ': { ...state.current, lastScrollTop: next.scrollTop }']] },
  'restore-as-user': { path: 'apps/desktop/src/renderer/src/lib/mote-session-reading.ts', edits: [["programmatic === 'restore' || clamp ? { ...state.current, lastScrollTop: next.scrollTop }", "programmatic === 'restore' || clamp ? onScroll(state.current, readable)"]] },
  'resize-grants-follow': { path: 'apps/desktop/src/renderer/src/lib/mote-session-reading.ts', edits: [['physical.current = rawGeometry(); state.current = { ...state.current, lastScrollTop: viewport.current.scrollTop }', 'physical.current = rawGeometry(); state.current = { ...state.current, following: true, lastScrollTop: viewport.current.scrollTop }']] },
  'selection-admitted': { path: 'apps/desktop/src/renderer/src/lib/mote-session-reading.ts', edits: [['if (selected()) { detach(); return false }', 'if (selected()) { detach(); return true }']] },
  'captured-anchor': { path: 'packages/client-ui/src/lib/conversation-reading-anchor.ts', edits: [[", [data-conversation-layout-key]:not([data-conversation-process-key])'", "'"]] },
  'inactive-reader': { path: 'apps/desktop/src/renderer/src/components/MoteConversationBrowser.tsx', edits: [['choice.conversation(active && showDetail && choice.id === current)', 'choice.conversation(showDetail && choice.id === current)']] },
  'foreign-selection': { path: 'apps/desktop/src/renderer/src/lib/mote-session-reading.ts', edits: [['if (node && selected() && selection?.rangeCount)', 'if (node && selection?.rangeCount)'], ['if (!node.contains(range.startContainer) || !node.contains(range.endContainer)) return false', 'void range']] },
  'footer-tail': { path: 'apps/desktop/src/renderer/src/lib/mote-session-reading.ts', edits: [['node.scrollTop = Math.max(0, readingHeight(node) - node.clientHeight)', 'node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight)']] },
  'visible-footer-detaches': { path: 'apps/desktop/src/renderer/src/lib/mote-session-reading.ts', edits: [['if (selected() || tailAbove || !wasFollowing && !atMessageTail())', 'if (selected() || next.scrollTop > Math.max(0, readable.scrollHeight - readable.clientHeight) + 64 || tailAbove || !wasFollowing && !atMessageTail())']] },
  'follow-as-position': { path: 'apps/desktop/src/renderer/src/lib/mote-session-reading.ts', edits: [['setAtTail(atMessageTail())', 'setAtTail(state.current.following)']] }
}
const mutant = process.env.MOTE_READING_MUTANT, change = mutant ? variants[mutant] : undefined
if (mutant && !change) throw Error('Unknown original reading mutation')
export default defineConfig({ ...base, cacheDir: '.tmp/mote-reading-behavior-' + (mutant ?? 'original'), plugins: [{ name: 'original-session-reading-proof', enforce: 'pre', transform(source, id) {
  const path = relative(base.root!, id.split('?')[0]!)
  if (!/^(apps\/desktop\/src|packages\/(core|client-ui)\/src)\/.*\.[cm]?[jt]sx?$/u.test(path)) return
  let loaded = source
  if (change?.path === path) for (const [before, after] of change.edits) {
    if (loaded.split(before).length !== 2) throw Error('Reading mutation anchor missing or ambiguous: ' + mutant)
    loaded = loaded.replace(before, after)
  }
  const trace = process.env.MOTE_READING_LOADED
  if (trace) { const hash = (value: string) => createHash('sha256').update(value).digest('hex'); appendFileSync(trace, JSON.stringify({ path,
    raw: hash(readFileSync(id.split('?')[0]!, 'utf8')), original: hash(source), loaded: hash(loaded), mutation: source === loaded ? null : mutant }) + '\n') }
  return source === loaded ? undefined : { code: loaded, map: null }
} }, ...base.plugins!], test: { ...base.test, include: ['apps/desktop/test/mote-session-reading.test.tsx'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 } })
