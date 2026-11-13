import { afterEach, expect, it } from 'vitest'
import { jsonl, nativeHistoryFixture } from './fixtures/native-history-session.js'

const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
const nativeSessionId = 'codex-native-thread'
const message = (id: string, content: unknown[]) => ({ type: 'response_item', payload: { type: 'message', id, role: 'assistant', phase: 'final_answer', content } })

it('reads an empty Codex final_answer as a turn step, not as a reply without a body', async () => {
  const f = await nativeHistoryFixture('codex', root => jsonl([
    { type: 'session_meta', payload: { id: nativeSessionId, cwd: root, history_mode: 'paginated' } },
    message('answered-through-tool', [{ type: 'output_text', text: '' }]),
    message('readable', [{ type: 'output_text', text: 'The readable answer.' }])
  ]), { nativeSessionId })
  closes.push(f.close)
  const items = (await f.client.sessionHistoryPage(f.session.agentSessionId)).items
  expect(items.find(item => item.id === 'answered-through-tool')?.kind).toBe('activity')
  expect(items.find(item => item.id === 'readable')).toMatchObject({ kind: 'assistant-message', messagePhase: 'final' })
})
