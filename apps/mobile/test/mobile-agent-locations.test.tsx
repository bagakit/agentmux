import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { MobileApp } from '../src/MobileApp'
import { MobileZoneWorkface } from '../src/navigation/MobileZoneWorkface'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, deferred, editor, fixture, mount, mounted, paste, plainEnter, waitForElement } from './conversation-fixture'
import { openPrimary } from './mobile-root-navigation'

const connected = { state: 'connected' as const, message: '已连接原 Host' }
const original = { spaceId: 'space-a', zoneId: 'zone', workspaceId: 'resource', displayWorkspaceId: 'display-a', groupId: 'group-a', tabId: 'tab', regionId: 'region-a' }
const alias = { ...original, spaceId: 'space-b' }
const second = { ...original, groupId: 'group-b', regionId: 'region-b' }
function catalog(): AgentMuxSpaceCatalog {
  return { spaces: ['space-a', 'space-b'].map(spaceId => ({ spaceId, kind: 'folder', name: '同名空间', hostId: 'host-original', directoryPath: '/resource', projectId: null })),
    zones: [{ zoneId: 'zone', workspaceId: 'resource', kind: 'worktree', hostId: 'host-original', directoryPath: '/resource', branch: 'branch-original' }],
    tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'resource', name: 'Agent', regionIds: ['region-a', 'region-b'] }, { tabId: 'foreign-tab', zoneId: null, workspaceId: 'resource', name: 'Agent', regionIds: ['foreign-region'] }],
    regions: ['region-a', 'region-b'].map(regionId => ({ regionId, tabId: 'tab', kind: 'agent' as const, agentSessionId: 'session-original', runId: 'run-original', execution: { hostId: 'host-original', cwd: '/execution' } })).concat([
      { regionId: 'foreign-region', tabId: 'foreign-tab', kind: 'agent', agentSessionId: 'session-original', runId: 'run-foreign', execution: { hostId: 'host-other', cwd: '/execution' } }]),
    bindings: [{ spaceId: 'space-a', zoneId: 'zone' }, { spaceId: 'space-b', zoneId: 'zone' }],
    locations: [original, alias, second, { ...original, tabId: 'foreign-tab', regionId: 'foreign-region' }],
    agentPresentation: [{ agentSessionId: 'session-original', name: 'Original Agent', project: 'Original Project', detail: '原摘要', group: 'working', state: 'working', providerId: 'codex', recap: null,
      projectGroup: { key: 'project', projectId: 'project', hostId: 'host-original', name: 'Original Project', spaceId: 'space-a' } }] }
}
const sheet = () => document.body.querySelector<HTMLElement>('.mobile-agent-locations-sheet')!
const choices = () => [...sheet().querySelectorAll<HTMLButtonElement>('.mobile-agent-location > button')]
const attempts = () => getDeviceWorkface().snapshot().record.conversation.attempts
async function settled(assertion: () => void) { await vi.waitFor(async () => { await act(async () => {}); assertion() }, { timeout: 10000, interval: 10 }) }
function rpc(f: ReturnType<typeof fixture>, read: () => AgentMuxSpaceCatalog = catalog) {
  return vi.fn(async (method: string, params: any) => method === 'app.snapshot' ? { agents: [] }
    : method === 'agent.inspect' ? { session: f.client.agentSession(params.target.agentSessionId), displayName: { override: null, availability: 'observed' } }
    : { catalog: structuredClone(read()) })
}
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }; document.body.replaceChildren(); vi.restoreAllMocks() })

it('mobile locations actual App folds aliases without folding context or cross-Host SID and retains original unknown input', async () => {
  localStorage.setItem('agentmux-mobile-home', 'focus')
  await getDeviceWorkface().replaceBackup({ ...emptyDeviceWorkface(), selectedSessionId: 'session-original' })
  const f = fixture(), value = catalog(); f.client.forwardRpc = rpc(f, () => value)
  f.submit.mockRejectedValueOnce(Object.assign(new Error('original ACK unavailable'), { code: 'TRANSPORT_LOST', controlFailure: { disposition: 'unknown', confirmedInputBytes: 9 } }))
  const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
  await waitForElement(view.element, '[contenteditable="true"]')
  await paste(view.element, 'original pending request'); await plainEnter(view.element)
  await settled(() => expect(attempts().some(([, attempt]) => attempt.phase === 'unknown')).toBe(true))
  await paste(view.element, 'preserved unsent draft')
  const input = editor(view.element), retained = structuredClone(attempts()), historyCalls = f.readHistory.mock.calls.length
  await openPrimary(view.element, 'Focus')
  const entry = await waitForElement<HTMLButtonElement>(view.element, '.mobile-agent-locations-entry')
  expect(entry.getAttribute('aria-label')).toBe('Original Agent · 2 个位置')
  expect(view.element.querySelector('details.mobile-session-locations')).toBeNull()
  expect(f.client.forwardRpc.mock.calls.filter(([method]) => method === 'space.inspect')).toHaveLength(0)
  await click(entry)
  expect(choices()).toHaveLength(3)
  expect(sheet().closest('.mobile-agent-row'), 'The location list overlays the directory instead of entering its row flow').toBeNull()
  expect(choices().every(choice => !choice.textContent?.includes('host-other'))).toBe(true)
  expect(choices().every(choice => choice.querySelector('strong')?.textContent !== 'Agent')).toBe(true)
  await click(button(sheet(), '关闭位置选择'))
  expect(editor(view.element)).toBe(input); expect(input.textContent).toContain('preserved unsent draft')
  expect(attempts()).toEqual(retained); expect(f.readHistory.mock.calls.length).toBe(historyCalls)
  await click(entry); await click(choices()[1]!)
  await settled(() => expect(getDeviceWorkface().snapshot().record.presentation?.identity?.context).toEqual(alias))
  expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original')
  expect(f.client.forwardRpc).toHaveBeenCalledWith('space.inspect', { target: { spaceId: 'space-b', zoneId: 'zone', displayWorkspaceId: 'display-a', groupId: 'group-a', tabId: 'tab', regionId: 'region-a' }, presentation: true })
  expect(editor(view.element)).toBe(input); expect(input.textContent).toContain('preserved unsent draft'); expect(attempts()).toEqual(retained)
  await click(button(view.element.querySelector('.mobile-session-toolbar') as HTMLElement, '返回 Focus'))
  await openPrimary(view.element, 'Space')
  await click(await waitForElement(view.element, '.mobile-session-list > li > button'))
  const spaceEntry = await waitForElement<HTMLButtonElement>(view.element, '.mobile-spatial-tab .mobile-agent-locations-entry')
  expect(spaceEntry.getAttribute('aria-label')).toBe('Original Agent · 2 个位置')
  await click(spaceEntry); expect(choices()).toHaveLength(3); await click(choices()[2]!)
  await settled(() => expect(getDeviceWorkface().snapshot().record.presentation?.identity?.context).toEqual(second))
  expect(editor(view.element)).toBe(input); expect(attempts()).toEqual(retained)
  await click(button(view.element.querySelector('.mobile-session-toolbar') as HTMLElement, '返回 Space'))
  await openPrimary(view.element, 'Focus')
  for (const region of value.regions) if (region.execution?.hostId === 'host-original') region.execution = null
  const focus = [...view.element.querySelectorAll<HTMLElement>('.mobile-spatial-panel')].find(panel => !panel.closest('[hidden]'))!
  await click(button(focus, '刷新空间目录'))
  expect(focus.querySelector('.mobile-agent-locations-entry')?.getAttribute('aria-label')).toBe('Original Agent · 位置待确认')
  await click(focus.querySelector('.mobile-agent-locations-entry')!)
  expect(sheet().textContent).toContain('位置事实还没确认')
  await click(button(sheet(), '关闭位置选择')); await click(focus.querySelector('.mobile-agent-row__open')!)
  expect(editor(view.element)).toBe(input); expect(attempts()).toEqual(retained)
  expect(f.submit).toHaveBeenCalledTimes(1); expect(f.signalAgent).not.toHaveBeenCalled(); expect(f.rejoinInput).not.toHaveBeenCalled()
  expect(f.client.forwardRpc.mock.calls.some(([method]) => method === 'space.focus' || /agent\.(start|resume|stop)/.test(method))).toBe(false)
})

it('mobile locations Zone uses the original exact tuple and keeps a failed selection separate from healthy primary opening', async () => {
  const f = fixture(), value = catalog(), open = vi.fn(); f.client.forwardRpc = rpc(f, () => value)
  const view = await mount(<MobileZoneWorkface client={f.client} name="Original Zone" zoneId="zone" visible openSession={open} />)
  const entry = await waitForElement<HTMLButtonElement>(view.element, '.mobile-agent-locations-entry')
  expect(entry.getAttribute('aria-label')).toContain('2 个位置')
  await click(entry); expect(choices()).toHaveLength(3); expect(sheet().closest('.mobile-agent-row')).toBeNull()
  await click(choices()[2]!)
  expect(open).toHaveBeenCalledExactlyOnceWith('session-original', { name: 'Original Agent', project: 'Original Project', context: second })
  open.mockClear(); await click(entry)
  value.locations = value.locations.filter(place => place.regionId !== 'region-b')
  await click(choices()[2]!)
  expect(open).not.toHaveBeenCalled(); expect(sheet().textContent).toContain('这个位置已变化或还没确认')
  f.client.forwardRpc.mockRejectedValueOnce(new Error('original inspect unavailable'))
  await click(choices()[0]!)
  expect(sheet().textContent).toContain('original inspect unavailable'); expect(open).not.toHaveBeenCalled()
  await click(button(sheet(), '关闭位置选择'))
  await click(view.element.querySelector('.mobile-agent-row__open')!)
  expect(open).toHaveBeenCalledOnce(); expect(f.submit).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled()
})

it('mobile locations rejects late exact reads after client SID Runtime or canceled intent changes while retaining the picker', async () => {
  for (const change of ['client', 'sid', 'runtime', 'runtime-reject', 'cancel'] as const) {
    const f = fixture(), other = fixture(), value = catalog(), open = vi.fn(), pending = deferred<{ catalog: AgentMuxSpaceCatalog }>()
    let owner = 'runtime-original'
    f.client.runtimeOwnerIdentity = () => ({ runtimeId: owner, ownerInstanceId: 'original-instance' })
    f.client.forwardRpc = rpc(f, () => value); other.client.forwardRpc = rpc(other, () => value)
    const render = (client = f.client) => <MobileZoneWorkface client={client} name="Original Zone" zoneId="zone" visible openSession={open} />
    const view = await mount(render())
    await click(await waitForElement(view.element, '.mobile-agent-locations-entry'))
    f.client.forwardRpc.mockImplementationOnce(() => pending.promise)
    await click(choices()[0]!)
    if (change === 'client') await view.render(render(other.client))
    if (change === 'sid') { value.regions[0]!.agentSessionId = 'other'; await view.render(render()); await click(button(view.element, '刷新讨论')) }
    if (change === 'runtime' || change === 'runtime-reject') owner = 'runtime-replaced'
    if (change === 'cancel') { await click(button(sheet(), '关闭位置选择')); await click(view.element.querySelector('.mobile-agent-locations-entry')!) }
    await act(async () => change === 'runtime-reject' ? pending.reject(new Error('old-runtime rejection body')) : pending.resolve({ catalog: catalog() }))
    expect(open, `Late ${change} read cannot retarget local navigation`).not.toHaveBeenCalled()
    expect(sheet()).not.toBeNull()
    if (change !== 'cancel') expect(sheet().textContent).toContain('这次没有打开')
    else expect(sheet().querySelector('[aria-busy]')?.getAttribute('aria-busy')).toBe('false')
    expect(sheet().textContent).not.toContain('old-runtime rejection body')
    await act(async () => mounted.pop()!.root.unmount()); view.element.remove()
  }
})

it('mobile locations distinguishes zero one and unknown facts without closing the original Agent', async () => {
  for (const kind of ['zero', 'one', 'unknown'] as const) {
    const f = fixture(), value = catalog(), open = vi.fn()
    value.regions = [value.regions[0]!]; value.tabs = [value.tabs[0]!]
    value.locations = kind === 'zero' ? [] : [original, alias]
    if (kind === 'unknown') value.regions[0]!.execution = null
    f.client.forwardRpc = rpc(f, () => value)
    const view = await mount(<MobileZoneWorkface client={f.client} name="Zone" zoneId="zone" visible openSession={open} />)
    const entry = await waitForElement<HTMLButtonElement>(view.element, '.mobile-agent-locations-entry')
    expect(entry.getAttribute('aria-label')).toBe(`Original Agent · ${kind === 'unknown' ? '位置待确认' : `${kind === 'one' ? 1 : 0} 个位置`}`)
    await click(entry)
    if (kind === 'zero') expect(sheet().textContent).toContain('当前目录没有已绑定的展示位置')
    else expect(choices()).toHaveLength(2)
    if (kind === 'unknown') { await click(choices()[0]!); expect(open).not.toHaveBeenCalled(); expect(sheet().textContent).toContain('来源或目录读取还没确认') }
    await click(button(sheet(), '关闭位置选择')); await click(view.element.querySelector('.mobile-agent-row__open')!)
    expect(open).toHaveBeenCalledOnce(); expect(f.submit).not.toHaveBeenCalled()
    await act(async () => mounted.pop()!.root.unmount()); view.element.remove()
  }
})
