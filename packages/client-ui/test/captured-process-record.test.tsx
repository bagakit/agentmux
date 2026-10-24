// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConversationToolDiff } from '../src/components/ConversationToolDiff'
import { createRoot } from 'react-dom/client'
import { CapturedProcessRecord } from '../src/components/CapturedProcessRecord'
import { RecordedStepsCard, RecordedToolRow } from '../src/components/WorkflowObservation'
import { normalizeAgentTimelineItem } from '@agentmux/core'
import { ConversationView } from '../src/components/ConversationView'
import { NativeProcessObservation } from '../src/components/NativeProcessObservation'
import { ConversationToolTrace } from '../src/components/ConversationToolTrace'
import * as summaries from '../src/lib/activity-step-summary'
import { projectConversationReading } from '../src/lib/conversation-records'
import { recordedToolEdit } from '../../core/test/fixtures/recorded-tool-edits'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform'
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body, bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0)) await close(); vi.unstubAllGlobals() })
function surface() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  return { host, render: async (node: ReactNode) => act(async () => root.render(<ClientUiProvider platform={platform}>{node}</ClientUiProvider>)) }
}
it.each(['captured', 'native', 'trace'] as const)('reuses the %s step title through local disclosure changes and refreshes changed input', async kind => {
  const { host, render } = surface()
  const title = vi.spyOn(summaries, 'stepTitle')
  const show = async (file: string) => {
    const input = JSON.stringify({ file_path: file, new_string: 'Original content. '.repeat(1000), old_string: '' })
    if (kind === 'trace') return render(<ConversationToolTrace part={{ kind: 'tool-call', name: 'Edit', input }} />)
    if (kind === 'captured') {
      const item = { ...recordedToolEdit('original-session'), toolInput: input }
      const projection = projectConversationReading({ agentSessionId: item.agentSessionId, timeline: { agentSessionId: item.agentSessionId, revision: 1, items: [item] } })
      return render(<CapturedProcessRecord record={projection.records[0]!} />)
    }
    const page = { agentSessionId: 'original-session', source: { providerId: 'recorded-provider', nativeSessionId: 'original-native' }, nextCursor: null,
      items: [{ id: 'call', kind: 'activity' as const, contentParts: [{ kind: 'tool-call' as const, name: 'Edit', input }] }] }
    const projection = projectConversationReading({ agentSessionId: page.agentSessionId, historyPage: page })
    return render(<ConversationView page={page} sessionId={page.agentSessionId} records={projection.records} originalRecords={projection.originalRecords}
      renderProcess={props => <NativeProcessObservation {...props} />} />)
  }
  try {
    await show('src/original.ts')
    const row = host.querySelector<HTMLButtonElement>(kind === 'trace' ? '.conversation-tool-trace__row' : '.wf-native-process button[data-expandable]')!
    await act(async () => row.click())
    const afterFirstDisclosure = title.mock.calls.length
    expect(afterFirstDisclosure).toBeGreaterThan(0)
    await act(async () => row.click())
    await act(async () => row.click())
    expect(title).toHaveBeenCalledTimes(afterFirstDisclosure)
    await show('src/changed.ts')
    expect(title.mock.calls.length).toBeGreaterThan(afterFirstDisclosure)
    expect(host.textContent).toContain('src/changed.ts')
  } finally { title.mockRestore() }
})

it('classifies captured tool structure independently of its name and preserves unknown original parameters', async () => {
  const { host, render } = surface()
  for (const toolName of ['Bash', 'Read', 'Edit', 'custom']) {
    const { conversation: _source, ...original } = recordedToolEdit('original-session')
    const item = { ...original, toolName }
    const record = projectConversationReading({ agentSessionId: item.agentSessionId, timeline: { agentSessionId: item.agentSessionId, revision: 1, items: [item] } }).records[0]!
    await render(<CapturedProcessRecord record={record} located />)
    expect(host.querySelector('.log-row__node [data-semantic-icon]')?.getAttribute('data-semantic-icon')).toBe('conversation.tool-call')
    expect(host.querySelector('.log-diff')).toBeNull()
    expect(host.textContent).toContain(item.toolInput)
  }
})
it('uses native call and result kinds even when names resemble other tools', async () => {
  const { host, render } = surface(), source = { providerId: 'recorded-provider', nativeSessionId: 'original-native' }
  const page = { agentSessionId: 'original-session', source, nextCursor: null, items: [
    { id: 'call', kind: 'activity' as const, contentParts: [{ kind: 'tool-call' as const, name: 'read_file', input: '{}' }] },
    { id: 'result', kind: 'activity' as const, contentParts: [{ kind: 'tool-result' as const, name: 'bash', output: 'Original output' }] }
  ] }
  const projection = projectConversationReading({ agentSessionId: page.agentSessionId, historyPage: page })
  await render(<ConversationView page={page} sessionId={page.agentSessionId} records={projection.records} originalRecords={projection.originalRecords} renderProcess={props => <NativeProcessObservation {...props} />} />)
  expect([...host.querySelectorAll('.log-row__node [data-semantic-icon]')].map(node => node.getAttribute('data-semantic-icon'))).toEqual(['conversation.tool-call', 'conversation.tool-result'])
})

it('shows truncation only for a bounded diff and keeps visible add/remove markers', () => {
  for (const truncated of [true, false]) {
    const html = renderToStaticMarkup(<ConversationToolDiff diff={{ lines: [{ kind: 'removed', text: 'old' }, { kind: 'added', text: 'new' }], truncated }} />)
    expect(html).toContain('>-<'); expect(html).toContain('>+<')
    expect(html.includes('Diff truncated at 200 lines.')).toBe(truncated)
  }
})

it('opens a large original edit with a bounded preview and complete original Copy', async () => {
  const { host, render } = surface(), original = recordedToolEdit('original-session')
  const copy = vi.spyOn(platform, 'copyText').mockResolvedValue(true)
  const item = { ...original, toolInput: JSON.stringify({ file_path: 'src/answer.ts', old_string: '', new_string: 'x\n'.repeat(180000) }) }
  const record = projectConversationReading({ agentSessionId: item.agentSessionId, timeline: { agentSessionId: item.agentSessionId, revision: 1, items: [item] } }).records[0]!
  await render(<CapturedProcessRecord record={record} located />)
  expect(host.querySelectorAll('.log-diff__line')).toHaveLength(200)
  expect(host.querySelector('.log-diff__truncated')?.textContent).toBe('Diff truncated at 200 lines.')
  expect(host.querySelector('[aria-label="Copy tool input"]')).toBeNull()
  await act(async () => { const details = host.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle')) })
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Copy tool input"]')!.click())
  expect(copy.mock.calls).toHaveLength(1)
  expect(copy.mock.calls[0]?.[0] === item.toolInput).toBe(true)
  copy.mockRestore()
})


it('preserves Core saved-input recorded status in the User route and neutral observation consumers', async () => {
  const { host, render } = surface()
  const item = normalizeAgentTimelineItem({ id: 'prompt:original-saved', agentSessionId: 'original-session', kind: 'user_message',
    source: 'user', status: 'recorded', title: 'Original saved input', content: 'Original human body 中文🙂', createdAt: 1, updatedAt: 1,
    authorHuman: true, publicContent: 'confirmed',
    inputRef: { kind: 'prompt', agentSessionId: 'original-session', expectedRun: { runId: 'original-run' }, submissionId: 'original-saved' },
    inputOrigin: { queueId: 'original-journal', incarnation: 'original-incarnation', sequence: 1 },
    inputSubmission: { status: 'waiting', observation: 'rejoin-needed' } })
  const timeline = { agentSessionId: item.agentSessionId, sourceHostId: 'local', revision: 1, items: [item] }
  const projection = projectConversationReading({ agentSessionId: item.agentSessionId, executionHostId: 'local', timeline })
  expect(projection.records).toHaveLength(1)
  expect(projection.records[0]).toMatchObject({ role: 'message', original: { item: { status: 'recorded' } } })
  await render(<ConversationView timeline={timeline} sessionId={item.agentSessionId} executionHostId="local"
    records={projection.records} originalRecords={projection.originalRecords} expandSubmissions />)
  expect(host.querySelector('[data-speaker-role="human"]')?.textContent).toContain(item.content)
  expect(host.querySelector('.conversation-submission-summary')?.getAttribute('data-status')).toBe('recorded')
  expect(host.querySelector('.conversation-submission-summary')?.textContent).toContain('已保存 · 等待 Agent')
  expect(host.querySelector('[data-captured-process-id]')).toBeNull()
  await render(<RecordedStepsCard observation={{ id: item.id, stepCount: 1, status: item.status }} expanded onExpandedChange={() => {}}>
    <RecordedToolRow className="log-row" icon={null} observation={{ id: item.id, title: item.title, status: item.status, source: 'Original captured input', persistentSource: true }} />
  </RecordedStepsCard>)
  const card = host.querySelector('[data-observation-id]')!, row = host.querySelector('[data-observation-step-id]')!
  expect(card.getAttribute('data-status')).toBe('recorded'); expect(row.getAttribute('data-status')).toBe('recorded')
  expect(card.querySelector('.wf-head .wf-observation__recorded')?.textContent).toBe('Recorded')
  expect(row.querySelector('.wf-observation__recorded')?.textContent).toBe('Recorded')
  expect(host.textContent).not.toContain('Status not recorded')
  expect(host.textContent).not.toContain('Streaming'); expect(host.textContent).not.toContain('Recorded running')
  expect(host.querySelector('[data-semantic-icon="status.completed"]')).toBeNull()
})
