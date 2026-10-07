import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { msUntilSemanticStatusStale } from '@agentmux/core/agent-status'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { useHostedConversation } from '../src/conversation/use-hosted-conversation'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { fixture, mount, mounted, paste, editor, button } from './conversation-fixture'
import { activityStatus } from './activity-status-fixture'

beforeEach(async () => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
})
afterEach(async () => {
  for (const v of mounted.splice(0)) { await act(async () => v.root.unmount()); v.element.remove() }
  vi.useRealTimers(); vi.restoreAllMocks()
})
function prepared() {
  const f = fixture(), original = f.client.agentSession('session-original')
  original.semanticStatus = { state: 'working', source: 'native-hook', observedAt: Date.now() }
  const status = vi.fn(async () => activityStatus(original)); f.client.statusAgent = status
  return { ...f, original, status }
}
function props(f: ReturnType<typeof prepared>) { return { client: f.client, agentSessionId: f.original.agentSessionId, connection: { state: 'connected' as const, message: 'Original Host' }, platform: createBrowserPlatform() } }
it('shows current activity only from exact public Core status, then preserves the original editable draft and last observation through disconnect and read failure', async () => {
  const f = prepared(), p = props(f), view = await mount(<MobileConversationSurface {...p} />)
  const state = view.element.querySelector('.mobile-active-state')!
  expect(state, 'real activity slot').not.toBeNull(); expect(state.textContent).toBe('正在执行')
  expect(state.getAttribute('data-activity-current')).toBe('true')
  expect(f.status).toHaveBeenCalledWith(f.original.agentSessionId)
  await paste(view.element, 'Keep original phone draft')
  const input = editor(view.element), send = button(view.element, 'Send')
  expect(send.disabled).toBe(false)
  await view.render(<MobileConversationSurface {...p} connection={{ state: 'disconnected', message: 'Original connection is unavailable' }} />)
  expect(view.element.querySelector('.mobile-active-state')).toBe(state)
  expect(state.textContent).toBe('最近观察：执行中'); expect(state.getAttribute('data-activity-current')).toBe('false')
  expect(editor(view.element)).toBe(input); expect(input.textContent).toContain('Keep original phone draft')
  f.status.mockRejectedValue(new Error('Observation only failed'))
  await view.render(<MobileConversationSurface {...p} />)
  expect(state.textContent).toBe('最近观察：执行中'); expect(send.disabled).toBe(false)
  expect(f.client.agentSession(f.original.agentSessionId)).toBe(f.original)
  expect(f.original.semanticStatus?.state).toBe('working')
  expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
})
it.each(['wrong-session', 'wrong-host', 'wrong-run', 'ended', 'missing-status', 'stale'] as const)('does not promote retained working to current from %s observations', async mode => {
  const f = prepared()
  if (mode === 'missing-status') Object.assign(f.client, { statusAgent: undefined })
  else if (mode === 'ended') f.status.mockImplementation(async () => activityStatus(f.original, 'exited'))
  else if (mode === 'stale') {
    f.original.semanticStatus!.observedAt -= msUntilSemanticStatusStale(f.original.semanticStatus!, Date.now()) + 1
  } else f.status.mockImplementation(async () => activityStatus({ ...f.original,
    ...(mode === 'wrong-session' ? { agentSessionId: 'another-session' } : {}), ...(mode === 'wrong-host' ? { hostId: 'another-host' } : {}),
    ...(mode === 'wrong-run' ? { run: { runId: 'another-run' } } : {}) }))
  const view = await mount(<MobileConversationSurface {...props(f)} />)
  expect(view.element.querySelector('.mobile-active-state')?.textContent).toBe('最近观察：执行中')
  expect(view.element.querySelector('.mobile-active-state')?.getAttribute('data-activity-current')).toBe('false')
  await paste(view.element, 'Original draft remains input-capable')
  expect(button(view.element, 'Send').disabled).toBe(false)
  expect(f.submit).not.toHaveBeenCalled()
})
it('expires exactly the original active evidence without polling or changing Core facts and refreshes only for its original Session event', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const f = prepared()
  function Reader() { const read = useHostedConversation(f.client, f.original.agentSessionId, true); return <output data-current={read.activity?.semantic ?? 'unknown'}>{read.page?.items.length}</output> }
  const view = await mount(<Reader />)
  expect(view.element.querySelector('output')?.getAttribute('data-current')).toBe('active')
  const count = f.status.mock.calls.length
  await act(async () => { vi.advanceTimersByTime(msUntilSemanticStatusStale(f.original.semanticStatus!, Date.now())) })
  expect(view.element.querySelector('output')?.getAttribute('data-current')).toBe('unknown')
  expect(f.status).toHaveBeenCalledTimes(count)
  expect(f.original.semanticStatus?.state).toBe('working')
  await act(async () => f.emit({ type: 'agent-status', agentSessionId: 'other', state: 'working', evidence: { source: 'native-hook', observedAt: Date.now() } }))
  expect(f.status).toHaveBeenCalledTimes(count)
  f.original.semanticStatus = { ...f.original.semanticStatus!, observedAt: Date.now() }
  await act(async () => f.emit({ type: 'agent-status', agentSessionId: f.original.agentSessionId, state: 'working', evidence: { source: 'native-hook', observedAt: Date.now() } }))
  expect(f.status).toHaveBeenCalledTimes(count + 1)
  expect(view.element.querySelector('output')?.getAttribute('data-current')).toBe('active')
  expect(f.submit).not.toHaveBeenCalled()
})
it('a late status reply from the old Run cannot relight the current Session', async () => {
  const f = prepared(), old = activityStatus(f.original)
  let settle!: (value: ReturnType<typeof activityStatus>) => void
  f.status.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
  function Reader() { const read = useHostedConversation(f.client, f.original.agentSessionId, true); return <output data-current={read.activity?.semantic ?? 'unknown'} /> }
  const view = await mount(<Reader />)
  f.sessions.set(f.original.agentSessionId, { ...f.original, run: { runId: 'new-original-run' } })
  await act(async () => settle(old))
  expect(view.element.querySelector('output')?.getAttribute('data-current')).toBe('unknown')
  expect(f.submit).not.toHaveBeenCalled()
})
it('keeps the original reader and editable draft when its Session getter becomes unavailable during a process event', async () => {
  const f = prepared(), view = await mount(<MobileConversationSurface {...props(f)} />)
  expect(view.element.querySelector('.mobile-active-state')?.textContent).toBe('正在执行')
  await paste(view.element, 'Keep this original draft')
  const input = editor(view.element), send = button(view.element, 'Send')
  vi.spyOn(f.client, 'agentSession').mockImplementation(() => { throw new Error('Original metadata observation unavailable') })
  await act(async () => {
    expect(() => f.emit({ type: 'process-state', agentSessionId: f.original.agentSessionId, run: f.original.run,
      state: 'exited', pid: null, evidence: { source: 'run-process', observedAt: Date.now() } })).not.toThrow()
  })
  expect(view.element.querySelector('.mobile-active-state')?.textContent).toBe('最近观察：执行中')
  expect(editor(view.element)).toBe(input); expect(input.textContent).toContain('Keep this original draft')
  expect(send.disabled).toBe(false); expect(f.submit).not.toHaveBeenCalled()
})
it('uses Core aggregate activity and its exact evidence time without rewriting the retained completion', async () => {
  const f = prepared(), at = Date.now()
  f.original.semanticStatus = { state: 'done', source: 'native-hook', observedAt: at - 2000, aggregateActivityAt: at }
  const p = props(f), view = await mount(<MobileConversationSurface {...p} />)
  const state = view.element.querySelector('.mobile-active-state')!
  expect(state.textContent).toBe('正在执行')
  expect(state.getAttribute('title')).toBe(`最后观察：${new Date(at).toLocaleString()}`)
  await view.render(<MobileConversationSurface {...p} connection={{ state: 'disconnected', message: 'Original connection unavailable' }} />)
  expect(state.textContent).toBe('最近观察：执行中')
  expect(state.getAttribute('title')).toBe(`最后观察：${new Date(at).toLocaleString()}`)
  expect(f.original.semanticStatus.state).toBe('done')
  expect(f.submit).not.toHaveBeenCalled()
})
