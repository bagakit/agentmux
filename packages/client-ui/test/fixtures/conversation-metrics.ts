import type { AgentSessionHistoryPage } from '@agentmux/core'

/** Public DTO preview only; the Provider/public CLI producers are tested in the Core slice. */
export function metricsPage(nativeSessionId = 'native-reading'): AgentSessionHistoryPage {
  return { agentSessionId: 'metrics-session', source: { providerId: 'native-fixture', nativeSessionId }, nextCursor: null, items: [
    { id: 'input', kind: 'user-message', contentParts: [{ kind: 'text', text: '查看系统版本和架构，用一行告诉我结果。' }] },
    { id: 'read-call', turnId: 'turn-original', kind: 'activity', contentParts: [
      { kind: 'tool-call', name: 'inspect', input: 'Inspect system version and architecture', callId: 'call-original' },
      { kind: 'tool-result', name: 'inspect', output: 'Original retained inspection result', callId: 'call-original' }
    ] },
    { id: 'usage-first', turnId: 'turn-original', kind: 'activity', contentParts: [{ kind: 'text', text: '{"original":"first usage record"}' }],
      metrics: { scope: 'turn', usage: { inputTokens: 200, outputTokens: 10, totalTokens: 210 } } },
    { id: 'progress', turnId: 'turn-original', kind: 'assistant-message', messagePhase: 'progress', contentParts: [{ kind: 'text', text: '版本和架构已经读到，正在核对结果。' }] },
    { id: 'usage-last', turnId: 'turn-original', kind: 'activity', contentParts: [{ kind: 'text', text: '{"original":"latest cumulative record"}' }],
      metrics: { scope: 'turn', usage: { inputTokens: 600, outputTokens: 127, totalTokens: 727, cachedInputTokens: 400, reasoningOutputTokens: 66 } } },
    { id: 'answer', turnId: 'turn-original', kind: 'assistant-message', messagePhase: 'final', contentParts: [{ kind: 'text', text: '系统版本 26.5.1，架构为 arm64。' }] },
    { id: 'duration', turnId: 'turn-original', kind: 'activity', contentParts: [{ kind: 'text', text: '{"duration_ms":13000}' }],
      metrics: { scope: 'turn', durationMs: 13_000, status: 'completed' } }
  ] }
}

export function responsePage(): AgentSessionHistoryPage {
  return { agentSessionId: 'metrics-session', source: { providerId: 'another-native', nativeSessionId: 'response-reading' }, nextCursor: null, items: [
    { id: 'response-input', kind: 'user-message', contentParts: [{ kind: 'text', text: '解释这条记录的计量范围。' }] },
    { id: 'response', kind: 'assistant-message', contentParts: [{ kind: 'text', text: '这是一条单次响应的原生报告，整轮耗时没有记录。' }],
      metrics: { scope: 'response', usage: { inputTokens: 42, outputTokens: 0, totalTokens: 42 } } },
    { id: 'unknown', kind: 'activity', contentParts: [{ kind: 'text', text: 'Original record remains readable when metrics are unavailable.' }],
      metricsDiagnostic: { code: 'METRICS_UNAVAILABLE', message: '用量记录无法确认，原记录与 Agent 仍可使用。' } }
  ] }
}
