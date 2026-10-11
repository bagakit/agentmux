import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AgentTimelineItem, AgentSessionHistoryItem } from '../../src/types.js'
import { savedQuestionEvent, savedQuestionReply, savedQuestionTool, savedQuestionResult } from './codex-saved-question.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../../test/fixture-values.mjs'


/** Original bounded zhQg DTOs plus the maintained canonical Codex machine shapes.
 * Test-only inputs for the public/UI/connector joint read. No source association is inferred. */
export function unifiedConversationOriginals() {
  const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../apps/desktop/test/fixtures/conversation-source-roles.json'), 'utf8')) as {
    scope: string; agentSessionId: string; source: { providerId: string; nativeSessionId: string }; native: AgentSessionHistoryItem; captured: AgentTimelineItem
  }
  const invocation = { source: fixture.source, subject: 'main' as const, scope: { kind: 'session' as const }, callId: 'original-protocol-call' }
  return { ...fixture, codexRows: [savedQuestionTool(), savedQuestionEvent(), savedQuestionResult(), savedQuestionReply()],
    // A declared second protocol input; not claimed to be part of the original zhQg extract.
    claudeTool: { uuid: 'declared-original-tool', sessionId: fixture.source.nativeSessionId, type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Original surrounding speech' }, { type: 'tool_use', id: invocation.callId, name: 'shell', input: { command: 'pwd' } }] } },
    capturedTool: { id: 'declared-captured-invocation', agentSessionId: fixture.agentSessionId, kind: 'tool_call' as const,
      source: 'native-hook' as const, status: 'complete' as const, title: 'Original tool observation', toolName: 'shell',
      toolInput: '{"command":"pwd"}', createdAt: _historyFixtureEpoch(0, 0, 300), updatedAt: _historyFixtureEpoch(0, 0, 300),
      conversation: { invocations: [{ selector: { kind: 'captured-field' as const, field: 'toolInput' as const }, invocation }] } } }
}
