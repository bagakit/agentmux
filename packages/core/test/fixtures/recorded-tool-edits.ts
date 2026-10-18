import { AgentProviderRegistry } from '../../src/agent-provider.js'
import type { AgentTimelineItem } from '../../src/types.js'

/** Real Provider normalization over a controlled original Hook, with its exact invocation provenance. */
export function recordedToolEdit(agentSessionId: string, callId = 'original-edit'): AgentTimelineItem {
  const event = new AgentProviderRegistry().get('claude').normalizeHook({ receiptId: 'recorded-edit', providerId: 'claude',
    agentSessionId, runId: 'original-page-fixture-run', eventName: 'PostToolUse',
    payload: { session_id: 'original-native', tool_use_id: callId, tool_name: 'Edit',
      tool_input: { file_path: 'src/answer.ts', old_string: 'original answer\nkept line', new_string: 'revised answer\nkept line' },
      tool_response: 'Original recorded output' } }, {})
  const mutation = event.timeline.find(change => change.type === 'upsert' || change.type === 'append')
  if (!mutation || mutation.type !== 'upsert' && mutation.type !== 'append') throw new Error('Provider did not record the original tool invocation')
  return mutation.item
}
