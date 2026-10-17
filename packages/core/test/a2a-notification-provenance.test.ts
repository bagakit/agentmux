import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { describe, expect, it } from 'vitest'
import { projectConversationReading } from '../src/conversation.js'
import { parseConversationProvenance } from '../src/conversation-provenance.js'
import { normalizeAgentTimelineItem } from '../src/session-timeline.js'
import { projectSessionUserMessages } from '../src/session-user-messages.js'
import { createNativeInputCorrelation } from '../src/native-input-correlation.js'
import type { AgentPromptInputKey } from '../src/agent-prompt-condition.js'
import type { AgentSessionHistoryItem } from '../src/types.js'

const key: Extract<AgentPromptInputKey, { kind: 'prompt' }> = { kind: 'prompt', agentSessionId: 'recipient', expectedRun: { runId: 'original-run' }, submissionId: 'notice-input' }
const source = { providerId: 'provider', nativeSessionId: 'original-native' }
const wire = '<amux:a2a from="peer" msg-id="original-mid" read-via="message --skill" />'
function native(qualified = true): AgentSessionHistoryItem {
  return { id: 'native-original', kind: 'user-message', turnId: 'native-turn', title: 'Input', content: wire,
    contentParts: [{ kind: 'text', text: wire }], startedAt: _tailFixtureEpoch(0, 0, 10),
    conversation: { nativeInput: { source, semanticItemId: 'native-original', turnId: 'native-turn', clientCorrelation: createNativeInputCorrelation(key) },
      ...(qualified ? { adoptedInput: { key, purpose: 'a2a-notification' as const } } : {}) } }
}
function captured() {
  return normalizeAgentTimelineItem({ id: 'captured-original', agentSessionId: key.agentSessionId, kind: 'system_message', source: 'agentmux',
    status: 'complete', createdAt: _tailFixtureEpoch(0, 0, 9), updatedAt: _tailFixtureEpoch(0, 0, 9), title: 'AgentMux context', content: wire,
    a2aNotificationId: key.submissionId, inputRef: key })
}
function sources(qualified = true) {
  return { agentSessionId: key.agentSessionId, executionHostId: 'local',
    historyPage: { agentSessionId: key.agentSessionId, sourceHostId: 'local', source, items: [native(qualified)], nextCursor: null },
    timeline: { agentSessionId: key.agentSessionId, sourceHostId: 'local', revision: 1, items: [captured()] } }
}

describe('qualified A2A notification purpose at the original Conversation boundary', () => {
  it('joins the original captured platform input with its actual native adoption as one system notice', () => {
    const original = sources(), reading = projectConversationReading(original)
    expect(reading.records).toHaveLength(1)
    const record = reading.records[0]!
    expect(record.role).toBe('notice'); expect(record.author).toEqual({ kind: 'system' })
    expect(record.event?.content.map(slot => slot.placement)).toEqual(['body', 'detail'])
    expect(record.contentParts).toEqual([{ kind: 'text', text: wire }])
    expect(record.records).toHaveLength(2)
    expect(record.records?.find(record => record.original.kind === 'captured')?.original.item).toEqual(original.timeline.items[0])
    expect(reading.inputs).toEqual([])
    expect(projectSessionUserMessages(original)).toEqual([])
    expect(original.historyPage.items[0]?.kind).toBe('user-message')
    expect(original.historyPage.items[0]?.contentParts).toEqual([{ kind: 'text', text: wire }])
  })

  it('never derives platform purpose, sender or an accepted join from reference-shaped authored text', () => {
    const original = sources(false), reading = projectConversationReading(original)
    expect(reading.records).toHaveLength(2)
    const recorded = reading.records.find(record => record.source.kind === 'native')!
    expect(recorded.role).toBe('message'); expect(recorded.author).toEqual({ kind: 'unknown' })
    expect(recorded.contentParts).toEqual([{ kind: 'text', text: wire }])
    expect(reading.inputs).toHaveLength(1)
    expect(reading.inputs[0]?.author).toEqual({ kind: 'unknown' })
    expect(reading.records.find(record => record.source.kind === 'captured')?.role).toBe('notice')
  })

  it('retains only the exact purpose admitted by the provenance decoder', () => {
    const provenance = native().conversation!
    expect(parseConversationProvenance(provenance)).toEqual(provenance)
    expect(() => parseConversationProvenance({ ...provenance, adoptedInput: { key, purpose: 'human' } })).toThrow('Invalid native input provenance')
    expect(() => parseConversationProvenance({ adoptedInput: provenance.adoptedInput })).toThrow('Invalid native input provenance')
  })

  it('requires the platform writer to retain its own exact original input key', () => {
    const item = captured()
    for (const change of [{ inputRef: undefined }, { inputRef: { ...key, submissionId: 'other-input' } }, { source: 'user' }, { authorHuman: true }]) {
      expect(() => normalizeAgentTimelineItem({ ...item, ...change })).toThrow()
    }
    expect(normalizeAgentTimelineItem(item)).toEqual(item)
  })
})
