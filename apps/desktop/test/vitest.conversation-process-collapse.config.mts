import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import assert from 'node:assert/strict'
import original from './vitest.launch-choice-details.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const activity = 'apps/desktop/src/renderer/src/components/ActivityView.tsx'
const owner = 'packages/client-ui/src/lib/conversation-trace-disclosure.ts'
const changes = {
  consumer: [activity, 'traceDisclosure={traceDisclosure}', ''],
  collapse: [owner, 'if (current.current === owner) setState({ owner, expanded: EMPTY_TRACES })', ''],
  source: [owner, 'registrations: new Map<object, readonly string[]>() }), [source])', 'registrations: new Map<object, readonly string[]>() }), [])'],
  prune: [owner, '[...previous.expanded].filter(id => retained.has(id))', '[...previous.expanded]'],
  focus: [activity, 'event.currentTarget.focus({ preventScroll: true })', 'void 0'],
  anchor: [activity, 'if (anchorRef.current) restoreReadingPosition(feedEl, anchorRef.current)', ''],
  lease: [owner, 'current.current !== owner || ![...owner.registrations.values()].some(ids => ids.includes(id))', '![...owner.registrations.values()].some(ids => ids.includes(id))']
} as const
export default defineConfig({ ...original, plugins: [{ name: 'original-process-collapse-mutations', enforce: 'pre', transform(source, id) {
  const mutation = process.env.PROCESS_COLLAPSE_MUTATION as keyof typeof changes | undefined
  if (!mutation) return
  assert.ok(changes[mutation]); const [path, needle, replacement] = changes[mutation]
  if (relative(root, id) !== path) return
  assert.equal(source.split(needle).length - 1, 1, 'Unique actual product mutation')
  if (process.env.PROCESS_COLLAPSE_HITS) appendFileSync(process.env.PROCESS_COLLAPSE_HITS, path + '\n')
  return { code: source.replace(needle, replacement), map: null }
} }], test: { ...original.test, include: ['apps/desktop/test/conversation-process-collapse.test.tsx', 'apps/desktop/test/conversation-detail-feedback.test.tsx'], passWithNoTests: false } })
