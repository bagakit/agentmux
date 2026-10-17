import { fixtureEpoch } from '../../../../../test/fixture-values.mjs'
import type { AgentSessionHistoryReadPage, AgentSessionUserMessage } from '@agentmux/core'
import type { AgentInputMailboxItem, AgentInputMailboxPage } from '@agentmux/core/agent-input-mailbox'

export const journalBody = 'Mercury · 核对输入记录的来源，并保留原始消息。\n\n' + '完整正文需要能连续阅读，未知回执不代表发送成功。'.repeat(24) + '\n原文末尾仍然可读。'
export const journalWire = '<amux>Fixture platform context</amux>\n\n' + journalBody
export const secondJournalBody = 'Orbit · 整理页面的视觉层级和键盘交互。'
export const capturedBody = 'Mercury · 对照已捕获的输入，检查刷新与搜索是否一致。'
export const nativeBody = 'Aurora · 原生历史保留准确来源，不猜测作者。'

export function inputPage(agentSessionId: string, run: { runId: string }): AgentInputMailboxPage {
  const items: AgentInputMailboxItem[] = [journalBody, secondJournalBody].map((prompt, index) => ({
    kind: 'controlled', sequence: 2 - index, recordedAt: fixtureEpoch(0, 0, 4000 - index * 1000),
    intent: { key: { kind: 'prompt', agentSessionId, expectedRun: run, submissionId: 'journal-' + index },
      admissionIntent: { kind: 'manual-actor', expectedRun: run }, execution: 'immediate',
      source: { kind: 'prompt', prompt, ...(index === 0 ? { promptWire: journalWire } : { authorHuman: true }) } },
    receipt: null, failure: { name: 'Error', code: 'OBSERVATION_UNKNOWN', message: 'The original receipt remains unconfirmed.' }
  }))
  return { agentSessionId, queueId: 'workspace-inputs', cut: { incarnation: 'workspace-input-cut', throughSequence: 2 },
    budgetBytes: 128 * 1024, items: items.map(item => ({ kind: 'item', item })), nextCursor: null,
    coverage: { kind: 'recorded-inputs', unrecorded: 'unconfirmed' } }
}

export function visualInputPage(agentSessionId: string, run: { runId: string }): AgentInputMailboxPage {
  const page = inputPage(agentSessionId, run)
  return { ...page, items: page.items.map(entry => {
    if (entry.kind !== 'item' || entry.item.kind !== 'controlled' || entry.item.sequence !== 1 ||
      entry.item.intent.source.kind !== 'prompt' || entry.item.intent.key.kind !== 'prompt') return entry
    const { recordedAt, sequence } = entry.item, { key } = entry.item.intent, { prompt } = entry.item.intent.source
    // A registered launch input gives the real reader a plain row without actions or a status footer.
    return { kind: 'item', item: { kind: 'submission', recordedAt, sequence, key,
      record: { agentSessionId, run, launch: {
        input: { submissionId: key.submissionId, prompt, authorHuman: true }, prompt, message: { userContent: prompt, authorHuman: true },
        digest: 'fixture-input-digest', delivery: 'launch', lifecycleOperationId: 'workspace-launch', state: 'launch-carried', key,
        receipt: { kind: 'runtime-launch', operationId: 'workspace-launch', run, observedAt: recordedAt }
      } } } }
  }) }
}

export function historyPage(hostId: string, agentSessionId: string, source: 'captured' | 'native', query = ''): AgentSessionHistoryReadPage {
  const content = source === 'captured' ? capturedBody : nativeBody
  const message: AgentSessionUserMessage = { id: source + ':workspace-record', rawId: 'workspace-record', agentSessionId,
    content, contentParts: [{ kind: 'text', text: content }], author: { kind: 'unknown' },
    recordedAt: fixtureEpoch(0, 0, source === 'captured' ? 2000 : 1000), deliveryStatus: 'unverified',
    source: source === 'captured' ? { kind: 'captured', submissionId: 'workspace-captured' }
      : { kind: 'native', providerId: 'codex', nativeSessionId: 'workspace-native', recordId: 'workspace-record' } }
  return { hostId, agentSessionId, source, revision: 'workspace-read', availability: 'available', order: 'newest-first',
    items: [], nextCursor: null, budgetBytes: 128 * 1024, kind: 'user-message',
    userMessages: !query || content.includes(query) ? [message] : [], scan: { examined: 1, complete: true } }
}
