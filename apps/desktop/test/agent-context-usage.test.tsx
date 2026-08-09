import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentContextUsage } from '../src/renderer/src/components/AgentContextUsage'
import { extractTurnUsage, parseTurnUsage } from '../../../packages/core/src/agent-usage-transcript'
import { normalizeStoredAgentSession } from '../../../packages/core/src/agent-session-store'

function observe(used: number, capacity: unknown = 1000) {
  const content = JSON.stringify({ payload: { type: 'token_count', info: {
    last_token_usage: { input_tokens: used - 10, output_tokens: 10, total_tokens: used },
    total_token_usage: { total_tokens: 9000000 }, model_context_window: capacity
  } } })
  const usage = parseTurnUsage(extractTurnUsage({ kind: 'native-transcript', transcriptFormat: 'codex-rollout' }, content, 1000))!
  return normalizeStoredAgentSession({ kind: 'agent', agentSessionId: 'context-test',
    providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/tmp/test',
    run: { runId: 'run-test' }, retiredRuns: [], hookBindingId: 'test-binding', hookToken: 'test-token',
    outputCursorBytes: 0, createdAt: 0, updatedAt: 1000, turnUsage: usage
  }).turnUsage!
}

describe('context observation to composer', () => {
  it('preserves current native usage through IPC parsing and store restore, never lifetime billing', () => {
    const usage = observe(250)
    expect(usage.context).toEqual({ usedTokens: 250, capacityTokens: 1000 })
    const html = renderToStaticMarkup(<AgentContextUsage usage={usage} />)
    expect(html).toContain('Context remaining 75%')
    expect(html).toContain('Last native observation:')
    expect(html).toContain('tabindex="0"')
  })
  it('reflects reduced context after compaction and clamps exhausted remaining to zero', () => {
    expect(renderToStaticMarkup(<AgentContextUsage usage={observe(800)} />)).toContain('Context remaining 20%')
    expect(renderToStaticMarkup(<AgentContextUsage usage={observe(200)} />)).toContain('Context remaining 80%')
    expect(renderToStaticMarkup(<AgentContextUsage usage={observe(1100)} />)).toContain('Context remaining 0%')
  })
  it.each([undefined, 0, -1, '1000'])('keeps missing or invalid capacity %s unknown', (capacity) => {
    const usage = observe(250, capacity === undefined ? null : capacity)
    expect(usage.context).toBeUndefined()
    expect(renderToStaticMarkup(<AgentContextUsage usage={usage} />)).toContain('Context remaining unknown')
  })
})
