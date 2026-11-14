import { afterEach, expect, it } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'

const providers = new AgentProviderRegistry()
const main = { kind: 'provider' as const, providerId: 'codex', sessionId: 'original-native' }
const runId = 'codex-unconfirmed-child-run'
afterEach(() => {  })
const hook = (eventName: string, payload: Record<string, unknown>, children: string[] = []) => providers.get('codex').normalizeHook({ receiptId: `unconfirmed-${eventName}`,
  agentSessionId: 'original-agent', runId, providerId: 'codex', eventName, payload: { session_id: main.sessionId, ...payload } },
  { nativeHandle: main, processNativeHandle: main, processNativeChildSessionIds: children })
const replies = (event: ReturnType<typeof hook>) => event.timeline.flatMap(mutation => mutation.type !== 'update' && mutation.item.kind === 'assistant_message' ? [mutation.item.content] : [])

it('a child the roster has not confirmed yet does not speak as the parent', () => {
  // The child's rollout is not on disk yet, so the process witness cannot list it.
  const child = hook('SubagentStop', { agent_id: 'unlisted-child', last_assistant_message: 'CHILD FINAL' })
  expect(child.subject).toMatchObject({ kind: 'unknown', reason: 'native-child-membership-unconfirmed' })
  expect(replies(child)).toEqual([])
  expect(JSON.stringify(child.timeline)).not.toContain('CHILD FINAL')
})

it('the parent keeps its reply, including when its own identity is still unknown', () => {
  expect(replies(hook('Stop', { last_assistant_message: 'MAIN FINAL' }))).toEqual(['MAIN FINAL'])
  // Without a child identity an observation gap is not a child: the snapshot stays.
  const unwitnessed = providers.get('codex').normalizeHook({ receiptId: 'unwitnessed-stop', agentSessionId: 'original-agent', runId, providerId: 'codex', eventName: 'Stop',
    payload: { session_id: main.sessionId, last_assistant_message: 'MAIN WITHOUT WITNESS' } }, { nativeHandle: main })
  expect(unwitnessed.subject.kind).toBe('unknown')
  expect(replies(unwitnessed)).toEqual(['MAIN WITHOUT WITNESS'])
})

it('a confirmed child stays out of the parent replies as before', () => {
  const child = hook('SubagentStop', { agent_id: 'listed-child', last_assistant_message: 'LISTED CHILD FINAL' }, ['listed-child'])
  expect(child.subject.kind).toBe('child')
  expect(replies(child)).toEqual([])
})
