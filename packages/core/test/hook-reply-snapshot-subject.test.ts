import { expect, it } from 'vitest'
import { AgentProviderRegistry } from '../dist/index.js'

const providers = new AgentProviderRegistry()
const main = { kind: 'provider' as const, providerId: 'codex', sessionId: 'original-native' }
const context = { nativeHandle: main, processNativeHandle: main, processNativeChildSessionIds: ['child-native'] }
const hook = (eventName: string, payload: Record<string, unknown>) => providers.get('codex').normalizeHook({ receiptId: `snapshot-${eventName}`,
  agentSessionId: 'original-agent', runId: 'codex-snapshot-run', providerId: 'codex', eventName, payload: { session_id: main.sessionId, ...payload } }, context)
const kinds = (event: ReturnType<typeof hook>) => event.timeline.flatMap(mutation => mutation.type === 'update' ? [] : [mutation.item.kind])

it('records a reply snapshot only for the confirmed main Agent, never for a child SubagentStop', () => {
  const stop = hook('Stop', { last_assistant_message: 'MAIN FINAL' })
  expect(stop.mainSubject).toBe(true)
  expect(kinds(stop)).toContain('assistant_message')
  const child = hook('SubagentStop', { agent_id: 'child-native', last_assistant_message: 'CHILD FINAL' })
  expect(child.mainSubject).toBe(false)
  expect(kinds(child)).not.toContain('assistant_message')
  expect(JSON.stringify(child.timeline)).not.toContain('CHILD FINAL')
  
})
