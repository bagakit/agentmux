// @vitest-environment happy-dom
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui/platform'
import { projectConversationReading } from '@agentmux/client-ui/conversation-records'
import type { ConversationRecord } from '@agentmux/client-ui/conversation-records'
import { ConversationProcessDockSlot, ConversationProcessObservation, ConversationProcessSurface } from '../src/renderer/src/components/ConversationProcessSurface'

const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null,
  renderProjectLabel: () => null, renderIcon: () => null }
const locate = vi.fn(async () => ({ kind: 'located' as const }))
let host: HTMLDivElement, root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  locate.mockClear()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })

function records(captured = false): ConversationRecord[] {
  const projection = projectConversationReading({ agentSessionId: 'original-session', executionHostId: 'route-host',
    historyPage: { agentSessionId: 'original-session', sourceHostId: 'source-host',
      source: { providerId: 'original-provider', nativeSessionId: 'original-native' }, nextCursor: null,
      items: [{ id: 'original-call', kind: 'activity', turnId: 'original-turn', contentParts: [{ kind: 'text', text: 'Original process payload' }] }] },
    ...(captured ? { timeline: { agentSessionId: 'original-session', sourceHostId: 'source-host', revision: 1,
      items: [{ id: 'captured-call', agentSessionId: 'original-session', kind: 'tool_call', source: 'native-hook',
        eventName: 'PreToolUse', title: 'Original hook', status: 'recorded', createdAt: 1, updatedAt: 1 }] } } : {}) })
  return projection.records
}

function Surface({ name, scope = 'original-source', rows }: { name: string; scope?: string; rows: readonly ConversationRecord[] }) {
  const [selected, select] = useState<string | null>(null)
  const [expanded, expand] = useState(false)
  return <ConversationProcessSurface><section data-reader={name}>
    <ConversationProcessObservation scope={scope} selected={selected} onSelect={select} active onLocate={locate}
      process={{ id: 'stable-original-group', records: rows, entries: rows.map(record => ({ kind: 'record', record })),
        renderRecord: record => <p data-original-body={record.id}>{record.content}</p>,
        disclosure: { expanded, onExpandedChange: expand, steps: new Map(), onStepExpandedChange: () => {} } }} />
    <div data-input-for={name}><ConversationProcessDockSlot /><input aria-label={`${name} unsent draft`} defaultValue="保留未发送草稿" /></div>
  </section></ConversationProcessSurface>
}
async function show(node: ReactNode) { await act(async () => root.render(<ClientUiProvider platform={platform}>{node}</ClientUiProvider>)) }
async function click(surface: Element, selector: string) {
  const button = surface.querySelector<HTMLButtonElement>(selector)
  expect(button).not.toBeNull()
  await act(async () => button!.click())
}

it('keeps the selected original group through appended source facts, then respects explicit unpin', async () => {
  await show(<Surface name="primary" rows={records()} />)
  const surface = host.querySelector('[data-reader="primary"]')!
  const draft = surface.querySelector('input')!
  draft.value = '继续保留这个草稿'
  await click(surface, '[aria-label="固定过程摘要到输入框上方"]')
  expect(surface.querySelector('[data-input-for] .wf-observed-dock')?.textContent).toContain('1 条已加载记录')
  await show(<Surface name="primary" rows={records(true)} />)
  expect(surface.querySelector('.wf-observed-dock')?.textContent).toContain('2 条已加载记录')
  expect(surface.querySelector('.wf-observed-dock')?.textContent).toContain('原生与已捕获记录')
  expect(surface.querySelector('input')).toBe(draft)
  expect(draft.value).toBe('继续保留这个草稿')
  await click(surface, '.wf-observed-dock [aria-label="取消固定过程摘要"]')
  await show(<Surface name="primary" rows={records()} />)
  expect(surface.querySelector('.wf-observed-dock')).toBeNull()
})

it('places the same Session group independently in each presentation and drops it on a source change', async () => {
  const render = (scope = 'original-source') => show(<><Surface name="primary" scope={scope} rows={records()} /><Surface name="focus" rows={records()} /></>)
  await render()
  const primary = host.querySelector('[data-reader="primary"]')!, focus = host.querySelector('[data-reader="focus"]')!
  await click(primary, '[aria-label="固定过程摘要到输入框上方"]')
  expect(primary.querySelectorAll('.wf-observed-dock')).toHaveLength(1)
  expect(focus.querySelector('.wf-observed-dock')).toBeNull()
  await click(focus, '[aria-label="固定过程摘要到输入框上方"]')
  expect(focus.querySelectorAll('.wf-observed-dock')).toHaveLength(1)
  await render('another-original-source')
  expect(primary.querySelector('.wf-observed-dock')).toBeNull()
  expect(focus.querySelectorAll('.wf-observed-dock')).toHaveLength(1)
})

it('uses the original record navigation and original disclosure without copying a body into the dock', async () => {
  const rows = records()
  await show(<Surface name="primary" rows={rows} />)
  await click(host, '[aria-label="固定过程摘要到输入框上方"]')
  expect(host.querySelector('.wf-observed-dock')?.textContent).not.toContain('Original process payload')
  await click(host, '.wf-observed-dock .small-button')
  expect(locate).toHaveBeenCalledExactlyOnceWith({ hostId: 'source-host', agentSessionId: 'original-session', source: rows[0]!.source })
  expect(host.querySelector('.wf-head')?.getAttribute('aria-expanded')).toBe('true')
  expect(host.querySelectorAll('[data-original-body]')).toHaveLength(1)
})
