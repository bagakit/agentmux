// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform'
import { ConversationMessage } from '../src/components/ConversationMessage'
import { ConversationView } from '../src/components/ConversationView'
import { NativeProcessObservation } from '../src/components/NativeProcessObservation'
import { ConversationToolPayload } from '../src/components/ConversationToolPayload'
import type { ConversationSources } from '../src/lib/conversation-sources'
import { projectConversationReading } from '../src/lib/conversation-records'
import type { AgentSessionHistoryPage } from '@agentmux/core'

let root: Root, host: HTMLDivElement
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: () => null,
  renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
const sources: ConversationSources = { main: { labels: [{ id: 'native', label: '原生对话', title: 'Original source identity' }] }, parts: [], fields: {} }
const wrap = (children: ReactNode) => <ClientUiProvider platform={platform}>{children}</ClientUiProvider>
const draw = async (children: ReactNode) => { await act(async () => root.render(wrap(children))) }
const click = async (scope: ParentNode, selector: string) => {
  const button = scope.querySelector<HTMLButtonElement>(selector); expect(button).not.toBeNull()
  await act(async () => button!.click())
}
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { getSelection()?.removeAllRanges(); await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('keeps the author and body primary while original identity, project and source remain available in Info', async () => {
  await draw(<ConversationMessage messageId="original-answer" conversationSessionId="reading-agent"
    speaker={{ role: 'agent', id: 'reading-agent' }} name="Original reader"
    describeSpeaker={() => ({ name: 'Original reader', project: { workspaceId: 'original-project', name: 'Original project', path: '' } })}
    sources={sources} createdAt={fixtureEpoch(0, 1)} content="Keep the original readable answer."
    detailsOnlyMetadata sourceLabelsInDetails showInputSource={false} />)
  const body = host.querySelector('.log-turn__text p')!
  expect(body.textContent).toBe('Keep the original readable answer.')
  expect(host.querySelector('.log-turn__who')?.textContent).toBe('Original reader')
  expect(host.querySelector('.log-turn > .log-turn__meta')).toBeNull()
  expect(host.querySelector('.log-turn__sender-id')).toBeNull()
  const text = body.firstChild!, range = document.createRange(); range.selectNodeContents(text); getSelection()!.addRange(range)
  await click(host, 'button[aria-label="Message details"]')
  const info = host.querySelector('.conversation-input-details__body')!
  expect(info.textContent).toContain('reading-agent'); expect(info.textContent).toContain('Original project')
  expect(info.querySelector('[data-conversation-source="native"]')?.textContent).toBe('原生对话')
  expect(host.querySelector('.log-turn__text p')).toBe(body)
  expect(range.startContainer).toBe(text); expect(getSelection()!.toString()).toBe('Keep the original readable answer.')
})

it.each(['failed', 'unverified'] as const)('keeps %s and an unread related source outside the normal provenance disclosure', async status => {
  await draw(<ConversationMessage messageId="original-issue" conversationSessionId="reading-agent"
    speaker={{ role: 'agent', id: 'reading-agent' }} name="Original reader" content="Original body remains readable."
    sources={{ ...sources, main: { ...sources.main, unread: true } }} status={status}
    detailsOnlyMetadata sourceLabelsInDetails showInputSource={false} />)
  const issue = host.querySelector(`.log-row__chip--${status}`)!
  expect(issue).not.toBeNull(); expect(issue.closest('[hidden]')).toBeNull()
  const unread = host.querySelector('[data-conversation-source-unread]')!
  expect(unread).not.toBeNull(); expect(unread.closest('.conversation-input-details__body')).toBeNull()
  expect(unread.closest('[hidden]')).toBeNull()
  expect(host.textContent).toContain('Original body remains readable.')
})

it('keeps a direct tool part source in its own Info scope while an unread part remains visible beside the original payload', async () => {
  const content = [{ kind: 'tool-call' as const, callId: 'original-direct-call', name: 'inspect', input: '{"original":true}' }]
  for (const unread of [false, true]) {
    await draw(<ConversationMessage messageId="original-direct-part" conversationSessionId="reading-agent"
      content={content} processContent sources={{ ...sources, parts: [{ ...sources.main, unread }] }}
      detailsOnlyMetadata sourceLabelsInDetails showInputSource={false} />)
    const payload = host.querySelector('.conversation-tool-trace__payload--direct')!
    const inlineSource = payload.querySelector(':scope > .conversation-source-labels')
    expect(Boolean(inlineSource)).toBe(unread)
    if (unread) expect(inlineSource?.querySelector('[data-conversation-source-unread]')).not.toBeNull()
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="Message details"]')!
    if (toggle.getAttribute('aria-expanded') !== 'true') await click(host, 'button[aria-label="Message details"]')
    const info = host.querySelector('.conversation-input-details__body')!
    expect(info.textContent).toContain('工具内容来源'); expect(info.textContent).toContain('原生对话')
    expect(payload.textContent).toContain('{"original":true}')
    expect(payload.querySelector('[aria-label="Copy tool input"]')).not.toBeNull()
    expect(payload.querySelector('.conversation-tool-payload__identity > .conversation-tool-trace__kind')?.textContent).toBe('Input')
  }
})

it('does not label a generic original record payload as a tool direction', async () => {
  const identity = {}
  await draw(<ConversationToolPayload text='{"originalRecord":true}' identity={identity} sourceIdentity={identity} copyLabel="Copy original record" />)
  expect(host.querySelector('.conversation-tool-trace__kind')).toBeNull()
  expect(host.querySelector('pre')?.textContent).toBe('{"originalRecord":true}')
})

it('keeps distinct original member times available without repeating the owning step clock in each payload header', async () => {
  const page: AgentSessionHistoryPage = { agentSessionId: 'reading-agent', sourceHostId: 'local',
    source: { providerId: 'recorded-provider', nativeSessionId: 'original-thread' }, nextCursor: null, items: [
      { id: 'original-input', kind: 'activity', startedAt: fixtureEpoch(0, 1), contentParts: [{ kind: 'tool-call', callId: 'original-call', name: 'inspect', input: '{"original":true}' }] },
      { id: 'original-result', kind: 'activity', startedAt: fixtureEpoch(0, 2), contentParts: [{ kind: 'tool-result', callId: 'original-call', name: 'inspect', output: 'Original returned bytes.' }] }
    ] }
  const reading = projectConversationReading({ agentSessionId: page.agentSessionId, executionHostId: 'local', historyPage: page })
  await draw(<ConversationView sessionId={page.agentSessionId} executionHostId="local" page={page}
    records={reading.records} originalRecords={reading.originalRecords} coverage={reading.timeline.coverage}
    renderProcess={props => <NativeProcessObservation {...props} compact />} />)
  for (const id of ['original-input', 'original-result']) {
    const step = host.querySelector(`[data-native-step-id="${id}"]`)!
    if (step.querySelector('button[data-observation-step-id]')?.getAttribute('aria-expanded') !== 'true') await click(step, 'button[data-observation-step-id]')
    const record = step.querySelector('[data-process-content]')!
    expect(record).not.toBeNull()
    expect(record.querySelector('.conversation-tool-payload__identity > .conversation-tool-trace__kind')?.textContent).toBe(id === 'original-input' ? 'Input' : 'Output')
    expect(record.querySelector(':scope > .log-turn__head .log-turn__time')).toBeNull()
    await click(record, 'button[aria-label="Message details"]')
    expect(record.querySelector('.conversation-input-details__body')?.textContent).toContain('原记录时间')
  }
  const times = [...host.querySelectorAll('[data-process-content] .conversation-input-details__body .log-turn__time')].map(node => node.textContent)
  expect(times).toHaveLength(2); expect(times[0]).not.toBe(times[1])
  expect(host.querySelector('[aria-label="Copy tool input"]')).not.toBeNull()
  expect(host.querySelector('[aria-label="Copy tool output"]')).not.toBeNull()
  expect(host.textContent).toContain('Original returned bytes.')
})
