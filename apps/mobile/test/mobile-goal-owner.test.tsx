import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fixturePath } from '../../../test/fixture-values.mjs'
import './mobile-lan-crypto.setup'
import { mkdtemp, rm } from 'node:fs/promises'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { openDemandStore } from '@agentmux/demand'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { api } from '../../desktop/src/renderer/src/lib/api'
import { useAppStore } from '../../desktop/src/renderer/src/store'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID } from '../../desktop/src/shared/scratch-topics'
import { MobileGoalsSurface } from '../src/goals/MobileGoalsSurface'
import { getDeviceWorkface, emptyDeviceWorkface, DEVICE_WORKFACE_KEY, DeviceWorkfaceStore } from '../src/recovery/device-workface'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const baseline = useAppStore.getState()
let directory: string, owner: ReturnType<typeof openDemandStore>
const mounts: { root: Root; element: HTMLDivElement }[] = []
const scratch = { id: SCRATCH_WORKSPACE_ID, name: 'Main Mote', hostId: 'local', path: fixturePath("private-topic-fixture"), kind: 'scratch' as const }
const config = { ...baseline.config, version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }], workspaces: [scratch], executors: {} } as any
const topic = { id: PMO_TEAMS_TOPIC_ID, title: 'Main Mote', summary: '', directoryPath: 'main-mote', topicPath: 'main-mote/Topic.md', collaborators: [], soul: { path: 'SOUL.md', content: '', version: '1' } }
const proposal = { summary: 'Read real current proposal', criteria: [{ id: 'c', text: 'Original criterion' }], openQuestions: [] }
beforeEach(async () => {
  localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
  directory = await mkdtemp(join(tmpdir(), 'mgoal-')); owner = openDemandStore({ root: directory })
  useAppStore.setState({ ...baseline, config, sessions: [], tabs: {}, layouts: {}, demandPmoTabIds: {}, demands: {} }, true)
  vi.spyOn(api.demands, 'create').mockImplementation(input => owner.create(input))
  vi.spyOn(api.demands, 'list').mockImplementation(() => owner.list())
  vi.spyOn(api.demands, 'update').mockImplementation((id, patch) => owner.update(id, patch))
  vi.spyOn(api.demands, 'decision').mockImplementation((id, input) => owner.addDecision(id, input))
  vi.spyOn(api.demands, 'activity').mockImplementation((id, input) => owner.addActivity(id, input))
  vi.spyOn(api.demands, 'confirmAlignment').mockImplementation((id, revision) => owner.confirmAlignment(id, revision))
  vi.spyOn(api.demands, 'acceptGrounding').mockImplementation((id, revision, submission, gaps) => owner.acceptGrounding(id, revision, submission, gaps))
  vi.spyOn(api.continuousProgress, 'goals').mockResolvedValue([])
  vi.spyOn(api.scratch, 'ensureTopic').mockResolvedValue(topic as never)
  vi.spyOn(api.scratch, 'readTopic').mockResolvedValue(topic as never)
})
afterEach(async () => {
  for (const view of mounts.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  vi.restoreAllMocks(); useAppStore.setState(baseline, true); await rm(directory, { recursive: true, force: true })
})
async function mount() {
  const service = new AgentMuxRpcService({ execute: request => useAppStore.getState().executeControl(request), coreClients: () => [], snapshot: async () => ({ projects: [], executors: [] }) })
  const forwardRpc = vi.fn((method: any, params: any) => service.call(method, params, { principal: { kind: 'device', id: 'approved-phone' } }))
  const client = { forwardRpc, runtimeOwnerIdentity: () => ({ runtimeId: 'private-goal-runtime', availability: 'connected' }) } as any, element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); mounts.push({ root, element })
  const openSession = vi.fn()
  const render = async (visible = true) => { await act(async () => root.render(<MobileGoalsSurface client={client} visible={visible} connected={true} openSession={openSession} />)) }
  await render()
  const buttons = (text: string) => [...element.querySelectorAll('button')].filter(button => button.textContent === text && !button.closest('[hidden]'))
  const click = async (text: string) => { const button = buttons(text)[0]; expect(button, text).toBeDefined(); await act(async () => { button.click() }) }
  const wait = async (text: string) => { await vi.waitFor(async () => { await act(async () => {}); expect(element.textContent).toContain(text) }) }
  return { element, forwardRpc, render, click, wait, buttons, openSession, root }
}
async function existingGoal() {
  await owner.create({ id: 'original-goal', title: 'Actual goal' }); await owner.update('original-goal', { alignment: proposal })
  const view = await mount(); await view.wait('Actual goal')
  await view.click('Actual goal未分配项目 · 待整理'); await view.wait(proposal.summary)
  return view
}
async function unmount(view: Awaited<ReturnType<typeof mount>>) {
  await act(async () => view.root.unmount()); view.element.remove(); mounts.splice(mounts.findIndex(item => item.root === view.root), 1)
}

it('cold remount restores unknown creation from durable device bytes and reads its original ID without creating', async () => {
  vi.mocked(api.demands.create).mockImplementationOnce(async input => { await owner.create(input); throw new Error('Durable creation ACK unknown') })
  const first = await mount(); await first.click('新建目标'); await first.wait('Durable creation ACK unknown')
  const input = first.forwardRpc.mock.calls.find(([method]) => method === 'goal.create')![1]
  const bytes = localStorage.getItem(DEVICE_WORKFACE_KEY)!
  expect(new DeviceWorkfaceStore(() => localStorage).snapshot().record.goalIntents).toMatchObject([{ goalId: input.goalId, operationId: input.operationId, kind: 'create', phase: 'unknown' }])
  await unmount(first)
  const restored = await mount(); await restored.wait('重启或重入后的原创建回执未知')
  expect(restored.element.textContent).toContain(input.goalId); expect(restored.buttons('新建目标')[0].disabled).toBe(true)
  expect(restored.forwardRpc.mock.calls.some(([method]) => method === 'goal.create')).toBe(false)
  expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe(bytes)
  await restored.click('读取同一目标核对'); await restored.wait('此讨论尚未启动 Agent')
  expect(restored.forwardRpc).toHaveBeenCalledWith('goal.inspect', { goalId: input.goalId })
  expect(restored.forwardRpc.mock.calls.some(([method]) => method === 'goal.create')).toBe(false)
  expect(await owner.list()).toHaveLength(1)
})

it('cold remount keeps human acknowledgement unknown as an owner guard until explicit reading', async () => {
  const first = await existingGoal(); vi.mocked(api.demands.confirmAlignment).mockRejectedValueOnce(new Error('Uncertain human acknowledgement'))
  await first.click('确认当前目标'); await first.wait('Uncertain human acknowledgement')
  await unmount(first)
  const restored = await mount(); await restored.wait('Actual goal'); await restored.click('Actual goal未分配项目 · 待整理')
  expect(restored.buttons('确认当前目标')).toHaveLength(0)
  expect(restored.element.textContent).toContain('原人认可回执未知')
  expect(restored.forwardRpc.mock.calls.some(([method]) => method === 'goal.confirm')).toBe(false)
  await restored.click('读取当前提案与报告'); await restored.wait('已读取原目标当前内容')
  expect(restored.buttons('确认当前目标')).toHaveLength(1)
  expect(restored.forwardRpc.mock.calls.some(([method]) => method === 'goal.confirm')).toBe(false)
  await restored.click('确认当前目标'); await restored.wait('已确认读过的当前目标提案')
  expect((await owner.get('original-goal'))!.alignment!.confirmedAt).toBeGreaterThan(0)
})

it('late original discussion receipt after leaving Goals preserves its Tab without taking phone navigation', async () => {
  const view = await existingGoal(), forward = view.forwardRpc.getMockImplementation()!
  let settle!: () => void
  view.forwardRpc.mockImplementation((method, params) => method === 'goal.discuss' ? forward(method, params).then(result => new Promise(resolve => { settle = () => resolve(result) })) : forward(method, params))
  await view.click('打开目标原讨论'); await vi.waitFor(() => expect(settle).toBeTypeOf('function'))
  await view.render(false); await view.render(true); await act(async () => settle())
  expect(view.openSession).not.toHaveBeenCalled(); expect(view.buttons('返回原目标')).toHaveLength(0)
  expect(view.forwardRpc.mock.calls.some(([method]) => method === 'space.inspect')).toBe(false)
  expect(useAppStore.getState().demandPmoTabIds['original-goal']).toBeTruthy()
})

it('late creation completion after leaving Goals never selects or presents the original new goal', async () => {
  let settle!: () => void
  vi.mocked(api.demands.create).mockImplementationOnce(async input => {
    const receipt = await owner.create(input); return await new Promise(resolve => { settle = () => resolve(receipt) })
  })
  const view = await mount(); await view.click('新建目标'); await vi.waitFor(() => expect(settle).toBeTypeOf('function'))
  await view.render(false); await view.render(true); await act(async () => settle())
  await vi.waitFor(() => expect(view.forwardRpc.mock.calls.some(([method]) => method === 'goal.discuss')).toBe(true))
  await act(async () => {}); await view.render(true)
  expect(view.buttons('返回目标列表')).toHaveLength(0); expect(view.buttons('返回原目标')).toHaveLength(0); expect(view.openSession).not.toHaveBeenCalled()
  expect(view.forwardRpc.mock.calls.some(([method]) => method === 'space.inspect')).toBe(false)
  expect(await owner.list()).toHaveLength(1)
})

it('late old acknowledgement-recovery read never replaces a newer displayed proposal or clears its guard', async () => {
  const view = await existingGoal(); vi.mocked(api.demands.confirmAlignment).mockRejectedValueOnce(new Error('Human result unknown'))
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
  await view.click('读取当前提案与报告'); await view.wait('已读取原目标当前内容')
  expect(view.buttons('确认当前目标')).toHaveLength(1)
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.confirm')).toHaveLength(1)
})

it('device intent I/O failure preserves prior bytes and memory without gating healthy creation', async () => {
  const view = await mount(), before = localStorage.getItem(DEVICE_WORKFACE_KEY)
  const set = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Device write failed') })
  await view.click('新建目标'); await view.wait('此讨论尚未启动 Agent')
  expect(set).toHaveBeenCalled(); expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe(before)
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.create')).toHaveLength(1); expect(await owner.list()).toHaveLength(1)
  expect(view.element.textContent).toContain('刷新保障不足'); expect(getDeviceWorkface().exportBackup()).toContain('goalIntents')
  set.mockRestore(); await getDeviceWorkface().replaceUnreadableWithCurrent()
  expect(getDeviceWorkface().snapshot().issue).toBeNull()
})

it('device intent I/O failure keeps human acknowledgement and its unknown recovery available in memory', async () => {
  const view = await existingGoal(), before = localStorage.getItem(DEVICE_WORKFACE_KEY)
  const set = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Device write failed') })
  vi.mocked(api.demands.confirmAlignment).mockRejectedValueOnce(new Error('Real human receipt unknown'))
  await view.click('确认当前目标'); await view.wait('Real human receipt unknown')
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.confirm')).toHaveLength(1)
  expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe(before); expect(view.element.textContent).toContain('刷新保障不足')
  expect(getDeviceWorkface().exportBackup()).toContain('expectedRevision'); expect(view.buttons('确认当前目标')).toHaveLength(0)
  await view.click('读取当前提案与报告'); await view.wait('已读取原目标当前内容')
  await view.click('确认当前目标'); await view.wait('已确认读过的当前目标提案')
  expect((await owner.get('original-goal'))!.alignment!.confirmedAt).toBeGreaterThan(0)
  expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe(before); set.mockRestore(); await getDeviceWorkface().replaceUnreadableWithCurrent()
})

it('one click uses the strict public service to save one pending ID and enter its original main Mote launcher Tab', async () => {
  const view = await mount(); await view.click('新建目标'); await view.wait('此讨论尚未启动 Agent')
  const input = view.forwardRpc.mock.calls.find(([method]) => method === 'goal.create')![1]
  expect(input).toMatchObject({ goalId: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{12}$/), title: 'Untitled goal', description: '', status: 'backlog' })
  expect(input).not.toHaveProperty('projectId')
  const saved = (await openDemandStore({ root: directory }).get(input.goalId))!
  expect(saved).toMatchObject({ id: input.goalId, projectId: null, description: '', sessionIds: [] }); expect(saved.alignment).toBeUndefined(); expect(saved.grounding).toBeUndefined()
  expect(view.forwardRpc).toHaveBeenCalledWith('goal.discuss', { goalId: input.goalId, mode: 'open', operationId: expect.any(String) })
  const tabId = useAppStore.getState().demandPmoTabIds[input.goalId]
  expect(view.forwardRpc).toHaveBeenCalledWith('space.inspect', { target: { tabId }, presentation: true })
  expect(useAppStore.getState().tabs[tabId].topicId).toBe(PMO_TEAMS_TOPIC_ID)
  expect(Object.keys(useAppStore.getState().tabs)).toEqual([tabId]); expect(await owner.list()).toHaveLength(1)
  expect(view.forwardRpc.mock.calls.some(([method]) => method === 'goal.start')).toBe(false)
  await view.click('返回原目标'); expect(view.element.querySelector('article h2')?.textContent).toBe('Untitled goal')
})

it('unknown save reads the held ID against the real owner before PMO and never creates again across hide/show', async () => {
  vi.mocked(api.demands.create).mockImplementationOnce(async input => { await owner.create(input); throw new Error('Creation ACK lost') })
  const view = await mount(); await view.click('新建目标'); await view.wait('Creation ACK lost')
  const input = view.forwardRpc.mock.calls.find(([method]) => method === 'goal.create')![1]
  await view.render(false); await view.render(true); await view.click('新建目标')
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.create')).toHaveLength(1)
  expect(view.forwardRpc.mock.calls.some(([method]) => method === 'goal.discuss')).toBe(false)
  await view.click('读取同一目标核对'); await view.wait('此讨论尚未启动 Agent')
  expect(view.forwardRpc).toHaveBeenCalledWith('goal.inspect', { goalId: input.goalId })
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.create')).toHaveLength(1)
  expect((await owner.list()).map(goal => goal.id)).toEqual([input.goalId])
})

it('owner-confirmed absence only allows explicit saving of the same original ID', async () => {
  vi.mocked(api.demands.create).mockRejectedValueOnce(new Error('No save acknowledgement'))
  const view = await mount(); await view.click('新建目标'); await view.wait('No save acknowledgement')
  const input = view.forwardRpc.mock.calls.find(([method]) => method === 'goal.create')![1]
  await view.click('读取同一目标核对'); await view.wait('准确 ID 尚未保存')
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.create')).toHaveLength(1)
  await view.click('明确保存同一目标'); await view.wait('此讨论尚未启动 Agent')
  const creations = view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.create')
  expect(creations.map(([, params]) => params.goalId)).toEqual([input.goalId, input.goalId])
  expect(await owner.list()).toHaveLength(1)
})

it('PMO failure retains the saved goal and explicit reopening uses its original ID without recreating', async () => {
  useAppStore.setState({ config: { ...config, workspaces: [] } })
  const view = await mount(); await view.click('新建目标'); await view.wait('Scratch workspace is unavailable')
  const input = view.forwardRpc.mock.calls.find(([method]) => method === 'goal.create')![1]
  expect(await owner.get(input.goalId)).not.toBeNull(); expect(view.element.textContent).toContain('原目标已保存')
  useAppStore.setState({ config })
  await view.click('打开这个目标的原讨论'); await view.wait('此讨论尚未启动 Agent')
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.create')).toHaveLength(1)
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.discuss').map(([, params]) => params.goalId)).toEqual([input.goalId, input.goalId])
})

it('human confirmation unknown keeps normal acknowledgement unavailable until explicit current-owner reading', async () => {
  const view = await existingGoal()
  vi.mocked(api.demands.confirmAlignment).mockImplementationOnce(async (id, revision) => { await owner.confirmAlignment(id, revision); throw new Error('Human ACK lost') })
  await view.click('确认当前目标'); await view.wait('Human ACK lost')
  expect(view.buttons('确认当前目标')).toHaveLength(0)
  expect(view.buttons('打开目标原讨论')[0].disabled).toBe(false)
  await view.render(false); await view.render(true); expect(view.buttons('确认当前目标')).toHaveLength(0)
  await view.click('读取当前提案与报告'); await view.wait('已读取原目标当前内容')
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.confirm')).toHaveLength(1)
  expect(view.element.textContent).toContain('Human ACK lost'); expect((await owner.get('original-goal'))!.alignment!.confirmedAt).toBeGreaterThan(0)
})

it('late confirmation acknowledgement never replaces a newer owner proposal already displayed', async () => {
  const view = await existingGoal()
  let settle!: (value: any) => void
  vi.mocked(api.demands.confirmAlignment).mockImplementationOnce(async (id, revision) => {
    const receipt = await owner.confirmAlignment(id, revision)
    return await new Promise(resolve => { settle = () => resolve(receipt) })
  })
  await view.click('确认当前目标'); await vi.waitFor(() => expect(settle).toBeTypeOf('function'))
  await owner.update('original-goal', { alignment: { ...proposal, summary: 'Newer proposal actually read' } })
  await view.click('刷新目标'); await view.wait('Newer proposal actually read')
  await act(async () => settle(undefined)); await view.wait('当前已有较新提案')
  expect(view.element.textContent).toContain('Newer proposal actually read'); expect(view.buttons('确认当前目标')).toHaveLength(1)
})

it('actual gap acceptance keeps the exact submission and reported difference', async () => {
  await owner.create({ id: 'original-goal', title: 'Actual goal' }); await owner.update('original-goal', { alignment: proposal }); await owner.confirmAlignment('original-goal', 1)
  await owner.update('original-goal', { grounding: { alignmentRevision: 1, summary: 'Checked result with gap', checks: [{ criterionId: 'c', outcome: 'gap', evidence: ['actual.log'], note: 'A real difference remains' }] } })
  const submission = (await owner.get('original-goal'))!.grounding!.submissionId
  const view = await mount(); await view.wait('Actual goal'); await view.click('Actual goal未分配项目 · 待整理'); await view.wait('Checked result with gap')
  expect(view.buttons('接受当前结果')).toHaveLength(0)
  await view.click('接受结果并保留差距'); await view.wait('已接受原结果，报告差距仍保留')
  expect(view.forwardRpc).toHaveBeenCalledWith('goal.accept', { goalId: 'original-goal', expectedAlignmentRevision: 1, expectedSubmissionId: submission, acceptGaps: true, operationId: expect.any(String) })
  expect((await owner.get('original-goal'))!.grounding).toMatchObject({ submissionId: submission, acceptedAt: expect.any(Number), checks: [{ outcome: 'gap', note: 'A real difference remains', criterionId: 'c', evidence: ['actual.log'] }] })
})


it('mobile discussion actions retain the original grill and grounding modes on the same main Mote Tab', async () => {
  const view = await existingGoal()
  await view.click('讨论目标变更'); await view.wait('此讨论尚未启动 Agent')
  expect(view.forwardRpc).toHaveBeenCalledWith('goal.discuss', { goalId: 'original-goal', mode: 'grill', operationId: expect.any(String) })
  const tabId = useAppStore.getState().demandPmoTabIds['original-goal']
  await view.click('返回原目标'); await view.click('确认当前目标'); await view.wait('已确认读过的当前目标提案')
  await view.click('请求核对结果'); await view.wait('此讨论尚未启动 Agent')
  expect(view.forwardRpc).toHaveBeenCalledWith('goal.discuss', { goalId: 'original-goal', mode: 'grounding', operationId: expect.any(String) })
  expect(useAppStore.getState().demandPmoTabIds['original-goal']).toBe(tabId)
  expect((await owner.get('original-goal'))!.grounding).toBeUndefined()
  expect(useAppStore.getState().tabs[tabId].topicId).toBe(PMO_TEAMS_TOPIC_ID)
})


it('current human stage action follows evidence before secondary discussion and low-frequency properties', async () => {
  const view = await existingGoal()
  const article = view.element.querySelector('article')!, section = article.querySelector('[aria-label="目标确认与原讨论"]')!
  const evidence = article.querySelector('[aria-label="结果与证据"]')!, properties = [...article.querySelectorAll('summary')].find(node => node.textContent === '工作状态与属性')!
  expect(evidence.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(section.compareDocumentPosition(properties) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const confirm = view.buttons('确认当前目标')[0], discuss = view.buttons('打开目标原讨论')[0]
  expect(confirm.compareDocumentPosition(discuss) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})


it('late original creation recovery read cannot replace another Goal selected while reading', async () => {
  await owner.create({ id: 'goal-b', title: 'Selected later Goal B' })
  vi.mocked(api.demands.create).mockImplementationOnce(async input => { await owner.create(input); throw new Error('Create A unknown') })
  const view = await mount(); await view.wait('Selected later Goal B'); await view.click('新建目标'); await view.wait('Create A unknown')
  const input = view.forwardRpc.mock.calls.find(([method]) => method === 'goal.create')![1], forward = view.forwardRpc.getMockImplementation()!
  let settle!: () => void
  view.forwardRpc.mockImplementation((method, params) => method === 'goal.inspect' && params.goalId === input.goalId ? forward(method, params).then(result => new Promise(resolve => { settle = () => resolve(result) })) : forward(method, params))
  await view.click('读取同一目标核对'); await vi.waitFor(() => expect(settle).toBeTypeOf('function'))
  await view.click('Selected later Goal B未分配项目 · 待整理')
  await act(async () => settle()); await vi.waitFor(() => expect(useAppStore.getState().demandPmoTabIds[input.goalId]).toBeTruthy())
  expect([...view.element.querySelectorAll('article h2')].filter(node => !node.closest('[hidden]')).map(node => node.textContent)).toEqual(['Selected later Goal B'])
  expect(view.buttons('返回原目标')).toHaveLength(0); expect(view.openSession).not.toHaveBeenCalled()
  expect((await owner.list()).map(goal => goal.id).sort()).toEqual([input.goalId, 'goal-b'].sort())
})
