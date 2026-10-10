import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import original from './vitest.launch-choice-details.config.mts'
const root = resolve(import.meta.dirname, '../../..'), component = 'apps/desktop/src/renderer/src/components/ConversationLandmarks.tsx'
const changes = {
  retain: ['apps/desktop/src/renderer/src/store.ts', 'conversationLandmarkIntents: { ...state.conversationLandmarkIntents, [key]: parsed }', 'conversationLandmarkIntents: state.conversationLandmarkIntents'],
  reopen: [component, 'if (state.beginNewConfirmedIntent())', 'if (false)'],
  native: ['packages/client-ui/src/components/ConversationView.tsx', 'itemRef && renderRecordActions?.(itemRef, reading.active !== false)', 'null'],
  captured: ['apps/desktop/src/renderer/src/components/ActivityView.tsx', "executionHostId && renderRecordActions?.({ hostId: executionHostId, agentSessionId: entry.item.agentSessionId, source: { kind: 'captured', recordId: entry.item.id } }, readingEnabled)", 'null'],
  retry: [component, 'const original = intent ??', 'const original = null ??'],
  source: [component, 'key={JSON.stringify(props.reference)}', 'key="shared-source"'],
  retainedAck: [component, 'else if (intent && !busyRef.current) void check()', 'else if (false) void check()'],
  positionFocus: [component, 'if (focusPending.current)', 'if (false)'],
  lazy: [component, 'if (next) onOpen?.()', 'if (false) onOpen?.()'],
  ime: [component, "event.key === 'Enter' && isImeOwnedKeyboardEvent(event)", 'false'],
  navigate: [component, 'const result = await reveal(point.reference)', "const result = await reveal({ ...point.reference, source: { kind: 'captured', recordId: point.id } })"],
  loadedSource: ['apps/desktop/src/renderer/src/components/ActivityView.tsx', 'node.dataset.messageSourceKey === sourceKey', 'true'],
  adapter: ['apps/desktop/src/renderer/src/lib/conversation-landmarks-api.ts', 'return parseConversationLandmarkPage(await bridge.list(input), input)', 'return await bridge.list(input)']
} as const
const sha = (source: string) => createHash('sha256').update(source).digest('hex')
export default defineConfig({ ...original, plugins: [{ name: 'original-landmark-gui-mutations', enforce: 'pre', transform(source, id) {
  const name = process.env.LANDMARK_GUI_MUTATION as keyof typeof changes | undefined
  if (!name) return; assert.ok(changes[name]); const [file, needle, replacement] = changes[name]; if (relative(root, id) !== file) return
  const occurrences = source.split(needle).length - 1; assert.equal(occurrences, name === 'ime' ? 2 : 1)
  const changed = source.split(needle).join(replacement); if (process.env.LANDMARK_GUI_HITS) appendFileSync(process.env.LANDMARK_GUI_HITS, JSON.stringify({ name, file, occurrences, source: sha(source), changed: sha(changed) }) + '\n')
  return { code: changed, map: null }
} }], test: { ...original.test, include: ['apps/desktop/test/conversation-landmarks.test.tsx'], passWithNoTests: false, testTimeout: 30000 } })
