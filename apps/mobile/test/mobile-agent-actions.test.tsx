import './mobile-lan-crypto.setup'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileAgentActions } from '../src/conversation/MobileAgentActions'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { DeviceWorkfaceStore, emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, fixture, mount, mounted, session } from './conversation-fixture'

const connected = { state: 'connected' as const, message: '已连接' }
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }; document.body.replaceChildren(); vi.restoreAllMocks() })
function setup() {
  const f = fixture(), restored = { ...session(), run: { runId: 'restored-original-run' } }
  f.client.forwardRpc = vi.fn().mockImplementation(async method => {
    if (method === 'agent.inspect') return { session: session(), unavailable: [] }
    if (method === 'space.ls') return { catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] } }
    throw new Error('original owner unavailable')
  })
  f.client.ensureAgentContinuity = vi.fn().mockResolvedValue({ kind: 'resumed', session: restored, previousRun: session().run, run: restored.run })
  const copy = vi.fn().mockResolvedValue(true)
  return { ...f, copy, node: <MobileAgentActions client={f.client} agentSessionId="session-original" connected copyText={copy} /> }
}
describe('mobile persistent Agent identity and explicit continuity actions', () => {
  it('exposes actions in the real non-Mote shell and copies the SID address rather than a Run or display occurrence', async () => {
    const f = setup()
    await getDeviceWorkface().updateNavigation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' })
    const platform = { ...createBrowserPlatform(), copyText: f.copy }
    const view = await mount(<MobileApp client={f.client} connection={connected} platform={platform} />)
    await click(button(view.element, '当前对话操作'))
    await click(button(document.body, '复制 Agent 身份链接'))
    expect(f.copy.mock.calls[0]![0]).toBe('amux://agent/session-original')
    expect(f.client.ensureAgentContinuity).not.toHaveBeenCalled()
  })
  it('preserves the complete selectable link when the browser cannot copy', async () => {
    const f = setup(); f.copy.mockResolvedValue(false)
    const view = await mount(f.node); await click(button(view.element, '复制 Agent 身份链接'))
    expect(view.element.querySelector<HTMLInputElement>('[aria-label="Agent 身份链接"]')?.value).toBe('amux://agent/session-original')
    expect(f.client.ensureAgentContinuity).not.toHaveBeenCalled()
  })
  it('point-reads the exact durable Session and persists its immutable no-input request before recovery despite absent SDK inventory', async () => {
    const f = setup(); f.client.agentSessions = () => []; f.client.agentSession = () => { throw new Error('not hydrated') }
    const ensure = vi.mocked(f.client.ensureAgentContinuity)
    ensure.mockImplementationOnce(async input => {
      expect(getDeviceWorkface().snapshot().record.agentResumes?.[0]).toMatchObject({ phase: 'sending', hostId: 'host-original', input })
      expect(Object.keys(input).sort()).toEqual(['agentSessionId', 'expectedRun', 'operationId', 'trigger'])
      return { kind: 'reattachable', session: session(), previousRun: session().run, run: {} } as never
    })
    const view = await mount(f.node)
    expect(ensure).not.toHaveBeenCalled()
    await click(button(view.element, '恢复原 Agent'))
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(ensure.mock.calls[0]![0]).toMatchObject({ agentSessionId: 'session-original', expectedRun: { runId: 'run-original' }, trigger: 'manual' })
    expect(getDeviceWorkface().snapshot().record.agentResumes?.[0]?.phase).toBe('confirmed')
  })
  it('retains an unknown operation across page reload and only explicitly inspects or continues that same packet', async () => {
    const f = setup(); vi.mocked(f.client.ensureAgentContinuity).mockRejectedValueOnce(new Error('receipt lost after dispatch'))
    const view = await mount(f.node); await click(button(view.element, '恢复原 Agent'))
    const input = vi.mocked(f.client.ensureAgentContinuity).mock.calls[0]![0]
    expect(new DeviceWorkfaceStore(() => localStorage).snapshot().record.agentResumes?.[0]?.input).toEqual(input)
    await view.render(<MobileAgentActions client={f.client} agentSessionId="other" connected copyText={f.copy} />)
    await view.render(f.node)
    expect(f.client.ensureAgentContinuity).toHaveBeenCalledTimes(1)
    await click(button(view.element, '核对原恢复操作'))
    expect(f.client.ensureAgentContinuity).toHaveBeenCalledTimes(1)
    await click(button(view.element, '继续同一恢复操作'))
    expect(f.client.ensureAgentContinuity).toHaveBeenCalledTimes(2)
    expect(vi.mocked(f.client.ensureAgentContinuity).mock.calls[1]![0]).toEqual(input)
    expect(getDeviceWorkface().snapshot().record.agentResumes?.[0]?.phase).toBe('confirmed')
  })
  it('does not launch after the original Session selection changes while the authoritative read is pending', async () => {
    const f = setup(); let resolve!: (value: any) => void
    const view = await mount(f.node)
    vi.mocked(f.client.forwardRpc!).mockReturnValueOnce(new Promise(yes => { resolve = yes }) as never)
    await click(button(view.element, '恢复原 Agent'))
    await view.render(<MobileAgentActions client={f.client} agentSessionId="other" connected copyText={f.copy} />)
    await act(async () => resolve({ session: session() }))
    expect(f.client.ensureAgentContinuity).not.toHaveBeenCalled()
    expect(getDeviceWorkface().snapshot().record.agentResumes).toBeUndefined()
  })
  it('does not overwrite a replacement device record with a late recovery receipt', async () => {
    const f = setup(); let resolve!: (value: any) => void
    vi.mocked(f.client.ensureAgentContinuity).mockReturnValueOnce(new Promise(yes => { resolve = yes }))
    const view = await mount(f.node); await click(button(view.element, '恢复原 Agent'))
    await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
    const replacementRecord = getDeviceWorkface().recordIdentity()
    await act(async () => resolve({ kind: 'resumed', session: session(), previousRun: session().run }))
    expect(getDeviceWorkface().snapshot().record.agentResumes).toBeUndefined()
    expect(getDeviceWorkface().snapshot().record.recordId).toBe(replacementRecord)
  })
})

it('compacts settled recovery history while preserving every unknown original operation', async () => {
  const owner = getDeviceWorkface(), recordId = owner.recordIdentity()
  const intent = { runtimeId: 'original-runtime', deviceHostId: null, hostId: 'host-original', input: { agentSessionId: 'retained-unknown', expectedRun: { runId: 'run-original' }, operationId: 'unknown-original', trigger: 'manual' as const }, phase: 'unknown' as const }
  await owner.retainAgentResume(intent, recordId)
  for (let index = 0; index < 300; index++) await owner.retainAgentResume({ ...intent, phase: 'confirmed', input: { ...intent.input, agentSessionId: 'settled', operationId: 'settled-' + index } }, recordId)
  const value = new DeviceWorkfaceStore(() => localStorage).snapshot().record.agentResumes!
  expect(value.filter(item => item.phase === 'confirmed').length).toBeLessThanOrEqual(32)
  expect(value).toContainEqual(intent)
  await owner.retainAgentResume({ ...intent, phase: 'sending', input: { ...intent.input, agentSessionId: 'new-explicit', operationId: 'new-explicit' } }, recordId)
  expect(owner.snapshot().record.agentResumes?.at(-1)!.input.operationId).toBe('new-explicit')
})

it.each([true, false])('keeps a delayed copy result (%s) on its original Agent presentation', async copied => {
  const f = setup(); let resolve!: (value: boolean) => void
  f.copy.mockReturnValueOnce(new Promise(yes => { resolve = yes }))
  const view = await mount(f.node); await click(button(view.element, '复制 Agent 身份链接'))
  await view.render(<MobileAgentActions client={f.client} agentSessionId="other" connected copyText={f.copy} />)
  await act(async () => resolve(copied))
  expect(view.element.textContent).not.toContain('已复制 Agent 身份链接')
  expect(view.element.textContent).not.toContain('浏览器未确认复制')
  expect(view.element.querySelector('[aria-label="Agent 身份链接"]')).toBeNull()
})
it('does not show a late original inspection acknowledgement on a newly selected Agent', async () => {
  const f = setup(), owner = getDeviceWorkface()
  const intent = { runtimeId: 'original-runtime', deviceHostId: null, hostId: 'host-original', input: { agentSessionId: 'session-original', expectedRun: { runId: 'run-original' }, operationId: 'original-pending-inspection', trigger: 'manual' as const }, phase: 'unknown' as const }
  await owner.retainAgentResume(intent, owner.recordIdentity())
  const retain = owner.retainAgentResume.bind(owner); let acknowledge!: () => void
  vi.spyOn(owner, 'retainAgentResume').mockImplementationOnce(async (...args) => { await new Promise<void>(yes => { acknowledge = yes }); await retain(...args) })
  const view = await mount(f.node)
  vi.mocked(f.client.forwardRpc!).mockResolvedValueOnce({ session: { ...session(), continuityOperations: { [intent.input.operationId]: { operationId: intent.input.operationId, agentSessionId: 'session-original', previousRun: session().run, kind: 'resumed' } } } } as never)
  await click(button(view.element, '核对原恢复操作'))
  expect(acknowledge).toBeTypeOf('function')
  await view.render(<MobileAgentActions client={f.client} agentSessionId="other" connected copyText={f.copy} />)
  await act(async () => acknowledge())
  expect(view.element.textContent).not.toContain('原恢复启动已确认')
  expect(owner.snapshot().record.agentResumes?.at(-1)?.phase).toBe('confirmed')
})
it('keeps an original flight busy after leaving and returning, while another Agent remains actionable', async () => {
  const f = setup(); let resolve!: (value: any) => void
  vi.mocked(f.client.ensureAgentContinuity).mockReturnValueOnce(new Promise(yes => { resolve = yes }))
  const view = await mount(f.node); await click(button(view.element, '恢复原 Agent'))
  await view.render(<MobileAgentActions client={f.client} agentSessionId="other" connected copyText={f.copy} />)
  expect(button(view.element, '恢复原 Agent').disabled).toBe(false)
  await view.render(f.node)
  expect(button(view.element, '正在核对原会话…').disabled).toBe(true)
  await act(async () => resolve({ kind: 'resumed', session: session(), previousRun: session().run }))
  expect(f.client.ensureAgentContinuity).toHaveBeenCalledTimes(1)
})

it('retains a typed superseded-Run conflict and only a new explicit action recovers the same SID current Run', async () => {
  const f = setup(), next = { ...session(), run: { runId: 'other-owner-current-run' } }
  vi.mocked(f.client.ensureAgentContinuity).mockResolvedValueOnce({ kind: 'conflict', reason: 'session-run-changed', agentSessionId: 'session-original', previousRun: session().run, currentRun: next.run } as never)
  const view = await mount(f.node); await click(button(view.element, '恢复原 Agent'))
  const first = getDeviceWorkface().snapshot().record.agentResumes!.at(-1)!
  expect(first.phase).toBe('superseded'); expect(f.client.ensureAgentContinuity).toHaveBeenCalledTimes(1)
  vi.mocked(f.client.forwardRpc!).mockResolvedValueOnce({ session: next } as never)
  vi.mocked(f.client.ensureAgentContinuity).mockResolvedValueOnce({ kind: 'reattachable', session: next, previousRun: next.run, run: {} } as never)
  await click(button(view.element, '恢复原 Agent'))
  const input = vi.mocked(f.client.ensureAgentContinuity).mock.calls[1]![0]
  expect(input.agentSessionId).toBe('session-original'); expect(input.expectedRun).toEqual(next.run)
  expect(input.operationId).not.toBe(first.input.operationId)
  expect(getDeviceWorkface().snapshot().record.agentResumes).toContainEqual(first)
})
