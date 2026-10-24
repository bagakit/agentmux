// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { consumeConversationWindowPage } from '@agentmux/core/conversation'
import { projectConversationWindow } from '@agentmux/client-ui/conversation-records'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { NativeProcessObservation } from '@agentmux/client-ui/components/NativeProcessObservation'
import { conversationMessageSourceKey } from '@agentmux/client-ui/conversation-message-location'
import { recordedToolEdit } from '../../../packages/core/test/fixtures/recorded-tool-edits'
import { conversationPagePortFixture } from './helpers/conversation-page-port-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'
import { activityReadingProps } from './helpers/activity-reading-props'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { api } from '../src/renderer/src/lib/api'

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { window.getSelection()?.removeAllRanges(); for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  const reference = { hostId: 'local', agentSessionId: 'original-process-session' }, source = { providerId: 'claude', nativeSessionId: 'original-native' }
  const item = recordedToolEdit(reference.agentSessionId)
  const f = await conversationPagePortFixture(reference, source, async () => ({ agentSessionId: reference.agentSessionId, source, nextCursor: null, items: [] }))
  closes.push(f.close)
  await f.store.applyTimelineMutation({ type: 'upsert', agentSessionId: reference.agentSessionId, item })
  const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  const copied = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const packet = await api.conversation.readAgentConversation({ ...reference, limit: 100 })
  const accepted = consumeConversationWindowPage(packet)
  expect(accepted.kind).toBe('complete')
  if (accepted.kind !== 'complete') throw new Error('Missing complete public window')
  const projection = projectConversationWindow(accepted.snapshot)
  expect(projection.records).toHaveLength(1)
  const locatedMessageKey = conversationMessageSourceKey(reference.agentSessionId, { kind: 'captured', recordId: item.id })
  if (!locatedMessageKey) throw new Error('Missing original captured location key')
  const draw = async (desktop: boolean, located = false) => act(async () => root.render(desktop
    ? <ActivityView {...activityReadingProps({ control: reference })} />
    : <ConversationView {...(projection.historyPage ? { page: projection.historyPage } : {})} records={projection.records} originalRecords={projection.originalRecords}
        coverage={projection.timeline.coverage} sessionId={reference.agentSessionId} renderProcess={props => <NativeProcessObservation {...props} compact />}
        {...(located ? { locatedMessageKey } : {})} />))
  const openGroup = async () => {
    await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }); expect(host.querySelector('.wf-head'), host.textContent ?? '').not.toBeNull() })
    await act(async () => host.querySelector<HTMLButtonElement>('.wf-head')!.click())
  }
  return { ...f, host, root, item, draw, openGroup, copied }
}

it.each([true, false])('reads the same original process through %s Desktop/shared renderer, with bounded diff and complete Copy', async desktop => {
  const f = await fixture(); await f.draw(desktop); await f.openGroup()
  const row = f.host.querySelector<HTMLButtonElement>('[data-observation-step-id]')!
  expect(row.textContent).toContain(desktop ? f.item.toolName : 'src/answer.ts')
  expect(row.querySelector('[data-semantic-icon="conversation.tool-call"]')).not.toBeNull()
  expect(f.host.querySelector('.log-diff')).toBeNull()
  await act(async () => row.click())
  expect(row.getAttribute('aria-expanded')).toBe('true')
  const body = document.getElementById(row.getAttribute('aria-controls')!)!
  expect(body).not.toBeNull(); expect(body.hidden).toBe(false)
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }); expect(body.querySelector('.log-diff__line--removed')?.textContent).toBe('-original answer') })
  expect(body.querySelector('.log-diff__line--added')?.textContent).toBe('+revised answer')
  expect(body.textContent).toContain('Original recorded output')
  expect(body.querySelector('[aria-label="Copy tool input"]')).toBeNull()
  await act(async () => { const details = body.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle')) })
  await act(async () => body.querySelector<HTMLButtonElement>('[aria-label="Copy tool input"]')!.click())
  expect(f.copied).toHaveBeenCalledExactlyOnceWith(f.item.toolInput)
  const original = [...body.querySelectorAll('pre')].find(node => node.textContent === f.item.toolInput)!
  await act(async () => row.click()); expect(body.hidden).toBe(true); expect(original.isConnected).toBe(true)
  await act(async () => row.click()); expect([...body.querySelectorAll('pre')]).toContain(original)
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it('locates the original captured step and opens both group and complete detail', async () => {
  const f = await fixture(); await f.draw(false, true)
  expect(f.host.querySelector('.wf-head')?.getAttribute('aria-expanded')).toBe('true')
  const row = f.host.querySelector<HTMLButtonElement>('[data-observation-step-id]')!
  expect(row.getAttribute('aria-expanded')).toBe('true')
  expect(document.getElementById(row.getAttribute('aria-controls')!)?.hidden).toBe(false)
  expect(f.host.querySelector('.log-diff__line--added')?.textContent).toContain('revised answer')
})
