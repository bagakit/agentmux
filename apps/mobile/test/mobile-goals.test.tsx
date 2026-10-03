import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDeviceWorkface, emptyDeviceWorkface } from '../src/recovery/device-workface'
import { MobileGoalsSurface } from '../src/goals/MobileGoalsSurface'
import type { AgentMuxRpcGoal } from '@agentmux/core'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const mounts: { root: Root; element: HTMLDivElement }[] = []
beforeEach(() => { localStorage.clear(); getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const view of mounts.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() } vi.useRealTimers() })
const original: AgentMuxRpcGoal = {
  id: 'goal-original', title: '原目标', description: '原用户意图', status: 'done', priority: 'high', projectId: 'project-original', projectName: '原项目',
  sessionIds: ['session-exact'], createdAt: 1, updatedAt: 2, source: 'session', activityLog: ['原活动'],
  alignment: { summary: '当前提案', criteria: [{ id: 'criterion-original', text: '真实成功标准' }, { id: 'missing', text: '未核对标准' }], openQuestions: ['重要未决问题'], revision: 3, confirmedAt: null },
  grounding: { alignmentRevision: 2, summary: '原结果报告', checks: [{ criterionId: 'criterion-original', outcome: 'unknown', evidence: ['src/result.ts:42'], note: '尚未查证' }], submissionId: 'report-original', acceptedAt: null }
}
async function mount(initial = [original]) {
  let goals = structuredClone(initial)
  const forwardRpc = vi.fn(async (method: string, params: any) => {
    if (method === 'goal.ls') return { goals: goals.filter(goal => !params.status || goal.status === params.status).slice(0, params.limit ?? 100) }
    if (method === 'space.ls') return { catalog: { agentPresentation: [{ agentSessionId: 'session-exact', name: '原 Agent 名称', project: '原 Agent 项目', recap: { text: '原 recap', source: '原来源' }, state: 'working', detail: '原 detail', providerId: 'codex', group: 'working' }] } }
    if (method === 'goal.inspect') return { goal: goals.find(goal => goal.id === params.goalId) ?? null }
    if (method === 'goal.decisions') return { goalId: params.goalId, decisions: [{ input: '原决策', candidates: [{ projectId: 'project-original', reason: '原理由' }], selectedProjectId: 'project-original', risk: 'low', confirmation: 'user', recordedAt: 1, wikiVersion: null, sourceSessionId: null }] }
    if (method === 'goal.link-session') { goals = goals.map(goal => goal.id === params.goalId ? { ...goal, sessionIds: [...goal.sessionIds, params.sessionId] } : goal); return { goal: goals.find(goal => goal.id === params.goalId), receipt: { goalId: params.goalId, sessionId: params.sessionId } } }
    if (method === 'goal.link-project') { goals = goals.map(goal => goal.id === params.goalId ? { ...goal, projectId: params.projectId } : goal); return { goal: goals.find(goal => goal.id === params.goalId), receipt: { goalId: params.goalId, projectId: params.projectId } } }
    if (method === 'app.snapshot') return { projects: [{ projectId: 'project-original', name: '原项目' }], executors: [{ executorId: 'executor-real', label: '原执行者', providerId: 'codex', availability: 'available' }], unavailable: [] }
    if (method === 'goal.assign' || method === 'goal.handoff') { goals = goals.map(goal => goal.id === params.goalId ? { ...goal, assigneeExecutorId: params.assigneeExecutorId, ...(params.sessionId ? { sessionIds: [...new Set([...goal.sessionIds, params.sessionId])] } : {}) } : goal); return { goal: goals.find(goal => goal.id === params.goalId), receipt: { goalId: params.goalId, sessionId: params.sessionId ?? null, startRequested: false } } }
    if (method === 'goal.start') { goals = goals.map(goal => goal.id === params.goalId ? { ...goal, status: 'in_progress' as const } : goal); return { goal: goals.find(goal => goal.id === params.goalId), receipt: { goalId: params.goalId, sessionId: params.sessionId ?? goals.find(goal => goal.id === params.goalId)!.sessionIds[0] ?? null } } }
    if (method === 'goal.delete') { const goal = goals.find(goal => goal.id === params.goalId)!; goals = goals.filter(goal => goal.id !== params.goalId); return { goal, receipt: { goalId: params.goalId, deletedAt: 4 } } }
    if (method === 'goal.create') { const goal = { ...original, id: params.goalId, title: params.title, description: params.description, status: params.status, sessionIds: [], projectId: params.projectId ?? null, projectName: params.projectId ? '原项目' : null, alignment: undefined, grounding: undefined }; goals.push(goal); return { goal, receipt: { goalId: goal.id, createdAt: 3 } } }
    if (method === 'goal.discuss') return { goal: goals.find(goal => goal.id === params.goalId), receipt: { goalId: params.goalId, mode: params.mode, operationId: params.operationId, tabId: 'original-goal-tab', agentSessionId: 'session-exact' } }
    if (method === 'goal.update') { goals = goals.map(goal => goal.id === params.goalId ? { ...goal, ...params.patch } : goal); return { goal: goals.find(goal => goal.id === params.goalId), receipt: { goalId: params.goalId, updatedAt: 3 } } }
    throw new Error(`Unexpected RPC ${method}`)
  })
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); mounts.push({ root, element })
  const openSession = vi.fn(), client = { forwardRpc, runtimeOwnerIdentity: () => ({ runtimeId: 'private-goal-runtime', availability: 'connected' }) } as any
  const render = async (visible = true, connected = true) => { await act(async () => root.render(<MobileGoalsSurface client={client} connected={connected} visible={visible} openSession={openSession} />)) }
  await render()
  const click = async (text: string) => { const button = [...element.querySelectorAll('button')].find(button => button.textContent === text && !button.closest('[hidden]')); expect(button).toBeDefined(); await act(async () => button!.click()) }
  const text = async (input: HTMLInputElement | HTMLTextAreaElement, value: string) => { await act(async () => { Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }) }
  const change = async (label: string, value: string) => { const input = [...element.querySelectorAll(`[aria-label="${label}"]`)].find(node => !node.closest('[hidden]')) as HTMLSelectElement; await act(async () => { input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })) }) }
  return { element, root, client, forwardRpc, openSession, click, change, render, text }
}

describe('Mobile Goals original owner slice', () => {
  it('reads original identity, proposal, unresolved questions, old results, evidence and decisions', async () => {
    const view = await mount()
    expect(view.forwardRpc).toHaveBeenCalledWith('goal.ls', { limit: 1000 })
    await view.click('原目标原项目 · 已完成原用户意图')
    expect(view.forwardRpc).toHaveBeenCalledWith('goal.inspect', { goalId: 'goal-original' })
    expect(view.forwardRpc).toHaveBeenCalledWith('goal.decisions', { goalId: 'goal-original' })
    for (const text of ['原用户意图', '真实成功标准', '重要未决问题', '目标尚未确认', '结果未知', 'src/result.ts:42', '旧报告标准 criterion-original', '尚不能对应当前目标标准', '结果尚未接受', '原决策', '原活动']) expect(view.element.textContent).toContain(text)
    await view.click('打开关联会话'); expect(view.openSession).toHaveBeenCalledWith('session-exact', { name: '原 Agent 名称', project: '原 Agent 项目' })
    expect(view.forwardRpc.mock.calls.every(([method]) => !['goal.start', 'goal.create', 'agent.send'].includes(method))).toBe(true)
  })
  it('updates only the exact original Goal through RPC and does not turn done into acknowledgement', async () => {
    const view = await mount(); await view.click('原目标原项目 · 已完成原用户意图')
    await view.change('工作状态', 'blocked')
    expect(view.forwardRpc).toHaveBeenCalledWith('goal.update', { goalId: 'goal-original', patch: { status: 'blocked' }, operationId: expect.any(String) })
    expect(view.element.textContent).toContain('目标尚未确认'); expect(view.element.textContent).toContain('结果尚未接受')
    await view.change('优先级', 'urgent')
    expect(view.forwardRpc).toHaveBeenCalledWith('goal.update', { goalId: 'goal-original', patch: { priority: 'urgent' }, operationId: expect.any(String) })
    await view.click('返回目标列表'); expect(view.element.textContent).toContain('原项目 · 受阻')
  })
  it('retains the goal, exact Session and edit form through failed reads, disconnected hints and hide/show', async () => {
    const view = await mount(); await view.click('原目标原项目 · 已完成原用户意图'); await view.click('编辑目标正文')
    view.forwardRpc.mockRejectedValueOnce(new Error('list probe')).mockRejectedValueOnce(new Error('detail probe'))
    await view.click('刷新目标')
    expect(view.element.querySelector('.mobile-goals-list')?.textContent).toContain('原目标');
    expect(view.element.textContent).toContain('list probe'); expect(view.element.textContent).toContain('detail probe')
    expect(view.element.querySelector('article textarea')).not.toBeNull()
    await view.render(false, false); await view.render(true, false)
    expect(view.element.textContent).toContain('当前提案'); expect(view.element.querySelector('article textarea')).not.toBeNull()
    await view.click('打开关联会话'); expect(view.openSession).toHaveBeenCalledWith('session-exact', { name: '原 Agent 名称', project: '原 Agent 项目' })
    expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.inspect').length).toBeGreaterThan(1)
  })
  it('retains draft on unknown mutation receipt and never automatically replays a write', async () => {
    const view = await mount(); await view.click('原目标原项目 · 已完成原用户意图'); await view.click('编辑目标正文')
    view.forwardRpc.mockRejectedValueOnce(new Error('receipt lost'))
    await act(async () => { const textarea = view.element.querySelector('article textarea')!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '待保存正文'); textarea.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => view.element.querySelector('article form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(view.element.textContent).toContain('保存回执未确认'); expect(view.element.querySelector('article textarea')?.value).toBe('待保存正文')
    await view.click('读取当前目标')
    expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.update')).toHaveLength(1)
    expect(view.element.querySelector('article textarea')).not.toBeNull()
  })
  it('keeps successful owner writes newer than an already pending detail read', async () => {
    const view = await mount()
    let resolve!: (value: any) => void
    view.forwardRpc.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await view.click('原目标原项目 · 已完成原用户意图')
    await view.change('工作状态', 'blocked')
    await act(async () => resolve({ goal: original }))
    expect((view.element.querySelector('[aria-label="工作状态"]') as HTMLSelectElement).value).toBe('blocked')
  })
  it('preserves draft and unknown receipt across another goal and independent property saves', async () => {
    const view = await mount([original, { ...original, id: 'second', title: '第二目标' }])
    await view.click('原目标原项目 · 已完成原用户意图'); await view.click('编辑目标正文')
    const textarea = view.element.querySelector('article textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '未保存的真实草稿')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await view.click('编辑目标正文'); await view.click('编辑目标正文')
    expect(view.element.querySelector('article textarea')?.value).toBe('未保存的真实草稿')
    await view.change('优先级', 'urgent')
    expect(view.element.querySelector('article textarea')).not.toBeNull()
    view.forwardRpc.mockRejectedValueOnce(new Error('unknown original write'))
    await act(async () => view.element.querySelector('article form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await view.change('优先级', 'normal')
    expect(view.element.textContent).toContain('unknown original write')
    await view.click('返回目标列表'); await view.click('第二目标原项目 · 已完成原用户意图')
    const back = [...view.element.querySelectorAll('button')].find(button => button.textContent === '返回目标列表' && !button.closest('[hidden]'))!
    await act(async () => back.click())
    await view.click('原目标原项目 · 已完成原用户意图')
    const shown = view.element.querySelector('[aria-label="目标详情"]')!
    expect(shown.querySelector('textarea')?.value).toBe('未保存的真实草稿'); expect(shown.textContent).toContain('unknown original write')
  })
  it('keeps decision read failure visible even when the independent detail read succeeds later', async () => {
    const view = await mount()
    let resolve!: (value: any) => void
    view.forwardRpc.mockImplementationOnce(() => new Promise(done => { resolve = done })).mockRejectedValueOnce(new Error('decision read failed'))
    await view.click('原目标原项目 · 已完成原用户意图')
    await act(async () => resolve({ goal: original }))
    expect(view.element.textContent).toContain('decision read failed')
  })
  it('uses original Agent presentation only for visible related sessions and keeps SID opening available without presentation', async () => {
    const view = await mount()
    expect(view.forwardRpc.mock.calls.some(([method]) => method === 'space.ls')).toBe(false)
    await view.click('原目标原项目 · 已完成原用户意图')
    expect(view.forwardRpc).toHaveBeenCalledWith('space.ls', { target: {}, presentation: true })
    const sessions = view.element.querySelector('[aria-label="关联会话"]')!
    expect(sessions.textContent).toContain('原 Agent 名称'); expect(sessions.textContent).toContain('原 recap')
    expect(sessions.querySelector('code')?.closest('details')).not.toBeNull()
    view.forwardRpc.mockResolvedValueOnce({ catalog: {} })
    await view.click('刷新关联会话'); await view.click('打开关联会话')
    expect(view.openSession).toHaveBeenLastCalledWith('session-exact', { name: '原 Agent 名称', project: '原 Agent 项目' })
    view.forwardRpc.mockRejectedValueOnce(new Error('presentation probe'))
    await view.click('刷新关联会话'); await view.click('打开关联会话')
    expect(view.openSession).toHaveBeenCalledTimes(2); expect(view.element.textContent).toContain('presentation probe')
  })
  it('opens the exact SID with honest unknown identity when no original presentation has ever been read', async () => {
    const view = await mount()
    const implementation = view.forwardRpc.getMockImplementation()!
    view.forwardRpc.mockImplementation(async (method, params) => method === 'space.ls' ? { catalog: {} } : implementation(method, params))
    await view.click('原目标原项目 · 已完成原用户意图'); await view.click('打开关联会话')
    expect(view.openSession).toHaveBeenLastCalledWith('session-exact', { name: 'Agent 名称未确认', project: '项目未确认' })
  })
  it('retains original Agent presentation after hiding when the next presentation read fails', async () => {
    const view = await mount(); await view.click('原目标原项目 · 已完成原用户意图')
    const implementation = view.forwardRpc.getMockImplementation()!
    view.forwardRpc.mockImplementation(async (method, params) => {
      if (method === 'space.ls') throw new Error('presentation unavailable after hiding')
      return implementation(method, params)
    })
    await view.render(false); await view.render(true)
    const sessions = view.element.querySelector('[aria-label="关联会话"]')!
    expect(sessions.textContent).toContain('原 Agent 名称'); expect(sessions.textContent).toContain('原 recap')
    expect(sessions.textContent).toContain('presentation unavailable after hiding')
    await view.click('打开关联会话')
    expect(view.openSession).toHaveBeenLastCalledWith('session-exact', { name: '原 Agent 名称', project: '原 Agent 项目' })
  })
  it('writes real original Project and Session links with exact identities', async () => {
    const view = await mount(); await view.click('原目标原项目 · 已完成原用户意图')
    const input = view.element.querySelector('[aria-label="关联 Session ID"]') as HTMLInputElement
    await view.text(input, 'new-session-exact')
    await act(async () => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(view.forwardRpc).toHaveBeenCalledWith('goal.link-session', { goalId: original.id, sessionId: 'new-session-exact', operationId: expect.any(String) })
    const project = view.element.querySelector('[aria-label="关联 Project ID"]') as HTMLInputElement
    await view.text(project, 'new-project-exact')
    await act(async () => project.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(view.forwardRpc).toHaveBeenCalledWith('goal.link-project', { goalId: original.id, projectId: 'new-project-exact', operationId: expect.any(String) })
    expect(view.element.textContent).toContain('new-session-exact'); expect(view.element.textContent).toContain('new-project-exact')
  })
  it('does not relabel old accepted checks as current criteria or current acceptance', async () => {
    const view = await mount([{ ...original, grounding: { ...original.grounding!, acceptedAt: 5 } }])
    await view.click('原目标原项目 · 已完成原用户意图')
    const result = view.element.querySelector('[aria-label="结果与证据"]')!
    expect(result.textContent).toContain('旧报告曾被接受，不代表当前结果接受')
    expect(result.textContent).not.toContain('真实成功标准'); expect(result.textContent).not.toContain('当前结果已接受')
  })
  it('saves only edited body fields and keeps unrelated remote title changes', async () => {
    const view = await mount(); await view.click('原目标原项目 · 已完成原用户意图'); await view.click('编辑目标正文')
    await view.text(view.element.querySelector('article textarea')!, '只有原意修改')
    await act(async () => { await view.forwardRpc('goal.update', { goalId: original.id, patch: { title: '远端新标题' } }) })
    await view.click('读取当前目标')
    await act(async () => view.element.querySelector('article form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(view.forwardRpc).toHaveBeenCalledWith('goal.update', { goalId: original.id, patch: { description: '只有原意修改' }, operationId: expect.any(String) })
    expect(view.element.querySelector('h2')?.textContent).toBe('远端新标题')
  })
  it('reads the public maximum without hiding its partial-directory boundary and opens an exact Goal beyond that page', async () => {
    const all = Array.from({ length: 1001 }, (_, index) => ({ ...original, id: `original-${index}`, title: `原目标 ${index}`, sessionIds: [] }))
    const view = await mount(all)
    expect(view.element.querySelectorAll('.mobile-goals-list li')).toHaveLength(1000)
    expect(view.element.textContent).toContain('目录已达到原服务单次返回范围')
    await view.text(view.element.querySelector('[aria-label="打开 Goal ID"]') as HTMLInputElement, 'original-1000')
    await act(async () => view.element.querySelector('[aria-label="打开 Goal ID"]')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(view.element.querySelector('h2')?.textContent).toBe('原目标 1000')
    expect(view.forwardRpc).toHaveBeenCalledWith('goal.inspect', { goalId: 'original-1000' })
  })
  it('advances body baselines after successful saves before later remote edits', async () => {
    const view = await mount(); await view.click('原目标原项目 · 已完成原用户意图'); await view.click('编辑目标正文')
    await view.text(view.element.querySelector('article form input') as HTMLInputElement, '已保存标题')
    await act(async () => view.element.querySelector('article form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await act(async () => { await view.forwardRpc('goal.update', { goalId: original.id, patch: { title: '后来的远端标题' } }) })
    await view.click('读取当前目标')
    await view.text(view.element.querySelector('article textarea')!, '之后只修改原意')
    await act(async () => view.element.querySelector('article form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(view.forwardRpc).toHaveBeenLastCalledWith('goal.update', { goalId: original.id, patch: { description: '之后只修改原意' }, operationId: expect.any(String) })
    expect(view.element.querySelector('h2')?.textContent).toBe('后来的远端标题')
  })
  it('preserves unknown link operation and exact input through another goal and hide/show', async () => {
    const view = await mount([original, { ...original, id: 'second', title: '第二目标' }]); await view.click('原目标原项目 · 已完成原用户意图')
    const input = view.element.querySelector('[aria-label="关联 Session ID"]') as HTMLInputElement
    await view.text(input, 'pending-exact-session')
    view.forwardRpc.mockRejectedValueOnce(new Error('unknown link receipt'))
    await act(async () => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    const call = view.forwardRpc.mock.calls.find(([method]) => method === 'goal.link-session')!
    await view.click('返回目标列表'); await view.click('第二目标原项目 · 已完成原用户意图'); await view.click('返回目标列表'); await view.click('原目标原项目 · 已完成原用户意图')
    await view.render(false); await view.render(true)
    expect(view.element.querySelector<HTMLInputElement>('[aria-label="关联 Session ID"]')?.value).toBe('pending-exact-session')
    expect(view.element.textContent).toContain('unknown link receipt'); expect(view.element.textContent).toContain(call[1].operationId)
    expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.link-session')).toHaveLength(1)
  })
  it('does not roll back newer attributes when an older link receipt arrives later', async () => {
    const view = await mount(); await view.click('原目标原项目 · 已完成原用户意图')
    const input = view.element.querySelector('[aria-label="关联 Session ID"]') as HTMLInputElement
    await view.text(input, 'new-session-exact')
    let resolve!: (value: any) => void
    view.forwardRpc.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await act(async () => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await view.change('优先级', 'urgent')
    await act(async () => resolve({ goal: { ...original, sessionIds: [...original.sessionIds, 'new-session-exact'] }, receipt: { goalId: original.id, sessionId: 'new-session-exact' } }))
    expect(view.element.querySelector<HTMLSelectElement>('[aria-label="优先级"]')?.value).toBe('urgent')
    expect(view.element.textContent).toContain('new-session-exact')
  })
  it('assigns the original executor without starting, starts only explicitly and records actual handoff links', async () => {
    const view = await mount(); await view.click('原目标原项目 · 已完成原用户意图')
    const executor = view.element.querySelector('[aria-label="分配 Executor ID"]') as HTMLInputElement
    await view.text(executor, 'executor-real'); await view.click('保存执行者分配')
    expect(view.forwardRpc).toHaveBeenCalledWith('goal.assign', { goalId: original.id, assigneeExecutorId: 'executor-real', start: false, operationId: expect.any(String) })
    expect(view.forwardRpc.mock.calls.some(([method]) => method === 'goal.start')).toBe(false)
    await view.text(view.element.querySelector('[aria-label="执行 Session ID"]') as HTMLInputElement, 'session-explicit')
    await view.click('开始执行此目标')
    expect(view.forwardRpc).toHaveBeenCalledWith('goal.start', { goalId: original.id, sessionId: 'session-explicit', operationId: expect.any(String) })
    expect(view.element.querySelector<HTMLSelectElement>('[aria-label="工作状态"]')?.value).toBe('in_progress')
    await view.click('保存交接关系')
    expect(view.forwardRpc).toHaveBeenCalledWith('goal.handoff', { goalId: original.id, assigneeExecutorId: 'executor-real', sessionId: 'session-explicit', operationId: expect.any(String) })
    expect(view.element.textContent).toContain('未自动发送新任务')
  })
  it('requires the explicit deletion step and keeps the original Goal on an unknown deletion receipt', async () => {
    const view = await mount(); await view.click('原目标原项目 · 已完成原用户意图'); await view.click('删除目标…')
    expect(view.forwardRpc.mock.calls.some(([method]) => method === 'goal.delete')).toBe(false)
    view.forwardRpc.mockRejectedValueOnce(new Error('delete receipt lost'))
    await view.click('确认删除此目标')
    expect(view.element.textContent).toContain('delete receipt lost'); expect(view.element.querySelector('h2')?.textContent).toBe('原目标')
    await view.click('打开关联会话'); expect(view.openSession).toHaveBeenCalledTimes(1)
    await view.click('读取当前目标')
    expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.delete')).toHaveLength(1)
    await view.click('确认删除此目标')
    expect(view.forwardRpc).toHaveBeenCalledWith('goal.delete', { goalId: original.id, confirmation: 'delete', operationId: expect.any(String) })
    expect(view.element.querySelector('h2')).toBeNull(); expect(view.element.querySelectorAll('.mobile-goals-list li')).toHaveLength(0)
    expect(view.forwardRpc.mock.calls.some(([method]) => method === 'agent.stop')).toBe(false)
  })
  it('does not resurrect a confirmed deleted Goal from older reads or link receipts', async () => {
    const view = await mount(); await view.click('原目标原项目 · 已完成原用户意图')
    const link = view.element.querySelector('[aria-label="关联 Session ID"]') as HTMLInputElement
    await view.text(link, 'late-session')
    let resolve!: (value: any) => void
    view.forwardRpc.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await act(async () => link.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await view.click('删除目标…'); await view.click('确认删除此目标')
    await act(async () => resolve({ goal: { ...original, sessionIds: [...original.sessionIds, 'late-session'] }, receipt: { goalId: original.id, sessionId: 'late-session' } }))
    expect(view.element.querySelector('h2')).toBeNull(); expect(view.element.querySelectorAll('.mobile-goals-list li')).toHaveLength(0)
  })
  it('does not resurrect a confirmed deleted Goal from a pending exact-ID lookup', async () => {
    const view = await mount()
    const input = view.element.querySelector('[aria-label="打开 Goal ID"]') as HTMLInputElement
    await view.text(input, original.id)
    let resolve!: (value: any) => void
    view.forwardRpc.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await act(async () => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await view.click('原目标原项目 · 已完成原用户意图'); await view.click('删除目标…'); await view.click('确认删除此目标')
    await act(async () => resolve({ goal: original }))
    expect(view.element.querySelector('h2')).toBeNull(); expect(view.element.querySelectorAll('.mobile-goals-list li')).toHaveLength(0)
  })
  it('retains the exact original action target and operation ID after editing inputs, switching goals and hide/show', async () => {
    const view = await mount([original, { ...original, id: 'second', title: '第二目标' }]); await view.click('原目标原项目 · 已完成原用户意图')
    const input = view.element.querySelector('[aria-label="执行 Session ID"]') as HTMLInputElement
    await view.text(input, 'original-request-session')
    await view.text(view.element.querySelector('[aria-label="分配 Executor ID"]') as HTMLInputElement, 'original-request-executor')
    view.forwardRpc.mockRejectedValueOnce(new Error('handoff receipt lost')); await view.click('保存交接关系')
    const operationId = view.forwardRpc.mock.calls.find(([method]) => method === 'goal.handoff')![1].operationId
    await view.text(input, 'later-input-session')
    await view.click('返回目标列表'); await view.click('第二目标原项目 · 已完成原用户意图'); await view.click('返回目标列表'); await view.click('原目标原项目 · 已完成原用户意图')
    await view.render(false); await view.render(true)
    expect(view.element.textContent).toContain('original-request-session'); expect(view.element.textContent).toContain('original-request-executor'); expect(view.element.textContent).toContain(operationId)
    expect(view.element.querySelector<HTMLInputElement>('[aria-label="执行 Session ID"]')?.value).toBe('later-input-session')
    expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.handoff')).toHaveLength(1)
  })
  it('retains the original list on failed list reads and does not gate opening its healthy Session', async () => {
    const view = await mount()
    view.forwardRpc.mockRejectedValueOnce(new Error('list probe'))
    await view.click('刷新目标')
    expect(view.element.querySelector('.mobile-goals-list')?.textContent).toContain('原目标')
    expect(view.element.textContent).toContain('读取目标失败')
    await view.click('原目标原项目 · 已完成原用户意图'); await view.click('打开关联会话')
    expect(view.openSession).toHaveBeenCalledWith('session-exact', { name: '原 Agent 名称', project: '原 Agent 项目' })
  })
  it('refreshes only the visible Goal while its list is hidden and observes original remote changes', async () => {
    vi.useFakeTimers()
    const view = await mount(); await view.click('原目标原项目 · 已完成原用户意图')
    const listReads = view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.ls').length
    await act(async () => { await view.forwardRpc('goal.update', { goalId: original.id, patch: { description: '原 owner 的新原意' } }) })
    await act(async () => vi.advanceTimersByTime(10000))
    expect(view.element.querySelector('.mobile-goals-body')?.textContent).toBe('原 owner 的新原意')
    expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.ls')).toHaveLength(listReads)
    await view.click('返回目标列表')
    expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.ls').length).toBeGreaterThan(listReads)
  })
  it('bounds background reads to visible consumers and suppresses obsolete selected-goal responses', async () => {
    vi.useFakeTimers()
    const view = await mount(); await view.render(false)
    const count = view.forwardRpc.mock.calls.length
    await act(async () => vi.advanceTimersByTime(30000)); expect(view.forwardRpc.mock.calls).toHaveLength(count)
    await view.render(true)
    let resolve!: (value: any) => void
    view.forwardRpc.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await view.click('原目标原项目 · 已完成原用户意图')
    await view.click('返回目标列表')
    await act(async () => resolve({ goal: { ...original, title: '过时读回' } }))
    expect(view.element.textContent).not.toContain('过时读回')
  })
})

it('one click saves the pending original Goal and opens its discussion with the exact selected Project', async () => {
  const view = await mount()
  await view.change('新目标项目', 'project-original')
  await view.click('新建目标')
  const input = view.forwardRpc.mock.calls.find(([method]) => method === 'goal.create')![1]
  expect(input).toEqual({ goalId: expect.stringMatching(/^demand_/), title: 'Untitled goal', description: '', status: 'backlog', projectId: 'project-original', risk: 'low', confirmation: 'user', operationId: expect.any(String) })
  expect(view.forwardRpc).toHaveBeenCalledWith('goal.discuss', { goalId: input.goalId, mode: 'open', operationId: expect.any(String) })
  expect(view.element.querySelector('article h2')?.textContent).toBe('Untitled goal')
  expect(view.forwardRpc.mock.calls.some(([method]) => method === 'goal.start')).toBe(false)
})
it('keeps an unknown creation and its exact operation across hide/show without sending it again', async () => {
  const view = await mount()
  const invoke = view.forwardRpc.getMockImplementation()!
  view.forwardRpc.mockImplementation(async (method, params) => { if (method === 'goal.create') throw new Error('creation reply lost'); return invoke(method, params) })
  await view.click('新建目标'); await view.render(false); await view.render(true); await view.click('新建目标')
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.create')).toHaveLength(1)
  expect(view.element.textContent).toContain('creation reply lost')
  const input = view.forwardRpc.mock.calls.find(([method]) => method === 'goal.create')![1]
  expect(view.element.textContent).toContain(input.goalId)
  expect(view.forwardRpc.mock.calls.some(([method]) => method === 'goal.discuss')).toBe(false)
  await view.click('读取同一目标核对')
  expect(view.forwardRpc).toHaveBeenCalledWith('goal.inspect', { goalId: input.goalId })
  expect(view.forwardRpc.mock.calls.filter(([method]) => method === 'goal.create')).toHaveLength(1)
  expect(view.element.textContent).toContain('准确 ID 尚未保存')
})
