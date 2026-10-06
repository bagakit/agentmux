// @vitest-environment happy-dom
import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act, useRef, useState } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxAgentSession, AgentSessionHistoryPage, AgentSessionHistoryReadPage, AgentSessionUserMessage } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { ClientUiProvider } from '@agentmux/client-ui'
import { projectConversationRecords } from '@agentmux/client-ui/conversation-records'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { FocusMessagePreview } from '../src/renderer/src/components/FocusMessagePreview'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { LauncherResumePicker } from '../src/renderer/src/components/LauncherResumePicker'
import { launcherNativeRecap } from '../src/renderer/src/lib/launcher-resume'
import { conversationRulerRecords, rulerRecordQuote } from '../src/renderer/src/lib/conversation-ruler'
import { MobileMailbox } from '../../mobile/src/conversation/MobileMailbox'
import { createBrowserPlatform } from '../../mobile/src/platform/browser'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createClientUiRoot } from './helpers/client-ui-render'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import type { AppConfig } from '../src/shared/contracts'

const wire = JSON.stringify({ answers: { choice: { answers: ['Inspect the source'] }, followup: { answers: ['Preserve the original task.'] } } })
const answers = [
  { questionId: 'choice', answer: 'Inspect the source', prompt: 'Which path should we take?' },
  { questionId: 'followup', answer: 'Preserve the original task.', prompt: 'What should remain available?' }
]
const page: AgentSessionHistoryPage = { agentSessionId: 'question-reader', source: { providerId: 'codex', nativeSessionId: 'native-question-reader' }, nextCursor: null,
  items: [{ id: 'question-reply', kind: 'user-message', turnId: 'original-turn', questionAnswers: answers, contentParts: [{ kind: 'text', text: wire }] }] }
const diagnostic = { code: 'QUESTION_REPLY_ANNOTATION_OMITTED', message: 'The answer annotation did not fit this page; the original record remains available.' }
const readings = ['answers', 'diagnostic'] as const
type Reading = typeof readings[number]
function readingPage(reading: Reading): AgentSessionHistoryPage {
  const { questionAnswers: _answers, ...original } = page.items[0]!
  return reading === 'answers' ? page : { ...page, items: [{ ...original, questionDiagnostic: diagnostic }] }
}
const describeSpeaker = (speaker: { role: string; id: string }) => ({ name: speaker.role === 'agent' ? 'Execution Agent' : 'Original input', providerId: 'codex' as const })
const baseline = useAppStore.getState()
let container: HTMLDivElement, root: Root
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }],
  executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } },
  workspaces: [{ id: 'project', hostId: 'local', name: 'Project', path: fixturePath('question-consumer'), kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
  useAppStore.setState({ config, sessions: [], timelines: {}, recoveryCandidates: [], agentNames: {}, noticeReadReceipts: {}, scratchTopicSnapshots: {}, agentComposerDrafts: { original: 'Keep the original draft.' } })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.getElementById('agentmux-window-overlay-host')?.remove(); useAppStore.setState(baseline, true); vi.restoreAllMocks() })
async function click(node: HTMLElement | null) { expect(node).not.toBeNull(); await act(async () => node!.click()) }
const render = (view: Parameters<Root['render']>[0]) => act(async () => root.render(view))
async function waitFor(check: () => void) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
    try { check(); return } catch (error) { if (attempt === 99) throw error }
  }
}
function assertAnswerReading(owner: ParentNode, reading: Reading) {
  const message = owner.querySelector<HTMLElement>('.log-turn')!
  expect(message, 'The real shared message was mounted by this consumer').not.toBeNull()
  const body = message.querySelector<HTMLElement>('.log-turn__body')!
  expect(body).not.toBeNull()
  const defaultText = [...body.querySelectorAll<HTMLElement>('.log-turn__text')].filter(node => {
    const detail = node.closest('details')
    return !detail || !body.contains(detail)
  })
    .map(node => node.textContent).join('\n')
  if (reading === 'answers') {
    expect(defaultText).toContain(answers[0]!.answer)
    expect(defaultText).toContain(answers[1]!.answer)
    expect(defaultText).not.toContain('"answers"')
    expect(body.querySelector('[data-recorded-question-reply]')).not.toBeNull()
    expect([...body.querySelectorAll('details')].every(detail => !detail.open)).toBe(true)
    expect(body.querySelector('[data-question-reply-original] pre')?.textContent).toBe(wire)
    expect(message.querySelector('[data-question-reply-diagnostic]')).toBeNull()
  } else {
    expect(defaultText).toBe(wire)
    expect(body.querySelector('[data-recorded-question-reply]')).toBeNull()
    const notice = message.querySelector('[data-question-reply-diagnostic]')!
    expect(notice?.getAttribute('data-question-reply-diagnostic')).toBe(diagnostic.code)
    expect(notice?.textContent).toBe(diagnostic.message)
    expect(notice?.getAttribute('role')).toBe('status')
  }
  expect(message.getAttribute('data-speaker-role')).not.toBe('system')
  expect(message.querySelector('.log-turn__system-toggle')).toBeNull()
  expect(useAppStore.getState().agentComposerDrafts.original).toBe('Keep the original draft.')
  return message
}
async function assertWholeCopy(owner: ParentNode, copy: { mock: { calls: unknown[][] } }) {
  const original = owner.querySelector<HTMLDetailsElement>('[data-question-reply-original]')
  if (original) {
    await click(original.querySelector('summary')); expect(original.open).toBe(true)
    expect(original.querySelector('pre')?.textContent).toBe(wire)
    const associated = owner.querySelector<HTMLDetailsElement>('[data-question-id="choice"] details')!
    await click(associated.querySelector('summary')); expect(associated.open).toBe(true)
    expect(associated.querySelector('p')?.textContent).toBe(answers[0]!.prompt)
  }
  await click(owner.querySelector<HTMLButtonElement>('[title="Copy message"]'))
  expect(copy.mock.calls.at(-1)?.[0]).toBe(wire)
}

it.each(readings)('Activity direct native user supplement consumes typed answers while whole Copy keeps the original wire (%s)', async (reading) => {
  const page = readingPage(reading)
  const messages = projectSessionUserMessages({ agentSessionId: page.agentSessionId, historyPage: page })
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await render(<ActivityView sessionId={page.agentSessionId} items={[]} userMessages={messages} capability="complete-events" displayState="done" describeSpeaker={describeSpeaker} />)
  const message = assertAnswerReading(container, reading)
  await assertWholeCopy(message, copy)
  expect(messages[0]!.questionAnswers).toBe(reading === 'answers' ? answers : undefined)
  expect(messages[0]!.questionDiagnostic).toEqual(reading === 'diagnostic' ? diagnostic : undefined)
  expect(messages[0]!.source).toMatchObject({ kind: 'native', recordId: 'question-reply' })
})

it.each(readings)('Focus selected native record keeps its original answers, source and wire through the actual popup (%s)', async (reading) => {
  const page = readingPage(reading)
  const record = projectConversationRecords({ agentSessionId: page.agentSessionId, executionHostId: 'local', historyPage: page })[0]!
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  function Scene() {
    const ref = useRef<HTMLButtonElement>(null), [anchor, setAnchor] = useState<HTMLElement | null>(null)
    return <section className="recent-focus"><header className="recent-focus__header"><button ref={ref} onClick={() => setAnchor(ref.current)}>Read original reply</button></header>
      {anchor ? <FocusMessagePreview message={record} sender={undefined} recipient={undefined} recipientName="Execution Agent" lane={undefined} hierarchy={undefined} interactive anchor={anchor} describeSpeaker={describeSpeaker} onSelect={() => {}} onClose={() => setAnchor(null)} /> : null}</section>
  }
  await render(<Scene />); await click(container.querySelector('button'))
  const popup = document.querySelector('.recent-focus__message-preview')!
  const message = assertAnswerReading(popup, reading)
  await assertWholeCopy(message, copy)
  expect(popup.querySelector('[data-input-source]')?.getAttribute('data-input-source')).toBe('native')
  expect(record.original.kind).toBe('native')
})

it.each(readings)('Desktop Mailbox selects the original Outbox user detail and reads answers without changing whole Copy (%s)', async (reading) => {
  const page = readingPage(reading)
  const messages = projectSessionUserMessages({ agentSessionId: page.agentSessionId, historyPage: page })
  const copy = vi.fn(async () => true)
  const navigationNotice = 'The original conversation location is temporarily unavailable; keep reading and copying.'
  const reveal = vi.fn(async (_message: AgentSessionUserMessage) => ({ kind: 'unavailable' as const, message: navigationNotice }))
  await render(<SessionMailbox system={{ available: true, notices: [], unread: [], acknowledge: vi.fn() }} queued={[]}
    timeline={{ agentSessionId: page.agentSessionId, revision: 0, items: [] }} userMessages={messages} onCopyQueued={copy} onRevealMessage={reveal} />)
  const panel = container.querySelector<HTMLElement>('.composer-mailbox')!
  const toggle = new Event('toggle'); Object.defineProperty(toggle, 'newState', { value: 'open' })
  await act(async () => panel.dispatchEvent(toggle))
  await click(panel.querySelector('[role="tab"][id$="-outbox-tab"]'))
  const row = panel.querySelector<HTMLElement>('.composer-mailbox__history button[data-record-key]')!
  expect(row).not.toBeNull(); await click(row)
  const detail = panel.querySelector('.composer-mailbox__detail')!
  expect(detail.querySelector('.log-turn__actions .composer-mailbox__reveal')).toBeNull()
  await click(detail.querySelector('.composer-mailbox__record-actions .composer-mailbox__reveal'))
  expect(reveal).toHaveBeenCalledExactlyOnceWith(messages[0])
  expect(reveal.mock.calls[0]![0]).toBe(messages[0])
  expect(reveal.mock.calls[0]![0].source).toBe(messages[0]!.source)
  expect(reveal.mock.calls[0]![0].contentParts).toBe(messages[0]!.contentParts)
  expect(detail.querySelector('.composer-mailbox__navigation-feedback')?.textContent).toBe(navigationNotice)
  const message = assertAnswerReading(detail, reading)
  await assertWholeCopy(message, copy)
  expect(message.getAttribute('data-recorded-identity')).toBe('true')
  expect(message.getAttribute('data-message-source-key')).toContain('native-question-reader')
})

it.each(readings)('Mobile Mailbox opens and reads the original native history detail through its actual InputHistoryList (%s)', async (reading) => {
  const page = readingPage(reading)
  const messages = projectSessionUserMessages({ agentSessionId: page.agentSessionId, historyPage: page })
  const copy = vi.fn(async () => true)
  const platform = { ...createBrowserPlatform(), copyText: copy }
  const session: AgentMuxAgentSession = { kind: 'agent', agentSessionId: page.agentSessionId, providerId: 'codex', executorId: 'codex', hostId: 'local',
    workspacePath: fixturePath('question-consumer'), run: { runId: 'original-run' }, retiredRuns: [], createdAt: _newTailFixtureEpoch(0, 0, 1), updatedAt: _newTailFixtureEpoch(0, 0, 1) }
  const readHistory = vi.fn(async (input: { source?: string }): Promise<AgentSessionHistoryReadPage> => ({
    hostId: 'local', agentSessionId: page.agentSessionId, source: input.source === 'captured' ? 'captured' : 'native', nextCursor: null,
    revision: '0'.repeat(64), availability: input.source === 'captured' ? 'empty' : 'available', order: 'newest-first', items: [], budgetBytes: wire.length,
    userMessages: input.source === 'captured' ? [] : messages, scan: { complete: true, examined: input.source === 'captured' ? 0 : 1 }
  }))
  const fill = vi.fn(async () => {}), historyCopy = vi.fn(async () => true)
  await render(<ClientUiProvider platform={platform}><MobileMailbox session={session} connected messages={messages} platform={platform} describeSpeaker={describeSpeaker}
    refresh={() => {}} historyScope="original-question-reader" readHistory={readHistory} onHistoryFill={fill} onHistoryCopy={historyCopy} /></ClientUiProvider>)
  await click(container.querySelector('button'))
  await waitFor(() => expect(document.querySelector('.input-history__records details')).not.toBeNull())
  const detail = document.querySelector<HTMLDetailsElement>('.input-history__records details')!
  await act(async () => { detail.open = true; detail.dispatchEvent(new Event('toggle')) })
  await waitFor(() => expect(detail.querySelector('.log-turn')).not.toBeNull())
  const message = assertAnswerReading(detail, reading)
  await assertWholeCopy(message, copy)
  expect(fill).not.toHaveBeenCalled(); expect(historyCopy).not.toHaveBeenCalled()
})

it.each(readings)('Resume picker selects the original native conversation and passes typed answers to its real detail (%s)', async (reading) => {
  const page = readingPage(reading)
  const native = { source: { nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: page.source.nativeSessionId, transcriptPath: fixturePath('question-consumer/history.jsonl') },
    workspacePath: config.workspaces[0]!.path, revision: 'original-file-lifetime' }, title: 'Original question reply', createdAt: _newTailFixtureEpoch(0, 0, 1), updatedAt: _newTailFixtureEpoch(0, 0, 1) }
  vi.spyOn(api.sessions, 'nativeSessions').mockResolvedValue({ hostId: 'local', executorId: 'codex', providerId: 'codex', availability: 'available', sessions: [native], issues: [],
    capabilities: { providerResume: true } as never })
  const read = vi.spyOn(api.sessions, 'nativeHistoryPage').mockResolvedValue({ ...page, hostId: 'local', executorId: 'codex', nativeSource: native.source })
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await render(<LauncherResumePicker workspace={config.workspaces[0]} />)
  await click(container.querySelector('button'))
  await waitFor(() => expect(document.querySelector('.launcher-resume__message .log-turn')).not.toBeNull())
  const detail = document.querySelector('.launcher-resume__message')!
  const message = assertAnswerReading(detail, reading)
  await assertWholeCopy(message, copy)
  expect(read).toHaveBeenCalled()
  expect(read.mock.calls[0]![0]).toMatchObject({ hostId: 'local', source: native.source })
})

it('native recap and ruler excerpt read typed answers, while the raw record remains unchanged and quote stays bounded', () => {
  const recap = launcherNativeRecap(page)!
  expect(recap.text).toBe('Inspect the source Preserve the original task.')
  expect(recap.text).not.toContain('"answers"')
  const record = conversationRulerRecords(page.agentSessionId, page, [])[0]!
  expect(rulerRecordQuote(record)).toBe('Inspect the source\n\nPreserve the original task.')
  const long = { ...record, record: { ...page.items[0]!, questionAnswers: [{ questionId: 'long', answer: 'A'.repeat(1000), prompt: 'Keep the original question.' }] } }
  expect(rulerRecordQuote(long)).toBe('A'.repeat(280))
  expect(page.items[0]!.contentParts).toEqual([{ kind: 'text', text: wire }])
})
