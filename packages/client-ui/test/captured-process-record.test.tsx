// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConversationToolDiff } from '../src/components/ConversationToolDiff'
import { createRoot } from 'react-dom/client'
import { CapturedProcessRecord } from '../src/components/CapturedProcessRecord'
import { ConversationView } from '../src/components/ConversationView'
import { NativeProcessObservation } from '../src/components/NativeProcessObservation'
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
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Copy tool input"]')!.click())
  expect(copy.mock.calls).toHaveLength(1)
  expect(copy.mock.calls[0]?.[0] === item.toolInput).toBe(true)
  copy.mockRestore()
})
