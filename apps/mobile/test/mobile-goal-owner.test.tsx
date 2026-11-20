import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fixturePath } from '../../../test/fixture-values.mjs'
import { seedStoredDemand } from '../../../test/fixtures/stored-demand.mjs'
import './mobile-lan-crypto.setup'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { openDemandStore } from '@agentmux/demand'
import { createHostGoals } from '../../host/src/goals'
import { projectHostGoal } from '../../host/src/goal-projection'
import { AgentMuxRpcService, type AgentMuxRpcServiceOptions } from '../../../packages/core/src/public-rpc-service'
import { api } from '../../desktop/src/renderer/src/lib/api'
import { useAppStore } from '../../desktop/src/renderer/src/store'
import { SCRATCH_WORKSPACE_ID } from '../../host/src/mote-model'
import { MobileGoalsSurface } from '../src/goals/MobileGoalsSurface'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { fixture, session } from './conversation-fixture'
import { openPrimary } from './mobile-root-navigation'
import { getDeviceWorkface, emptyDeviceWorkface, DEVICE_WORKFACE_KEY, DeviceWorkfaceStore } from '../src/recovery/device-workface'
import { freezeMobileGoalUpdateRequest } from '../src/recovery/goal-drafts'
import { mobileWorkfaceLayout } from '../src/layout/workface-presentation'
import { bindMobileViewport, readMobileViewport } from '../src/platform/native/device'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const baseline = useAppStore.getState()
let directory: string, owner: ReturnType<typeof openDemandStore>, hostGoals: ReturnType<typeof createHostGoals>
const discussions = new Map<string, { tabId: string; regionId: string; sessionId: string }>()
const inFlight = new Set<Promise<unknown>>()
let discussionUnavailable = false
let directoryProjects: import('@agentmux/core/control').AgentMuxControlProject[] = []
const discussionName = 'Original discussion Agent'
const creationRuntime = 'private-goal-runtime'
const creationInputEpoch = 'original-mobile-input-epoch'
const mounts: { root: Root; element: HTMLDivElement }[] = []
const scratch = { id: SCRATCH_WORKSPACE_ID, name: 'Main Mote', hostId: 'local', path: fixturePath("private-topic-fixture"), kind: 'scratch' as const }
const config = { ...baseline.config, version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }], workspaces: [scratch], executors: {} } as any
const proposal = { summary: 'Read real current proposal', criteria: [{ id: 'c', text: 'Original criterion' }], openQuestions: [] }
const originalGoalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
async function goalWidth(width: number) { await act(async () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  window.dispatchEvent(new Event('resize'))
  await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()))
}) }
beforeEach(async () => {
  localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
  directory = await mkdtemp(join(tmpdir(), 'mgoal-')); discussions.clear(); discussionUnavailable = false; directoryProjects = []
  const configurationPath = join(directory, 'configuration.json')
  await writeFile(configurationPath, JSON.stringify(config))
  hostGoals = createHostGoals({ configurationPath, projects: async () => directoryProjects,
    runtime: () => ({ ownerIdentity: () => ({ runtimeId: creationRuntime }),
      client: { readAgentInputEpoch: async () => creationInputEpoch } }) as ReturnType<Parameters<typeof createHostGoals>[0]['runtime']>,
    coreCall: async () => { throw new Error('Native discussion execution is qualified by the Host integration suite, not this mounted client fixture.') } })
  owner = openDemandStore({ root: join(directory, 'demands') })
  useAppStore.setState({ ...baseline, config, sessions: [], tabs: {}, layouts: {}, demandPmoTabIds: {}, demands: {} }, true)
  // The original Host domain owns every CRUD operation. Faults below wrap its
  // actual store methods, so late/unknown receipts still follow the current API.
  vi.spyOn(hostGoals.demands, 'create').mockImplementation((...args) => owner.create(...args))
  vi.spyOn(hostGoals.demands, 'update').mockImplementation((...args) => owner.update(...args))
  vi.spyOn(hostGoals.demands, 'confirmAlignment').mockImplementation((...args) => owner.confirmAlignment(...args))
  vi.spyOn(api.demands, 'list').mockImplementation(() => owner.list())
  vi.spyOn(api.continuousProgress, 'goals').mockResolvedValue([])
})
const executeGoal: NonNullable<AgentMuxRpcServiceOptions['goalControl']> = async (request, names, context) => {
  if (request.operation === 'demand.discuss') {
    // The mounted client consumes a controlled receipt. Its native production is covered by mobile-desktop-goals.test.ts.
    if (discussionUnavailable) throw new Error('Original discussion owner is unavailable')
    const goal = await owner.get(request.demandId)
    expect(goal, 'The discussion consumes the original saved Goal').not.toBeNull()
    const binding = discussions.get(goal!.id) ?? { tabId: 'discussion-tab:' + goal!.id, regionId: 'discussion-region:' + goal!.id, sessionId: 'discussion-agent:' + goal!.id }
    discussions.set(goal!.id, binding)
    return { operation: request.operation, demand: projectHostGoal(goal!), receipt: { demandId: goal!.id, requestId: request.requestId,
      route: 'discussion', mode: request.mode, tabId: binding.tabId, regionId: binding.regionId, hostId: 'local', agentSessionId: binding.sessionId } }
  }
  const result = await hostGoals.execute(request, names, context)
  if (!result || !result.operation.startsWith('demand.')) throw new Error('The original Host did not handle this Goal operation: ' + request.operation)
  return result
}
afterEach(async () => {
  for (const view of mounts.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  if (originalGoalWidth) Object.defineProperty(window, 'innerWidth', originalGoalWidth); else Reflect.deleteProperty(window, 'innerWidth')
  await Promise.allSettled([...inFlight]); await hostGoals.dispose(); vi.restoreAllMocks(); useAppStore.setState(baseline, true); await rm(directory, { recursive: true, force: true })
})
async function mount(initialContext?: import('../src/recovery/presentation-route').MobileGoalsContext, mobileApp = false) {
  const sdk = mobileApp ? fixture() : null
  const service = new AgentMuxRpcService({ goalControl: executeGoal, execute: request => {
    if (request.operation === 'space.inspect') {
      const binding = [...discussions.values()].find(value => value.tabId === ('tabId' in request.target ? request.target.tabId : undefined))
      expect(binding, 'The public read keeps the exact discussion Tab').toBeDefined()
      return Promise.resolve({ operation: request.operation, catalog: { spaces: [], zones: [], bindings: [], locations: [],
        tabs: [{ tabId: binding!.tabId, zoneId: 'original-discussion-zone', workspaceId: SCRATCH_WORKSPACE_ID, name: discussionName, regionIds: [binding!.regionId] }],
        regions: [{ tabId: binding!.tabId, regionId: binding!.regionId, kind: 'agent', agentSessionId: binding!.sessionId, runId: 'original-discussion-run', execution: { hostId: 'local', cwd: scratch.path } }] } } as never)
    }
    return useAppStore.getState().executeControl(request)
  }, coreClients: () => [], snapshot: async () => ({ projects: directoryProjects, executors: [] }) })
  const forwardRpc = vi.fn((method: any, params: any) => {
    const pending = service.call(method, params, { principal: { kind: 'device', id: 'approved-phone' } })
    inFlight.add(pending); void pending.then(result => {
      const receipt = method === 'goal.discuss' ? (result as any).receipt : null
      if (sdk && receipt?.agentSessionId) sdk.sessions.set(receipt.agentSessionId, session(receipt.agentSessionId))
      inFlight.delete(pending)
    }, () => inFlight.delete(pending))
    return pending
  })
  const client = Object.assign(sdk?.client ?? {}, { forwardRpc, runtimeOwnerIdentity: () => ({ runtimeId: creationRuntime, ownerInstanceId: 'original-goal-process', availability: 'connected' }) }) as any, element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); mounts.push({ root, element })
  const openSession = vi.fn()
  if (mobileApp) await getDeviceWorkface().updatePresentation({ selectedSessionId: null, hostUrl: '', panel: 'conversation' },
    { primary: 'goals', showSession: false, showGoalWork: false, identity: null, profile: null, ...(initialContext ? { goals: initialContext } : {}) })
  const render = async (visible = true, wide = false) => { await act(async () => root.render(mobileApp
    ? <MobileApp restoreWorkface client={client} connection={{ state: 'connected', message: 'Original Host' }} platform={createBrowserPlatform()} />
    : <MobileGoalsSurface client={client} visible={visible} wide={wide} connected={true} openSession={openSession} {...(initialContext ? { initialContext } : {})} />)) }
  await render()
  const buttons = (text: string) => [...element.querySelectorAll('button')].filter(button => (button.getAttribute('aria-label') ?? button.textContent) === text && !button.closest('[hidden]'))
  const click = async (text: string) => { const button = buttons(text)[0]; expect(button, text).toBeDefined(); await act(async () => { button!.click() }) }
  const wait = async (text: string) => { await vi.waitFor(async () => { await act(async () => {}); expect(element.textContent).toContain(text) }, { timeout: 5000 }) }
  return { element, forwardRpc, render, click, wait, buttons, openSession, root, client, sdk }
}
async function existingGoal() {
  await seedStoredDemand(owner, { id: 'original-goal', title: 'Actual goal' }); await owner.update('original-goal', { alignment: proposal })
  const view = await mount(); await view.wait('Actual goal')
  await view.click('Actual goal未分配项目 · 待整理'); await view.wait(proposal.summary)
  return view
}

it('workface Goal consumes the original viewport budget and retains its editor and presented background while observation pauses', async () => {
  const view = await existingGoal()
  await view.click('编辑目标正文')
  const editor = view.element.querySelector<HTMLTextAreaElement>('[aria-label="目标正文草稿"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, 'Workface original unsaved body')
    editor.dispatchEvent(new Event('input', { bubbles: true })); editor.focus(); editor.setSelectionRange(3, 8)
  })
  await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.goalDrafts?.some(value => value.description === editor.value)).toBe(true))
  const draft = getDeviceWorkface().exportBackup(), list = view.element.querySelector<HTMLElement>('.mobile-goals-directory')!
  const content = view.element.querySelector<HTMLElement>('.mobile-goals-work')!, reading = view.element.querySelector('article[aria-label="目标详情"]')!
  content.scrollTop = 71
  const originalWidth = window.innerWidth, originalHeight = window.innerHeight
  const release = bindMobileViewport(window, document.documentElement)
  try {
    for (const [width, height] of [[667, 375], [812, 375], [390, 844], [320, 700], [1024, 768]]) {
      await act(async () => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
        window.dispatchEvent(new Event('resize'))
        await new Promise(resolve => window.requestAnimationFrame(resolve))
      })
      await view.render(true, mobileWorkfaceLayout(readMobileViewport(window)).split)
      expect(list.hidden, 'A usable phone landscape budget must present the original Goal navigation.').toBe(width < 600)
      expect(view.element.querySelector('.mobile-goals-layout')?.classList.contains('mobile-workface-frame')).toBe(true)
      expect(view.element.querySelector('[aria-label="目标正文草稿"]')).toBe(editor)
      expect(view.element.querySelector('article[aria-label="目标详情"]')).toBe(reading)
      expect(editor.value).toBe('Workface original unsaved body')
      expect([editor.selectionStart, editor.selectionEnd]).toEqual([3, 8])
      expect(document.activeElement).toBe(editor); expect(content.scrollTop).toBe(71)
    }
    const calls = view.forwardRpc.mock.calls.length
    await view.render(false, true)
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(list.hidden, 'Inactive observation must keep the original Goal background presented.').toBe(false)
    expect(content.hidden).toBe(false); expect(reading.closest('[hidden]')).toBeNull()
    expect(view.forwardRpc.mock.calls).toHaveLength(calls)
    expect(getDeviceWorkface().exportBackup()).toBe(draft)
    expect((await owner.get('original-goal'))!.description).not.toBe(editor.value)
  } finally {
    release(); Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth }); Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight })
  }
})

it('workface Goal preserves the original create form outside the shared panes while an inactive overlay pauses reads', async () => {
  const view = await mount()
  await view.click('开始新目标')
  const form = view.element.querySelector<HTMLElement>('.mobile-goal-create__form')!
  const frame = view.element.querySelector('.mobile-workface-frame')!
  expect(frame.contains(form)).toBe(false)
  const calls = view.forwardRpc.mock.calls.length
  await view.render(false, true)
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(view.element.querySelector('.mobile-goal-create__form')).toBe(form)
  expect(form.closest('[hidden]')).toBeNull()
  expect(view.element.querySelector('[aria-label="目标工坊"]')).not.toBeNull()
  expect(view.forwardRpc.mock.calls).toHaveLength(calls)
  expect(await owner.list()).toEqual([])
})

it('responsive Goals actual App keeps its selected owner, original editor and unsaved draft through wide and phone panes', async () => {
  await seedStoredDemand(owner, { id: 'responsive-original', title: 'Original responsive goal', description: 'Original owner body' })
  await owner.update('responsive-original', { alignment: proposal })
  await goalWidth(844)
  const view = await mount(undefined, true)
  await view.wait('Original responsive goal')
  const list = view.element.querySelector<HTMLElement>('.mobile-goals-directory')
  expect(list, 'actual Goals must expose its original navigation pane').not.toBeNull()
  await view.click('开始新目标')
  const createForm = view.element.querySelector<HTMLElement>('.mobile-goal-create__form')!
  await act(async () => list!.querySelector<HTMLButtonElement>('.mobile-goals-list button')!.click())
  await view.wait(proposal.summary)
  expect(list!.hidden, 'wide selected Goal must keep its original list visible').toBe(false)
  const selectedRow = list!.querySelector('[aria-current="true"]')
  expect(selectedRow?.textContent).toContain('Original responsive goal')
  await view.click('编辑目标正文')
  const editor = view.element.querySelector<HTMLTextAreaElement>('article:not([hidden]) [aria-label="目标正文草稿"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, '原目标未保存正文保持'); editor.dispatchEvent(new Event('input', { bubbles: true })) })
  await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.goalDrafts?.find(draft => draft.goalId === 'responsive-original')?.description).toBe('原目标未保存正文保持'))
  editor.focus(); editor.setSelectionRange(2, 6)
  const pane = view.element.querySelector<HTMLElement>('.mobile-goals-work')!; pane.scrollTop = 93
  const device = getDeviceWorkface(), original = device.exportBackup(), writes = vi.spyOn(device, 'updatePresentation')
  for (const width of [1024, 390, 951, 669, 812]) {
    await goalWidth(width)
    expect(view.element.querySelector('article:not([hidden]) [aria-label="目标正文草稿"]'), 'width must keep the same original editor node').toBe(editor)
    expect(editor.value).toBe('原目标未保存正文保持'); expect(editor.selectionStart).toBe(2); expect(editor.selectionEnd).toBe(6)
    expect(document.activeElement).toBe(editor); expect(pane.scrollTop).toBe(93)
    expect(list!.hidden).toBe(width < 600)
    expect(createForm.hidden, 'width never reopens or focuses the retained creation form').toBe(true)
    expect(device.exportBackup()).toBe(original)
  }
  list!.querySelector<HTMLInputElement>('[aria-label="搜索目标"]')!.focus()
  await goalWidth(390)
  expect(document.activeElement, 'only a newly hidden navigation target transfers focus to the retained work pane').toBe(pane)
  expect(view.element.querySelector('[aria-label="目标正文草稿"]')).toBe(editor)
  expect(device.exportBackup()).toBe(original)
  expect(writes).not.toHaveBeenCalled()
  expect(await owner.get('responsive-original')).toMatchObject({ description: 'Original owner body' })
  expect(view.forwardRpc.mock.calls.filter(([method]) => ['goal.create', 'goal.update', 'goal.discuss', 'goal.confirm', 'goal.accept', 'goal.start'].includes(method))).toEqual([])
  expect(view.sdk!.submit).not.toHaveBeenCalled(); expect(view.sdk!.respond).not.toHaveBeenCalled(); expect(view.sdk!.rejoinInput).not.toHaveBeenCalled(); expect(view.sdk!.signalAgent).not.toHaveBeenCalled()
})

it('responsive Goals keeps the original unknown writer ACK and its editor through both pane layouts without replay', async () => {
  const view = await existingGoal(); await view.render(true, true)
  await view.click('编辑目标正文'); await editBody(view, '宽窄共同保留的原未知保存正文')
  const normal = vi.mocked(hostGoals.demands.update).getMockImplementation()!
  vi.mocked(hostGoals.demands.update).mockImplementationOnce(async (...args) => { await normal(...args); throw new Error('Original responsive ACK lost') })
  await saveBody(view); await view.wait('保存还没确认')
  const editor = view.element.querySelector<HTMLTextAreaElement>('[aria-label="目标正文草稿"]')!, device = getDeviceWorkface()
  const original = device.exportBackup(), request = view.forwardRpc.mock.calls.find(([method]) => method === 'goal.update')![1]
  for (const wide of [false, true, false, true]) {
    await view.render(true, wide)
    expect(view.element.querySelector('[aria-label="目标正文草稿"]')).toBe(editor)
    expect(editor.value).toBe('宽窄共同保留的原未知保存正文')
    expect(device.exportBackup()).toBe(original)
    expect(device.snapshot().record.goalDrafts![0]!.operations[0]!.request).toEqual(request)
    expect(view.element.querySelector('.mobile-goal-unknown')?.textContent).toContain('保存还没确认')
  }
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.update')).toHaveLength(1)
  expect((await owner.get('original-goal'))!.description).toBe('宽窄共同保留的原未知保存正文')
})

it('responsive Goals uses only its visible original list and selected detail readers, retaining filters when the phone list hides', async () => {
  await seedStoredDemand(owner, { id: 'reader-a', title: 'Reader A' }); await seedStoredDemand(owner, { id: 'reader-b', title: 'Reader B' })
  const view = await mount({ goalId: 'reader-a', mode: 'detail', discussion: null })
  await view.wait('Reader A')
  const count = (method: string) => view.forwardRpc.mock.calls.filter(([name]) => name === method).length
  expect(count('goal.ls')).toBe(0); expect(count('goal.inspect')).toBe(1)
  await view.render(true, true); await Promise.allSettled([...inFlight]); await act(async () => {})
  expect(count('goal.ls'), 'one visible original list owner').toBe(1)
  const list = view.element.querySelector<HTMLElement>('.mobile-goals-directory')!, search = list.querySelector<HTMLInputElement>('[aria-label="搜索目标"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'Reader'); search.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => { [...list.querySelectorAll<HTMLButtonElement>('.mobile-goals-list button')].find(button => button.textContent?.includes('Reader B'))!.click() })
  await view.wait('Reader B'); await Promise.allSettled([...inFlight])
  expect(count('goal.ls'), 'changing the selected Goal must not recreate a visible list reader').toBe(1)
  expect(view.forwardRpc.mock.calls.filter(([name]) => name === 'goal.inspect').map(([, params]) => params.goalId)).toEqual(['reader-a', 'reader-b'])
  await act(async () => document.dispatchEvent(new Event('visibilitychange'))); await Promise.allSettled([...inFlight])
  expect(count('goal.ls')).toBe(2); expect(count('goal.inspect')).toBe(3)
  await view.render(false, true)
  const hidden = view.forwardRpc.mock.calls.length
  await act(async () => document.dispatchEvent(new Event('visibilitychange'))); await Promise.allSettled([...inFlight])
  expect(view.forwardRpc.mock.calls).toHaveLength(hidden)
  await view.render(true, false); await Promise.allSettled([...inFlight])
  expect(count('goal.ls')).toBe(2); expect(list.hidden).toBe(true); expect(search.value).toBe('Reader')
  await view.render(true, true); await Promise.allSettled([...inFlight])
  expect(count('goal.ls')).toBe(3); expect(list.hidden).toBe(false); expect(list.querySelector('[aria-label="搜索目标"]')).toBe(search); expect(search.value).toBe('Reader')
  expect(count('space.ls')).toBe(0); expect(count('app.snapshot')).toBe(0)
  expect(view.forwardRpc.mock.calls.some(([method]) => ['goal.update', 'goal.create', 'goal.discuss', 'goal.start'].includes(method))).toBe(false)
})

it('responsive Goals pauses hidden detail readers while the exact original discussion is visible', async () => {
  const view = await existingGoal(); await view.render(true, true)
  await view.click('打开目标讨论'); await view.wait(discussionName)
  const inspect = view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.inspect').length
  const list = view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.ls').length
  await act(async () => document.dispatchEvent(new Event('visibilitychange'))); await Promise.allSettled([...inFlight])
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.inspect')).toHaveLength(inspect)
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.ls')).toHaveLength(list + 1)
  const discussionRead = view.forwardRpc.mock.calls.find(([method]) => method === 'space.inspect')!
  expect(discussionRead[1].target).toEqual({ tabId: 'discussion-tab:original-goal' })
  expect(view.element.querySelector<HTMLElement>('.mobile-goals-directory')!.hidden).toBe(false)
  await view.click('返回目标'); await view.wait(proposal.summary); await Promise.allSettled([...inFlight])
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.inspect')).toHaveLength(inspect + 1)
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.discuss')).toHaveLength(1)
})

it('retains a lost delete receipt after the real public Goal service removes the original Goal', async () => {
  const view = await existingGoal(), original = view.forwardRpc
  view.client.forwardRpc = async (method: string, params: any) => {
    const result = await original(method, params)
    if (method === 'goal.delete') throw new Error('original response lost after service execution')
    return result
  }
  await view.render()
  await view.click('删除目标…'); await view.click('确认删除此目标')
  await view.wait('Mac 还没确认删除')
  expect(await owner.get('original-goal')).toBeNull()
  const call = original.mock.calls.find(([method]) => method === 'goal.delete')!
  const records = getDeviceWorkface().snapshot().record.goalOperationRecords ?? []
  expect(records).toHaveLength(1)
  expect(records[0]?.request).toEqual(call[1])
  expect(records[0]?.runtimeId).toBe('private-goal-runtime')
  expect(records[0]?.ownerInstanceId).toBe('original-goal-process')
  expect(original.mock.calls.filter(([method]) => method === 'goal.delete')).toHaveLength(1)
})

it('published Demand dispatch persistence and strict Core Goal codec feed the mounted roles/stages consumer without Start or activity inference', async () => {
  await seedStoredDemand(owner, { id: 'original-goal', title: 'Actual dispatch goal', assigneeSessionIds: ['original-assignee'], supervisorSessionId: 'original-assignee' })
  for (const stage of ['prepared', 'submitted', 'unknown', 'confirmed'] as const) {
    const operationId = `original-${stage}`
    await owner.prepareDispatch('original-goal', { operationId, agentSessionId: 'original-assignee', hostId: 'original-execution-host', runId: 'original-run-reference', execution: 'finite', prompt: `原${stage}正文` })
    if (stage === 'confirmed') {
      // Controlled trusted writer evidence exercises the actual persistence /
      // public codec. It does not claim a new native prompt receipt or Run.
      await owner.recordDispatchPhase('original-goal', operationId, { stage, receipt: { kind: 'core-prompt', itemId: `prompt:${operationId}`, createdAt: Date.now() } })
    } else if (stage !== 'prepared') await owner.recordDispatchPhase('original-goal', operationId, { stage, ...(stage === 'unknown' ? { issue: '原未确认事实' } : {}) })
  }
  const before = await owner.get('original-goal')
  const view = await mount(); await view.wait('Actual dispatch goal'); await view.click('Actual dispatch goal未分配项目 · 待整理')
  const publicGoal = await view.forwardRpc('goal.inspect', { goalId: 'original-goal' })
  expect(publicGoal.goal.dispatches).toEqual(before!.dispatches)
  const progress = view.element.querySelector('[aria-label="目标协作与输入记录"]')!
  for (const value of before!.dispatches!) expect(progress.textContent).toContain(value.operationId)
  expect(progress.textContent).toContain('4 条开始请求 · 1 条输入已确认')
  expect(progress.textContent).toContain('不推断唯一当前执行')
  expect(view.forwardRpc.mock.calls.some(([method]) => ['goal.start', 'goal.update', 'goal.continuation-action'].includes(method))).toBe(false)
  expect(await owner.get('original-goal')).toEqual(before)
})
async function unmount(view: Awaited<ReturnType<typeof mount>>) {
  await act(async () => view.root.unmount()); view.element.remove(); mounts.splice(mounts.findIndex(item => item.root === view.root), 1)
}
async function editBody(view: Awaited<ReturnType<typeof mount>>, text: string) {
  const input = view.element.querySelector<HTMLTextAreaElement>('article:not([hidden]) [aria-label="目标正文草稿"]')!
  expect(input).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function saveBody(view: Awaited<ReturnType<typeof mount>>) {
  const form = view.element.querySelector('article:not([hidden]) .mobile-goal-editor form')!
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
}

it('actual mounted Goal editor freezes the same top-level CAS request and keeps later text through the original public writer response', async () => {
  const view = await existingGoal(), base = (await owner.get('original-goal'))!.updatedAt
  await view.click('编辑目标正文'); await editBody(view, '明确本次保存正文')
  const normal = vi.mocked(hostGoals.demands.update).getMockImplementation()!
  let settle!: () => void
  vi.mocked(hostGoals.demands.update).mockImplementationOnce(async (...args) => {
    const saved = await normal(...args)
    return await new Promise(resolve => { settle = () => resolve(saved) })
  })
  await saveBody(view); await vi.waitFor(() => expect(settle).toBeTypeOf('function'), { timeout: 5000 })
  const request = view.forwardRpc.mock.calls.find(([method]) => method === 'goal.update')![1]
  expect(request).toEqual({ goalId: 'original-goal', operationId: expect.any(String), expectedUpdatedAt: base, patch: { description: '明确本次保存正文' } })
  expect(Object.isFrozen(request)).toBe(true); expect(Object.isFrozen(request.patch)).toBe(true)
  expect(getDeviceWorkface().snapshot().record.goalDrafts?.[0]?.operations[0]?.request).toEqual(request)
  await editBody(view, '原请求之后继续输入的正文')
  await act(async () => settle()); await view.wait('目标已保存。')
  expect(view.element.querySelector<HTMLTextAreaElement>('[aria-label="目标正文草稿"]')?.value).toBe('原请求之后继续输入的正文')
  expect((await owner.get('original-goal'))!.description).toBe('明确本次保存正文')
  expect(new DeviceWorkfaceStore(() => localStorage).snapshot().record.goalDrafts?.[0]).toMatchObject({ description: '原请求之后继续输入的正文', operations: [] })
})

it('actual Demand CAS refuses the old draft version after a newer read, and only explicit adoption allows a new save', async () => {
  const view = await existingGoal(), originalVersion = (await owner.get('original-goal'))!.updatedAt
  await view.click('编辑目标正文'); await editBody(view, '保留原基线的本页正文')
  await owner.update('original-goal', { description: '别人的已保存正文' })
  const newerVersion = (await owner.get('original-goal'))!.updatedAt
  expect(newerVersion).toBeGreaterThan(originalVersion)
  await view.click('读取当前目标'); await view.wait('Mac 上的目标有新版本')
  await saveBody(view); await view.wait('保存还没确认')
  await vi.waitFor(() => {
    const statuses = [...view.element.querySelectorAll('[role="status"]')].map(value => value.textContent ?? '')
    expect(statuses.filter(value => value.includes('保存还没确认'))).toHaveLength(1)
    const originalIssue = getDeviceWorkface().snapshot().record.goalDrafts![0]!.operations[0]!.issue!
    expect(originalIssue).toBeTruthy()
    expect(statuses.some(value => value.includes(originalIssue))).toBe(false)
    expect(view.element.querySelector('.mobile-goal-unknown details')?.textContent).toContain(originalIssue)
  })
  const first = view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.update')[0]![1]
  expect(first.expectedUpdatedAt).toBe(originalVersion); expect(first.patch).not.toHaveProperty('expectedUpdatedAt')
  expect((await owner.get('original-goal'))!.description).toBe('别人的已保存正文')
  await view.click('采用已读新版本；下次保存当前草稿将覆盖该版本')
  await saveBody(view); await view.wait('目标已保存。')
  const requests = view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.update')
  expect(requests).toHaveLength(2); expect(requests[1]![1].expectedUpdatedAt).toBe(newerVersion)
  expect(requests[1]![1].operationId).not.toBe(first.operationId)
  expect((await owner.get('original-goal'))!.description).toBe('保留原基线的本页正文')
  expect(getDeviceWorkface().snapshot().record.goalDrafts?.[0]?.operations.map(value => value.request)).toEqual([first])
})

it('a lost real writer ACK stays unknown on cold remount even when inspect returns the identical saved body', async () => {
  const first = await existingGoal(); await first.click('编辑目标正文'); await editBody(first, '回应丢失的完整原正文')
  const normal = vi.mocked(hostGoals.demands.update).getMockImplementation()!
  vi.mocked(hostGoals.demands.update).mockImplementationOnce(async (...args) => { await normal(...args); throw new Error('Original save ACK lost') })
  await saveBody(first); await first.wait('保存还没确认')
  const request = first.forwardRpc.mock.calls.find(([method]) => method === 'goal.update')![1]
  expect((await owner.get('original-goal'))!.description).toBe('回应丢失的完整原正文')
  await unmount(first)
  const restored = await mount({ goalId: 'original-goal', mode: 'edit', discussion: null }); await restored.wait('保存还没确认')
  expect(restored.element.querySelector<HTMLTextAreaElement>('[aria-label="目标正文草稿"]')?.value).toBe('回应丢失的完整原正文')
  await restored.click('读取当前目标核对'); await restored.wait('回应丢失的完整原正文')
  expect(restored.forwardRpc.mock.calls.some(([method]) => method === 'goal.update')).toBe(false)
  expect(getDeviceWorkface().snapshot().record.goalDrafts?.[0]?.operations[0]?.request).toEqual(request)
})

it.each([false, true])('late mounted/unmounted callback cannot change replacement B with the same original Goal/request (unmounted=%s)', async leave => {
  const view = await existingGoal(); await view.click('编辑目标正文'); await editBody(view, '原A保存正文')
  const normal = vi.mocked(hostGoals.demands.update).getMockImplementation()!
  let settle!: () => void
  vi.mocked(hostGoals.demands.update).mockImplementationOnce(async (...args) => { const receipt = await normal(...args); return await new Promise(resolve => { settle = () => resolve(receipt) }) })
  await saveBody(view); await vi.waitFor(() => expect(settle).toBeTypeOf('function'), { timeout: 5000 })
  const original = getDeviceWorkface().snapshot().record
  await getDeviceWorkface().replaceBackup({ ...original, selectedSessionId: 'B-original-session', goalDrafts: original.goalDrafts!.map(value => ({ ...value, description: 'B草稿绝不由A回执覆盖' })) })
  const before = localStorage.getItem(DEVICE_WORKFACE_KEY)
  if (leave) await unmount(view)
  await act(async () => settle())
  expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe(before)
  expect(getDeviceWorkface().snapshot().record.goalDrafts?.[0]?.description).toBe('B草稿绝不由A回执覆盖')
  expect(getDeviceWorkface().snapshot().record.goalDrafts?.[0]?.operations).toHaveLength(1)
})

it.each(['runtime', 'instance', 'both'])('same client %s rebind refuses a late A response without settling its exact original device request', async kind => {
  const view = await existingGoal(); await view.click('编辑目标正文'); await editBody(view, '同client的原A正文')
  const normal = vi.mocked(hostGoals.demands.update).getMockImplementation()!
  let settle!: () => void
  vi.mocked(hostGoals.demands.update).mockImplementationOnce(async (...args) => { const receipt = await normal(...args); return await new Promise(resolve => { settle = () => resolve(receipt) }) })
  await saveBody(view); await vi.waitFor(() => expect(settle).toBeTypeOf('function'), { timeout: 5000 })
  const before = localStorage.getItem(DEVICE_WORKFACE_KEY)
  view.client.runtimeOwnerIdentity = () => ({ runtimeId: kind === 'instance' ? 'private-goal-runtime' : 'different-runtime', ownerInstanceId: kind === 'runtime' ? 'original-goal-process' : 'different-process', availability: 'connected' })
  await act(async () => settle())
  await vi.waitFor(async () => { await act(async () => {}); expect(view.buttons('保存正文')[0]?.disabled).toBe(false) })
  expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe(before)
  expect(view.element.textContent).not.toContain('目标已保存。')
  expect(getDeviceWorkface().snapshot().record.goalDrafts?.[0]?.operations).toHaveLength(1)
  await saveBody(view)
  const writes = view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.update')
  if (kind === 'instance') {
    // A later explicit save to the same durable Runtime is a new operation;
    // it cannot acknowledge or remove the original process's unknown request.
    expect(writes).toHaveLength(2)
    expect(writes[1]![1].operationId).not.toBe(writes[0]![1].operationId)
    expect(getDeviceWorkface().snapshot().record.goalDrafts?.[0]?.operations[0]?.request).toEqual(writes[0]![1])
    await view.wait('保存还没确认')
    expect(view.element.textContent).not.toContain('目标已保存。')
    expect(getDeviceWorkface().snapshot().record.goalDrafts?.[0]?.operations).toHaveLength(2)
  } else {
    expect(writes).toHaveLength(1)
    expect(view.element.textContent).toContain('保存未发送')
  }
})

it('actual successful writer plus settlement quota failure preserves the full original unknown request in device export without resending', async () => {
  const view = await existingGoal(); await view.click('编辑目标正文'); await editBody(view, 'Host确认但设备回执写入失败的正文')
  const write = localStorage.setItem.bind(localStorage)
  const set = vi.spyOn(localStorage, 'setItem').mockImplementation((key, bytes) => {
    const record = JSON.parse(bytes)
    if (key === DEVICE_WORKFACE_KEY && record.goalDrafts?.some((value: any) => value.description === 'Host确认但设备回执写入失败的正文' && value.operations.length === 0)) throw new Error('Settlement quota failure')
    write(key, bytes)
  })
  await saveBody(view); await view.wait('这台手机还没记下确认')
  const calls = view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.update')
  expect(calls).toHaveLength(1)
  const request = calls[0]![1]
  expect((await owner.get('original-goal'))!.description).toBe(request.patch.description)
  const exported = getDeviceWorkface().parseBackup(getDeviceWorkface().exportBackup())
  const operations = [...(exported.goalDrafts ?? []), ...(exported.goalDraftConflicts ?? [])].flatMap(value => value.operations)
  expect(operations).toContainEqual({ request, ownerInstanceId: 'original-goal-process', phase: 'unknown', issue: expect.stringContaining('这台手机还没记下确认') })
  expect(view.element.querySelector<HTMLTextAreaElement>('[aria-label="目标正文草稿"]')?.value).toBe(request.patch.description)
  await view.render(false); await view.render(true)
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.update')).toHaveLength(1)
  set.mockRestore()
})

it('same-key device conflict has an explicit recovery even when the Host version is unchanged, preserving both original requests', async () => {
  const view = await existingGoal(); await view.click('编辑目标正文'); await editBody(view, '本页先前正文')
  const original = getDeviceWorkface().snapshot().record.goalDrafts![0]!
  const request = freezeMobileGoalUpdateRequest({ goalId: original.goalId, operationId: 'other-page-original-op', expectedUpdatedAt: original.baseline.updatedAt, patch: { description: '另一页原正文' } })
  const peer = new DeviceWorkfaceStore(() => localStorage)
  const canonical = { ...original, description: '另一页原正文', operations: [{ request, ownerInstanceId: 'original-goal-process', phase: 'unknown' as const, issue: '另一页回应未知' }] }
  await peer.editGoalDraft(original, canonical, peer.recordIdentity())
  await editBody(view, '本页冲突后完整正文'); await view.wait('另一个页面已保存这份草稿')
  expect(view.buttons('采用已读新版本；下次保存当前草稿将覆盖该版本')).toHaveLength(0)
  expect(view.forwardRpc.mock.calls.some(([method]) => method === 'goal.update')).toBe(false)
  await view.click('保留本页正文和两边的请求')
  await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.goalDrafts![0]!.description).toBe('本页冲突后完整正文'))
  expect(getDeviceWorkface().snapshot().record.goalDrafts![0]!.operations[0]!.request).toEqual(request)
  expect(getDeviceWorkface().snapshot().record.goalDraftConflicts).toEqual(expect.arrayContaining([expect.objectContaining({ description: '本页冲突后完整正文' })]))
  expect(view.forwardRpc.mock.calls.some(([method]) => method === 'goal.update')).toBe(false)
})

it('record replacement during durable settlement leaves the complete request visible only in the original mounted page', async () => {
  const view = await existingGoal(); await view.click('编辑目标正文'); await editBody(view, '等待设备结算的原正文')
  const device = getDeviceWorkface(), edit = device.editGoalDraft.bind(device)
  let release!: () => void
  vi.spyOn(device, 'editGoalDraft').mockImplementation(async (...args) => {
    if (args[0]?.operations.length && !args[1].operations.length) await new Promise<void>(resolve => { release = resolve })
    return edit(...args)
  })
  await saveBody(view); await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const request = view.forwardRpc.mock.calls.find(([method]) => method === 'goal.update')![1]
  await device.replaceBackup({ ...emptyDeviceWorkface(), selectedSessionId: 'replacement-B' })
  const before = localStorage.getItem(DEVICE_WORKFACE_KEY)
  await act(async () => release()); await view.wait('这次确认没有写入新记录')
  expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe(before)
  expect(device.snapshot().record.goalDrafts).toBeUndefined()
  expect(view.element.textContent).toContain(request.operationId)
  expect(view.element.textContent).toContain(JSON.stringify(request.patch.description))
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.update')).toHaveLength(1)
})

it('unrelated same-record conversation/navigation edits preserve the normal original Goal response and both bodies', async () => {
  const view = await existingGoal(); await view.click('编辑目标正文'); await editBody(view, '正常原Goal正文')
  const device = getDeviceWorkface(), token = device.recordIdentity(), normal = vi.mocked(hostGoals.demands.update).getMockImplementation()!
  let settle!: () => void
  vi.mocked(hostGoals.demands.update).mockImplementationOnce(async (...args) => { const receipt = await normal(...args); return await new Promise(resolve => { settle = () => resolve(receipt) }) })
  await saveBody(view); await vi.waitFor(() => expect(settle).toBeTypeOf('function'), { timeout: 5000 })
  await device.editConversation([{ bucket: 'drafts', key: 'other-conversation', next: '同记录原未发会话正文' }], token)
  await device.updateNavigation({ selectedSessionId: 'another-session', hostUrl: '', panel: 'terminal' })
  await act(async () => settle()); await view.wait('目标已保存。')
  const record = new DeviceWorkfaceStore(() => localStorage).snapshot().record
  expect(record.recordId).toBe(token); expect(record.conversation.drafts).toEqual([['other-conversation', '同记录原未发会话正文']])
  expect(record.selectedSessionId).toBe('another-session'); expect(record.goalDrafts?.[0]?.operations).toEqual([])
})

it('cold remount restores unknown creation from durable device bytes and reads its original operation without creating', async () => {
  vi.mocked(hostGoals.demands.create).mockImplementationOnce(async (...args) => { await owner.create(...args); throw new Error('Durable creation ACK unknown') })
  const first = await mount(); await first.click('新建目标'); await first.click('创建目标'); await first.wait('Durable creation ACK unknown')
  const input = first.forwardRpc.mock.calls.find(([method]) => method === 'goal.create')![1]
  const bytes = localStorage.getItem(DEVICE_WORKFACE_KEY)!
  expect(new DeviceWorkfaceStore(() => localStorage).snapshot().record.goalIntents).toMatchObject([{ operationId: input.operationId, kind: 'create', phase: 'unknown' }])
  await unmount(first)
  const restored = await mount(); await restored.wait('还不确定目标是否已创建')
  expect(restored.element.textContent).toContain(input.operationId); await restored.click('新建目标'); expect(restored.buttons('创建目标')[0]!.disabled).toBe(true)
  expect(restored.forwardRpc.mock.calls.some(([method]) => method === 'goal.create')).toBe(false)
  expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe(bytes)
  await restored.click('读取同一目标核对'); await restored.wait(discussionName)
  expect(restored.forwardRpc).toHaveBeenCalledWith('goal.inspect', { creationOperationId: input.operationId })
  expect(restored.forwardRpc.mock.calls.some(([method]) => method === 'goal.create')).toBe(false)
  expect(await owner.list()).toHaveLength(1)
})

it('cold remount keeps human acknowledgement unknown as an owner guard until explicit reading', async () => {
  const first = await existingGoal(); vi.mocked(hostGoals.demands.confirmAlignment).mockRejectedValueOnce(new Error('Uncertain human acknowledgement'))
  await first.click('确认当前目标'); await first.wait('Uncertain human acknowledgement')
  await unmount(first)
  const restored = await mount(); await restored.wait('Actual goal'); await restored.click('Actual goal未分配项目 · 待整理')
  expect(restored.buttons('确认当前目标')).toHaveLength(0)
  expect(restored.element.textContent).toContain('还不确定你的确认是否已生效')
  expect(restored.forwardRpc.mock.calls.some(([method]) => method === 'goal.confirm')).toBe(false)
  await restored.click('读取当前提案与报告'); await restored.wait('已读取当前目标')
  expect(restored.buttons('确认当前目标')).toHaveLength(1)
  expect(restored.forwardRpc.mock.calls.some(([method]) => method === 'goal.confirm')).toBe(false)
  await restored.click('确认当前目标'); await restored.wait('已确认读过的当前目标提案')
  expect((await owner.get('original-goal'))!.alignment!.confirmedAt).toBeGreaterThan(0)
})

it('late original discussion receipt after leaving Goals preserves its Tab without taking phone navigation', async () => {
  const view = await existingGoal(), forward = view.forwardRpc.getMockImplementation()!
  let settle!: () => void
  view.forwardRpc.mockImplementation((method, params) => method === 'goal.discuss' ? forward(method, params).then(result => new Promise(resolve => { settle = () => resolve(result) })) : forward(method, params))
  await view.click('打开目标讨论'); await vi.waitFor(() => expect(settle).toBeTypeOf('function'), { timeout: 5000 })
  await view.render(false); await view.render(true); await act(async () => settle())
  expect(view.openSession).not.toHaveBeenCalled(); expect(view.buttons('返回目标')).toHaveLength(0)
  expect(view.forwardRpc.mock.calls.some(([method]) => method === 'space.inspect')).toBe(false)
  expect(discussions.get('original-goal')).toBeDefined()
})

it('late creation completion after leaving Goals never selects or presents the original new goal', async () => {
  let settle!: () => void
  vi.mocked(hostGoals.demands.create).mockImplementationOnce(async (...args) => {
    const receipt = await owner.create(...args); return await new Promise(resolve => { settle = () => resolve(receipt) })
  })
  const view = await mount(); await view.click('新建目标'); await view.click('创建目标'); await vi.waitFor(() => expect(settle).toBeTypeOf('function'), { timeout: 5000 })
  await view.render(false); await view.render(true); await act(async () => settle())
  await vi.waitFor(() => expect(view.forwardRpc.mock.calls.some(([method]) => method === 'goal.discuss')).toBe(true))
  await act(async () => {}); await view.render(true)
  expect(view.buttons('返回目标列表')).toHaveLength(0); expect(view.buttons('返回目标')).toHaveLength(0); expect(view.openSession).not.toHaveBeenCalled()
  expect(view.forwardRpc.mock.calls.some(([method]) => method === 'space.inspect')).toBe(false)
  expect(await owner.list()).toHaveLength(1)
})

it('a creation reply from the previous Runtime waits for that owner to be connected again', async () => {
  let settle!: () => void
  vi.mocked(hostGoals.demands.create).mockImplementationOnce(async (...args) => {
    const receipt = await owner.create(...args)
    return await new Promise(resolve => { settle = () => resolve(receipt) })
  })
  const view = await mount()
  const identity = view.client.runtimeOwnerIdentity
  await view.click('新建目标'); await view.click('创建目标')
  await vi.waitFor(() => expect(settle).toBeTypeOf('function'))
  const input = view.forwardRpc.mock.calls.find(([method]) => method === 'goal.create')![1]
  view.client.runtimeOwnerIdentity = () => ({ ...identity(), runtimeId: 'other-runtime' })
  await act(async () => settle())
  await view.wait('这个请求来自另一台 Mac')
  expect(getDeviceWorkface().snapshot().record.goalIntents).toEqual([expect.objectContaining({
    runtimeId: creationRuntime, operationId: input.operationId, phase: 'unknown'
  })])
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.discuss')).toEqual([])
  expect(view.openSession).not.toHaveBeenCalled()

  view.client.runtimeOwnerIdentity = identity
  await view.click('读取同一目标核对'); await view.wait(discussionName)
  expect(view.forwardRpc).toHaveBeenCalledWith('goal.inspect', { creationOperationId: input.operationId })
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.create')).toHaveLength(1)
})

it('late old acknowledgement-recovery read never replaces a newer displayed proposal or clears its guard', async () => {
  const view = await existingGoal(); vi.mocked(hostGoals.demands.confirmAlignment).mockRejectedValueOnce(new Error('Human result unknown'))
  await view.click('确认当前目标'); await view.wait('Human result unknown')
  const forward = view.forwardRpc.getMockImplementation()!, old = await forward('goal.inspect', { goalId: 'original-goal' })
  let settle!: () => void
  view.forwardRpc.mockImplementationOnce(() => new Promise(resolve => { settle = () => resolve(old) }))
  await view.click('读取当前提案与报告')
  await owner.update('original-goal', { alignment: { ...proposal, summary: 'New current owner proposal' } })
  await view.click('刷新目标'); await view.wait('New current owner proposal')
  await act(async () => settle()); await view.wait('迟到旧读取不能代签当前内容')
  expect(view.element.textContent).toContain('New current owner proposal'); expect(view.buttons('确认当前目标')).toHaveLength(0)
  expect(getDeviceWorkface().snapshot().record.goalIntents).toHaveLength(1)
  await view.click('读取当前提案与报告'); await view.wait('已读取当前目标')
  expect(view.buttons('确认当前目标')).toHaveLength(1)
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.confirm')).toHaveLength(1)
})

it('device intent I/O failure preserves prior bytes and memory without gating healthy creation', async () => {
  const view = await mount(), before = localStorage.getItem(DEVICE_WORKFACE_KEY)
  const set = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Device write failed') })
  await view.click('新建目标'); await view.click('创建目标'); await view.wait(discussionName)
  expect(set).toHaveBeenCalled(); expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe(before)
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.create')).toHaveLength(1); expect(await owner.list()).toHaveLength(1)
  expect(view.element.textContent).toContain('刷新保障不足'); expect(getDeviceWorkface().exportBackup()).toContain('goalIntents')
  set.mockRestore(); await getDeviceWorkface().replaceUnreadableWithCurrent()
  expect(getDeviceWorkface().snapshot().issue).toBeNull()
})

it('device intent I/O failure keeps human acknowledgement and its unknown recovery available in memory', async () => {
  const view = await existingGoal(), before = localStorage.getItem(DEVICE_WORKFACE_KEY)
  const set = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Device write failed') })
  vi.mocked(hostGoals.demands.confirmAlignment).mockRejectedValueOnce(new Error('Real human receipt unknown'))
  await view.click('确认当前目标'); await view.wait('Real human receipt unknown')
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.confirm')).toHaveLength(1)
  expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe(before); expect(view.element.textContent).toContain('刷新保障不足')
  expect(getDeviceWorkface().exportBackup()).toContain('expectedRevision'); expect(view.buttons('确认当前目标')).toHaveLength(0)
  await view.click('读取当前提案与报告'); await view.wait('已读取当前目标')
  await view.click('确认当前目标'); await view.wait('已确认读过的当前目标提案')
  expect((await owner.get('original-goal'))!.alignment!.confirmedAt).toBeGreaterThan(0)
  expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe(before); set.mockRestore(); await getDeviceWorkface().replaceUnreadableWithCurrent()
})

it('explicit creation uses the current Host domain and strict public service to present the owner-issued ID and its exact discussion receipt', async () => {
  const view = await mount(); await view.click('新建目标'); await view.click('创建目标')
  const creation = view.forwardRpc.mock.calls.findIndex(([method]) => method === 'goal.create')
  expect(creation, view.element.textContent ?? '').toBeGreaterThanOrEqual(0)
  const input = view.forwardRpc.mock.calls[creation]![1]
  await act(async () => { await view.forwardRpc.mock.results[creation]!.value })
  const created = await view.forwardRpc.mock.results[creation]!.value
  await vi.waitFor(() => expect(view.element.textContent).toContain(discussionName), { timeout: 2000 })
  const goalId = (await owner.originalGoalCreationId(input.operationId))!
  expect(input).not.toHaveProperty('goalId')
  expect(input).toMatchObject({ title: 'Untitled goal', description: '', status: 'backlog' })
  expect(input).not.toHaveProperty('projectId')
  const saved = (await openDemandStore({ root: join(directory, 'demands') }).get(goalId))!
  expect(saved).toMatchObject({ id: goalId, projectId: null, description: '', sessionIds: [], creationOrigin: {
    operationId: input.operationId, inputRuntimeId: creationRuntime, inputEpoch: creationInputEpoch
  } }); expect(saved.alignment).toBeUndefined(); expect(saved.grounding).toBeUndefined()
  expect(created).toMatchObject({ goal: { id: goalId, address: { runtimeId: creationRuntime, creationOperationId: input.operationId, goalUrl: `amux://goal/${goalId}` } }, receipt: { goalId } })
  expect(view.forwardRpc).toHaveBeenCalledWith('goal.discuss', { goalId, mode: 'grill', operationId: expect.any(String) })
  const tabId = discussions.get(goalId)!.tabId
  expect(view.forwardRpc).toHaveBeenCalledWith('space.inspect', { target: { tabId }, presentation: 'status' },
    expect.objectContaining({ signal: expect.any(AbortSignal) }))
  expect([...discussions.values()].map(value => value.tabId)).toEqual([tabId]); expect(await owner.list()).toHaveLength(1)
  expect(view.forwardRpc.mock.calls.some(([method]) => method === 'goal.start')).toBe(false)
  expect(view.openSession).toHaveBeenCalledExactlyOnceWith(discussions.get(goalId)!.sessionId, expect.objectContaining({ project: '未分配项目' }))
  await view.click('返回目标'); expect(view.element.querySelector('article h2')?.textContent).toBe('Untitled goal')
})

it('unknown save reads the creation operation against the real owner before discussion and never creates again across hide/show', async () => {
  vi.mocked(hostGoals.demands.create).mockImplementationOnce(async (...args) => { await owner.create(...args); throw new Error('Creation ACK lost') })
  const view = await mount(); await view.click('新建目标'); await view.click('创建目标'); await view.wait('Creation ACK lost')
  const input = view.forwardRpc.mock.calls.find(([method]) => method === 'goal.create')![1]
  const goalId = (await owner.originalGoalCreationId(input.operationId))!
  await view.render(false); await view.render(true); expect(view.buttons('创建目标')[0]!.disabled).toBe(true); await view.click('创建目标')
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.create')).toHaveLength(1)
  expect(view.forwardRpc.mock.calls.some(([method]) => method === 'goal.discuss')).toBe(false)
  await view.click('读取同一目标核对'); await view.wait(discussionName)
  expect(view.forwardRpc).toHaveBeenCalledWith('goal.inspect', { creationOperationId: input.operationId })
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.create')).toHaveLength(1)
  expect((await owner.list()).map(goal => goal.id)).toEqual([goalId])
})

it('owner-confirmed absence only allows explicit saving of the same original operation', async () => {
  vi.mocked(hostGoals.demands.create).mockRejectedValueOnce(new Error('No save acknowledgement'))
  const view = await mount(); await view.click('新建目标'); await view.click('创建目标'); await view.wait('No save acknowledgement')
  const input = view.forwardRpc.mock.calls.find(([method]) => method === 'goal.create')![1]
  await view.click('读取同一目标核对'); await view.wait('Mac 上还没有这个目标')
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.create')).toHaveLength(1)
  await view.click('明确保存同一目标'); await view.wait(discussionName)
  const creations = view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.create')
  expect(creations.map(([, params]) => params.operationId)).toEqual([input.operationId, input.operationId])
  expect(await owner.list()).toHaveLength(1)
})

it.each([false, true])('reads an older device creation by its retained operation and never sends its caller ID (saved=%s)', async saved => {
  const goalId = 'old-phone-issued-goal', operationId = 'original-phone-create'
  const input = { goalId, operationId, title: 'Original phone draft', description: 'Keep this original intent.',
    status: 'backlog', risk: 'low', confirmation: 'user' } as const
  if (saved) await seedStoredDemand(owner, { id: goalId, title: input.title, description: input.description }, { operationId,
    discussionOperationId: 'original-goal-discussion', creationOrigin: { inputRuntimeId: creationRuntime, requesterAsSupervisor: false } })
  const device = getDeviceWorkface(), unrelatedSession = 'unchanged-original-conversation'
  const record = emptyDeviceWorkface()
  const conversation: typeof record.conversation = { ...record.conversation, drafts: [[unrelatedSession, 'Keep this unrelated draft']] }
  await device.replaceBackup({ ...record, selectedSessionId: unrelatedSession, conversation, goalIntents: [{
    kind: 'create', phase: 'unknown', runtimeId: creationRuntime, deviceHostId: null, operationId, goalId, input
  }] })
  const originalBytes = localStorage.getItem(DEVICE_WORKFACE_KEY)
  const view = await mount(); await view.wait('还不确定目标是否已创建')
  expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe(originalBytes)
  await view.click('读取同一目标核对')
  expect(view.forwardRpc).toHaveBeenCalledWith('goal.inspect', { creationOperationId: operationId })
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.create')).toEqual([])
  if (!saved) {
    await view.wait('Mac 上还没有这个目标')
    await view.click('明确保存同一目标')
    await vi.waitFor(() => {
      const creates = view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.create')
      expect(creates).toHaveLength(1)
      expect(creates[0]![1]).not.toHaveProperty('goalId')
    })
  }
  await view.wait(discussionName)
  const actual = (await owner.originalGoalCreationId(operationId))!
  if (saved) expect(actual).toBe(goalId)
  else expect(actual).not.toBe(goalId)
  expect(view.forwardRpc).toHaveBeenCalledWith('goal.discuss', { goalId: actual, mode: 'grill', operationId: expect.any(String) })
  expect(await owner.list()).toHaveLength(1)
  expect(device.snapshot().record.selectedSessionId).toBe(unrelatedSession)
  expect(device.snapshot().record.conversation).toEqual(conversation)
})

it('an unavailable discussion owner retains the saved goal and explicit reopening uses its original ID without recreating', async () => {
  discussionUnavailable = true
  const view = await mount(); await view.click('新建目标'); await view.click('创建目标'); await view.wait('Original discussion owner is unavailable')
  const input = view.forwardRpc.mock.calls.find(([method]) => method === 'goal.create')![1]
  const goalId = (await owner.originalGoalCreationId(input.operationId))!
  expect(await owner.get(goalId)).not.toBeNull(); expect(view.element.textContent).toContain('目标已保存，讨论还没确认')
  discussionUnavailable = false
  await view.click('打开这个目标的讨论'); await view.wait(discussionName)
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.create')).toHaveLength(1)
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.discuss').map(([, params]) => params.goalId)).toEqual([goalId, goalId])
})

it('human confirmation unknown keeps normal acknowledgement unavailable until explicit current-owner reading', async () => {
  const view = await existingGoal()
  vi.mocked(hostGoals.demands.confirmAlignment).mockImplementationOnce(async (id, revision) => { await owner.confirmAlignment(id, revision); throw new Error('Human ACK lost') })
  await view.click('确认当前目标'); await view.wait('Human ACK lost')
  expect(view.buttons('确认当前目标')).toHaveLength(0)
  expect(view.buttons('打开目标讨论')[0]!.disabled).toBe(false)
  await view.render(false); await view.render(true); expect(view.buttons('确认当前目标')).toHaveLength(0)
  await view.click('读取当前提案与报告'); await view.wait('已读取当前目标')
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.confirm')).toHaveLength(1)
  expect(view.element.textContent).toContain('Human ACK lost'); expect((await owner.get('original-goal'))!.alignment!.confirmedAt).toBeGreaterThan(0)
})

it('the mounted Goal summary attributes its current confirmation to the exact Agent', async () => {
  const view = await existingGoal()
  const agent = { kind: 'agent', id: 'original-supervisor-agent', hostId: 'original-signing-host', runtimeId: 'original-signing-runtime' } as const
  expect(view.buttons('确认当前目标')).toHaveLength(1)
  await owner.confirmAlignment('original-goal', 1, undefined, { operationId: 'original-agent-confirmation', author: agent })
  await view.click('刷新目标'); await view.wait(`由 Agent ${agent.id} 确认`)
  const summary = view.element.querySelector('section[aria-label="目标与成功标准"]')!
  const identity = summary.querySelector('details')!
  expect(identity.querySelector('summary')?.textContent).toBe('确认者信息')
  expect([...identity.querySelectorAll('dd')].map(value => value.textContent)).toEqual([agent.hostId, agent.runtimeId])
  expect(view.buttons('确认当前目标')).toHaveLength(0)
})

it('late confirmation acknowledgement never replaces a newer owner proposal already displayed', async () => {
  const view = await existingGoal()
  let settle!: (value: any) => void
  vi.mocked(hostGoals.demands.confirmAlignment).mockImplementationOnce(async (id, revision) => {
    const receipt = await owner.confirmAlignment(id, revision)
    return await new Promise(resolve => { settle = () => resolve(receipt) })
  })
  await view.click('确认当前目标'); await vi.waitFor(() => expect(settle).toBeTypeOf('function'), { timeout: 5000 })
  await owner.update('original-goal', { alignment: { ...proposal, summary: 'Newer proposal actually read' } })
  await view.click('刷新目标'); await view.wait('Newer proposal actually read')
  await act(async () => settle(undefined)); await view.wait('现在有更新的提案')
  expect(view.element.textContent).toContain('Newer proposal actually read'); expect(view.buttons('确认当前目标')).toHaveLength(1)
})

it('actual gap acceptance keeps the exact submission and reported difference', async () => {
  await seedStoredDemand(owner, { id: 'original-goal', title: 'Actual goal' }); await owner.update('original-goal', { alignment: proposal }); await owner.confirmAlignment('original-goal', 1)
  await owner.update('original-goal', { grounding: { alignmentRevision: 1, summary: 'Checked result with gap', checks: [{ criterionId: 'c', outcome: 'gap', evidence: ['actual.log'], note: 'A real difference remains' }] } })
  const submission = (await owner.get('original-goal'))!.grounding!.submissionId
  const view = await mount(); await view.wait('Actual goal'); await view.click('Actual goal未分配项目 · 待整理'); await view.wait('Checked result with gap')
  expect(view.buttons('接受当前结果')).toHaveLength(0)
  await view.click('接受结果并保留差距'); await view.wait('已验收并保留差距。')
  expect(view.forwardRpc).toHaveBeenCalledWith('goal.accept', { goalId: 'original-goal', expectedAlignmentRevision: 1, expectedSubmissionId: submission, acceptGaps: true, operationId: expect.any(String) })
  expect((await owner.get('original-goal'))!.grounding).toMatchObject({ submissionId: submission, acceptedAt: expect.any(Number), checks: [{ outcome: 'gap', note: 'A real difference remains', criterionId: 'c', evidence: ['actual.log'] }] })
})


it('mobile discussion actions retain grill and grounding modes on the same exact Host discussion binding', async () => {
  const view = await existingGoal()
  await view.click('讨论目标变更'); await view.wait(discussionName)
  expect(view.forwardRpc).toHaveBeenCalledWith('goal.discuss', { goalId: 'original-goal', mode: 'grill', operationId: expect.any(String) })
  const tabId = discussions.get('original-goal')!.tabId
  await view.click('返回目标'); await view.click('确认当前目标'); await view.wait('已确认读过的当前目标提案')
  await view.click('请求核对结果'); await view.wait(discussionName)
  expect(view.forwardRpc).toHaveBeenCalledWith('goal.discuss', { goalId: 'original-goal', mode: 'grounding', operationId: expect.any(String) })
  expect(discussions.get('original-goal')?.tabId).toBe(tabId)
  expect((await owner.get('original-goal'))!.grounding).toBeUndefined()
  expect(discussions.get('original-goal')?.regionId).toBe('discussion-region:original-goal')
})


it('current human stage action follows evidence before secondary discussion and low-frequency properties', async () => {
  const view = await existingGoal()
  const article = view.element.querySelector('article')!, section = article.querySelector('[aria-label="目标确认与讨论"]')!
  const evidence = article.querySelector('[aria-label="结果与证据"]')!, properties = [...article.querySelectorAll('summary')].find(node => node.textContent === '工作状态与属性')!
  expect(evidence.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(section.compareDocumentPosition(properties) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const confirm = view.buttons('确认当前目标')[0]!, discuss = view.buttons('打开目标讨论')[0]!
  expect(confirm.compareDocumentPosition(discuss) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})


it('late original creation recovery read cannot replace another Goal selected while reading', async () => {
  await seedStoredDemand(owner, { id: 'goal-b', title: 'Selected later Goal B' })
  vi.mocked(hostGoals.demands.create).mockImplementationOnce(async (...args) => { await owner.create(...args); throw new Error('Create A unknown') })
  const view = await mount(); await view.wait('Selected later Goal B'); await view.click('新建目标'); await view.click('创建目标'); await view.wait('Create A unknown')
  const input = view.forwardRpc.mock.calls.find(([method]) => method === 'goal.create')![1], forward = view.forwardRpc.getMockImplementation()!
  const goalId = (await owner.originalGoalCreationId(input.operationId))!
  let settle!: () => void
  view.forwardRpc.mockImplementation((method, params) => method === 'goal.inspect' && params.creationOperationId === input.operationId ? forward(method, params).then(result => new Promise(resolve => { settle = () => resolve(result) })) : forward(method, params))
  await view.click('读取同一目标核对'); await vi.waitFor(() => expect(settle).toBeTypeOf('function'), { timeout: 5000 })
  await view.click('Selected later Goal B未分配项目 · 待整理')
  await act(async () => settle()); await vi.waitFor(() => expect(discussions.get(goalId)).toBeDefined())
  expect([...view.element.querySelectorAll('article h2')].filter(node => !node.closest('[hidden]')).map(node => node.textContent)).toEqual(['Selected later Goal B'])
  expect(view.buttons('返回目标')).toHaveLength(0); expect(view.openSession).not.toHaveBeenCalled()
  expect((await owner.list()).map(goal => goal.id).sort()).toEqual([goalId, 'goal-b'].sort())
})


it.each([false, true])('mobile exact acceptance keeps the goal open or explicitly finishes it (finish=%s)', async finish => {
  await seedStoredDemand(owner, { id: 'original-goal', title: 'Actual goal', status: 'in_review' })
  await owner.update('original-goal', { alignment: proposal }); await owner.confirmAlignment('original-goal', 1)
  await owner.update('original-goal', { grounding: { alignmentRevision: 1, summary: 'Verified original result', checks: [{ criterionId: 'c', outcome: 'met', evidence: ['proof.log'], note: '' }] } })
  const before = (await owner.get('original-goal'))!
  const view = await mount(); await view.wait('Actual goal'); await view.click('Actual goal未分配项目 · 待检查')
  await view.click(finish ? '接受并结束目标' : '接受当前结果')
  await vi.waitFor(async () => expect((await owner.get('original-goal'))!.grounding!.acceptedAt).not.toBeNull())
  const saved = (await owner.get('original-goal'))!
  expect(saved.status).toBe(finish ? 'done' : 'in_review')
  expect(saved.grounding!.submissionId).toBe(before.grounding!.submissionId)
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.accept')).toHaveLength(1)
  await view.wait(finish ? '已验收，目标已结束。' : '已验收，目标仍开放。')
  expect(useAppStore.getState().sessions).toEqual([])
})


// These brand consumers use MobileApp and the same real public service/Host
// domain/durable store above. Only native Agent execution remains controlled.
it('mobile brand CTA opens the original form without writes and explicitly creates the same project Goal through its owner', async () => {
  directoryProjects = [{ projectId: 'brand-project', name: 'Original workshop project', hostId: 'local', path: scratch.path, kind: 'workspace', repoPath: null, branch: null, activeAgentSessionIds: [] }]
  const view = await mount(undefined, true)
  await view.wait('从一个想法开始')
  expect(await owner.list()).toEqual([])
  expect(view.forwardRpc.mock.calls.filter(([method]) => ['goal.create', 'goal.discuss'].includes(method))).toEqual([])
  await view.click('开始新目标')
  const form = view.element.querySelector<HTMLElement>('.mobile-goal-create__form')!
  expect(form.hasAttribute('hidden'), 'the brand CTA expands the original creation owner').toBe(false)
  expect(view.element.querySelector('.mobile-goals-start__create'), 'the expanded form has one primary submission').toBeNull()
  const project = form.querySelector<HTMLSelectElement>('[aria-label="新目标项目"]')!
  expect(document.activeElement).toBe(project)
  await act(async () => { project.value = 'brand-project'; project.dispatchEvent(new Event('change', { bubbles: true })) })
  await view.click('新建目标'); await view.click('开始新目标')
  expect(form.querySelector<HTMLSelectElement>('[aria-label="新目标项目"]')!.value).toBe('brand-project')
  expect(document.activeElement).toBe(project)
  expect(view.forwardRpc.mock.calls.filter(([method]) => ['goal.create', 'goal.discuss'].includes(method))).toEqual([])
  expect(view.sdk!.submit).not.toHaveBeenCalled(); expect(view.sdk!.rejoinInput).not.toHaveBeenCalled()
  await view.click('创建目标')
  await vi.waitFor(async () => expect(await owner.list()).toHaveLength(1))
  const input = view.forwardRpc.mock.calls.find(([method]) => method === 'goal.create')![1]
  const goalId = (await owner.originalGoalCreationId(input.operationId))!
  const saved = await openDemandStore({ root: join(directory, 'demands') }).get(goalId)
  expect(saved).toMatchObject({ id: goalId, projectId: 'brand-project', projectName: 'Original workshop project', description: '', sessionIds: [] })
  await vi.waitFor(() => expect(discussions.has(goalId)).toBe(true))
  expect(view.forwardRpc).toHaveBeenCalledWith('goal.discuss', { goalId, mode: 'grill', operationId: expect.any(String) })
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.create')).toHaveLength(1)
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.discuss')).toHaveLength(1)
  expect(view.sdk!.submit).not.toHaveBeenCalled(); expect(view.sdk!.respond).not.toHaveBeenCalled(); expect(view.sdk!.rejoinInput).not.toHaveBeenCalled()
}, 30000)

it('mobile brand art appears only on the visible Goal directory and current proposal while unknown and filters keep their facts', async () => {
  const reads: Array<(value: any[]) => void> = []
  const list = vi.spyOn(hostGoals.demands, 'list').mockImplementation(() => new Promise(resolve => { reads.push(resolve) }))
  const view = await mount(undefined, true)
  try {
    await view.wait('目标列表尚未确认')
    const art = view.element.querySelector<HTMLImageElement>('.mobile-goals-start__art')!
    expect(art, 'the real MobileApp presents the shared workshop art').not.toBeNull()
    expect(art.hidden, 'the shared brand art is visible').toBe(false)
    expect(art.src).toContain('goals-companions-header.png')
    expect(art.getAttribute('loading')).toBe('lazy'); expect(art.getAttribute('decoding')).toBe('async')
    expect(view.element.querySelector('.mobile-goals-start--empty')).toBeNull()
  } finally {
    list.mockImplementation(() => owner.list())
    await act(async () => { for (const release of reads) release([]) })
  }
  await view.wait('从一个想法开始')
  expect(view.element.querySelector<HTMLImageElement>('.mobile-goals-start--empty img')?.src).toContain('/concepts/goals-companions.png')
  const filter = view.element.querySelector<HTMLSelectElement>('[aria-label="筛选工作状态"]')!
  await seedStoredDemand(owner, { id: 'unfiltered-original-goal', title: 'Original unfiltered Goal', status: 'backlog' })
  const currentGoals = await owner.list()
  let releaseFiltered: ((value: typeof currentGoals) => void) | undefined
  list.mockImplementationOnce(() => new Promise(resolve => { releaseFiltered = resolve }))
  try {
    await act(async () => { filter.value = 'done'; filter.dispatchEvent(new Event('change', { bubbles: true })) })
    await vi.waitFor(() => expect(releaseFiltered).toBeTypeOf('function'))
    expect(view.forwardRpc).toHaveBeenCalledWith('goal.ls', { limit: 1000, status: 'done' })
  } finally {
    await act(async () => { releaseFiltered?.(currentGoals); await Promise.allSettled([...inFlight]) })
  }
  await view.wait('没有匹配的目标')
  expect(view.element.querySelector('.mobile-goals-list li')).toBeNull()
  expect(view.element.querySelector('.mobile-goals-start--empty')).toBeNull()
  let releaseUnfiltered: ((value: typeof currentGoals) => void) | undefined
  list.mockImplementationOnce(() => new Promise(resolve => { releaseUnfiltered = resolve }))
  try {
    await act(async () => { filter.value = ''; filter.dispatchEvent(new Event('change', { bubbles: true })) })
    await vi.waitFor(() => expect(releaseUnfiltered).toBeTypeOf('function'))
    expect(view.forwardRpc).toHaveBeenLastCalledWith('goal.ls', { limit: 1000 })
    expect(view.element.querySelector('.mobile-goals-start--empty'), 'a cached filtered empty result cannot confirm the unfiltered directory while its read is pending').toBeNull()
    expect(view.element.querySelector('.mobile-goals')?.textContent).not.toContain('还没有目标。')
  } finally {
    await act(async () => { releaseUnfiltered?.(currentGoals); await Promise.allSettled([...inFlight]) })
  }
  await view.wait('Original unfiltered Goal')
  expect(view.element.querySelector('.mobile-goals-list li')?.textContent).toContain('Original unfiltered Goal')
  expect(view.element.querySelector('.mobile-goals-start--empty')).toBeNull()
  list.mockRejectedValue(new Error('Original list is unknown'))
  await view.click('刷新目标'); await view.wait('Original list is unknown')
  expect(view.element.querySelector('.mobile-goals-start--empty')).toBeNull()
  const retainedArt = view.element.querySelector<HTMLImageElement>('.mobile-goals-start__art')!
  const goalHost = retainedArt.closest<HTMLElement>('.mobile-goals-host')!
  expect(goalHost.hidden).toBe(false)
  await openPrimary(view.element, 'Focus')
  expect(view.element.querySelector('.mobile-goals-start__art'), 'the original Goal workface retains its brand node').toBe(retainedArt)
  expect(goalHost.hidden, 'the exact Goal host is no longer presented after choosing Focus').toBe(true)
  expect(retainedArt.closest('[hidden]')).toBe(goalHost)
  expect(view.element.querySelector('.mobile-goal-discussion-heading img')).toBeNull()
  expect(view.sdk!.submit).not.toHaveBeenCalled()
}, 30000)

it('mobile brand proposal actions retain the exact Goal owner, draft, confirmation and acceptance with explicit discussion only', async () => {
  await seedStoredDemand(owner, { id: 'brand-original-goal', title: 'Original brand proposal', status: 'in_review' })
  await owner.update('brand-original-goal', { alignment: proposal })
  const view = await mount(undefined, true)
  await view.wait('Original brand proposal')
  await view.click('Original brand proposal未分配项目 · 待检查'); await view.wait(proposal.summary)
  const illustration = view.element.querySelector<HTMLImageElement>('.mobile-goal-discussion-heading img')!
  expect(illustration.src).toContain('demand-dialogue.png'); expect(illustration.getAttribute('loading')).toBe('lazy')
  await view.click('编辑目标正文')
  const draft = view.element.querySelector<HTMLTextAreaElement>('article textarea')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(draft, 'Original unsaved brand draft'); draft.dispatchEvent(new Event('input', { bubbles: true })) })
  await view.click('返回目标正文')
  expect(view.forwardRpc.mock.calls.filter(([method]) => ['goal.discuss', 'goal.confirm', 'goal.accept', 'goal.update'].includes(method))).toEqual([])
  await view.click('讨论目标变更')
  expect(view.forwardRpc).toHaveBeenCalledWith('goal.discuss', { goalId: 'brand-original-goal', mode: 'grill', operationId: expect.any(String) })
  await vi.waitFor(() => expect(discussions.has('brand-original-goal')).toBe(true))
  await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('discussion-agent:brand-original-goal'))
  // The real App opens the original receipt's Session. Return through its
  // directory and reopen the retained Goal rather than reconstructing it.
  await openPrimary(view.element, 'Goals')
  await view.wait(proposal.summary)
  await view.click('编辑目标正文')
  expect(view.element.querySelector<HTMLTextAreaElement>('article textarea')?.value).toBe('Original unsaved brand draft')
  await view.click('返回目标正文')
  vi.mocked(hostGoals.demands.confirmAlignment).mockImplementationOnce(async (id, revision) => { await owner.confirmAlignment(id, revision); throw new Error('Original brand ACK unknown') })
  await view.click('确认当前目标'); await view.wait('Original brand ACK unknown')
  expect(view.forwardRpc).toHaveBeenCalledWith('goal.confirm', { goalId: 'brand-original-goal', expectedRevision: 1, operationId: expect.any(String) })
  const pending = getDeviceWorkface().snapshot().record.goalIntents!
  expect(pending).toMatchObject([{ goalId: 'brand-original-goal', kind: 'confirm', phase: 'unknown' }])
  expect(view.buttons('读取当前提案与报告')).toHaveLength(1)
  await view.click('读取当前提案与报告'); await view.wait('已读取当前目标')
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.confirm')).toHaveLength(1)
  await owner.update('brand-original-goal', { grounding: { alignmentRevision: 1, summary: 'Original checked brand result', checks: [{ criterionId: 'c', outcome: 'met', evidence: ['proof.log'], note: '' }] } })
  await view.click('刷新目标'); await view.wait('Original checked brand result')
  const submission = (await owner.get('brand-original-goal'))!.grounding!.submissionId
  await view.click('接受当前结果'); await view.wait('已验收，目标仍开放')
  expect(view.forwardRpc).toHaveBeenCalledWith('goal.accept', { goalId: 'brand-original-goal', expectedAlignmentRevision: 1, expectedSubmissionId: submission, acceptGaps: false, operationId: expect.any(String) })
  expect((await owner.get('brand-original-goal'))!.grounding!.acceptedAt).not.toBeNull()
  expect(view.sdk!.submit).not.toHaveBeenCalled(); expect(view.sdk!.respond).not.toHaveBeenCalled(); expect(view.sdk!.rejoinInput).not.toHaveBeenCalled()
}, 30000)
