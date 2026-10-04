import { fixturePath } from '../../../test/fixture-values.mjs'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxRpcGoal, AgentMuxRpcResult, ContinuousProgressLoop } from '@agentmux/core'
import { MobileGoalWork } from '../src/navigation/MobileGoalWork'
import { goalWorkTarget, inspectGoal, sendGoalOperation } from '../src/navigation/goal-work'
import { DeviceWorkfaceStore, emptyDeviceWorkface, getDeviceWorkface, parseDeviceWorkface, type MobileGoalOperation } from '../src/recovery/device-workface'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { button, click, deferred, editor, fixture, mount, mounted, paste } from './conversation-fixture'

const goal: AgentMuxRpcGoal = { id: 'goal-original', title: '交付原成果', description: '原始目标', status: 'in_progress', priority: 'normal', projectId: null, projectName: null,
  sessionIds: ['session-original'], createdAt: 1, updatedAt: 1, source: 'session', alignment: { summary: '准确完成原工作', criteria: [{ id: 'criterion', text: '成果可核对' }], openQuestions: [], revision: 1, confirmedAt: 1 } }
function loop(): ContinuousProgressLoop {
  return { hostId: 'host-original', agentSessionId: 'session-original', providerId: 'codex', workspacePath: fixturePath("workspace"), loopId: 'original-loop',
    taskSource: { kind: 'goal', goalId: goal.id, alignmentRevision: 1 }, intervalMs: 1800000, prompt: '原工作', status: 'active', revision: 1, nextCheckAt: 100,
    creationOperationId: 'original-start', initialDelivery: { operationId: 'original-start', prompt: '原工作', condition: { expectedRun: { runId: 'run-original' }, afterSubmissionId: null }, state: 'confirmed', startedAt: 1 } }
}
function goalFixture(initialLoops: ContinuousProgressLoop[] = []) {
  const f = fixture(), state: { goal: AgentMuxRpcGoal; loops: ContinuousProgressLoop[] } = { goal: structuredClone(goal), loops: initialLoops }
  let runtimeId = 'original-runtime', ownerInstanceId = 'process-one'
  f.client.runtimeOwnerIdentity = () => ({ runtimeId, ownerInstanceId, availability: 'connected', protocolVersion: 1, processId: 1,
    ctxmux: { hostId: 'runtime-host', buildIdentity: 'private-source', processId: 2, instanceId: 'original-daemon', protocolVersion: 1 } })
  const calls: Array<{ method: string; params: any }> = []
  const forward = vi.fn().mockImplementation(async (method: string, params: any) => {
    calls.push({ method, params: structuredClone(params) })
    if (method === 'goal.ls') return { goals: state.goal.sessionIds.includes(params.agentSessionId) ? [state.goal] : [] }
    if (method === 'goal.inspect') return structuredClone({ goal: state.goal, goalContinuations: state.loops })
    if (method === 'goal.start') {
      let current = state.loops.find(value => value.creationOperationId === params.operationId)
      if (!current) { current = { ...loop(), creationOperationId: params.operationId, intervalMs: params.continuation.intervalMs,
        initialDelivery: { ...loop().initialDelivery!, operationId: params.operationId } }; state.loops.push(current) }
      return structuredClone({ goal: state.goal, continuation: current, receipt: { goalId: goal.id, startedAt: 1, sessionId: 'session-original' } })
    }
    if (method === 'goal.continuation-action') {
      const current = state.loops.find(value => value.loopId === params.loopId)!
      current.status = params.action === 'stop' ? 'stopped' : params.action === 'resume' ? 'active' : params.action === 'pause' ? 'paused' : current.status
      current.revision = params.expectedRevision + 1
      current.lastMutation = { operationId: params.operationId, action: params.action, expectedRevision: params.expectedRevision }
      return structuredClone({ goalId: goal.id, continuation: current, diskDurability: 'confirmed' })
    }
    if (method === 'goal.focus') return { focused: true }
    throw new Error('Unexpected original public method ' + method)
  })
  f.client.forwardRpc = forward
  return { ...f, state, forward, calls, identity(runtime: string, process = 'process-two') { runtimeId = runtime; ownerInstanceId = process } }
}
function operation(f: ReturnType<typeof goalFixture>, kind: 'start' | 'action' = 'start'): MobileGoalOperation {
  const common = { ...goalWorkTarget(f.client, getDeviceWorkface(), 'session-original', goal.id), operationId: 'same-original-operation' }
  return kind === 'start' ? { ...common, kind, intervalMs: 1800000, alignmentRevision: 1 }
    : { ...common, kind, loopId: 'original-loop', action: 'pause', expectedRevision: 1 }
}
async function rejectsOriginal(promise: Promise<unknown>, message?: string) {
  const result = await promise.then(value => ({ resolved: true, value, error: undefined }), error => ({ resolved: false, value: undefined, error }))
  expect(result.resolved, 'The original Source must explicitly refuse this wrong or unconfirmed operation').toBe(false)
  expect(result.error).toBeInstanceOf(Error)
  if (message) expect((result.error as Error).message).toContain(message)
}
const renderPanel = (f: ReturnType<typeof goalFixture>, overrides: { connected?: boolean; visible?: boolean; agentSessionId?: string } = {}) =>
  <MobileGoalWork client={f.client} agentSessionId={overrides.agentSessionId ?? 'session-original'} connected={overrides.connected ?? true} visible={overrides.visible ?? true} />
beforeEach(() => { localStorage.clear(); getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }; document.body.replaceChildren(); vi.restoreAllMocks() })

describe('connected Goal original identity and business operations', () => {
  it('retains the optional intent in the original record through conversation/navigation edits and a new owner', () => {
    const f = goalFixture(), op = operation(f), owner = getDeviceWorkface()
    owner.selectGoal(goalWorkTarget(f.client, owner, 'session-original', goal.id)); owner.retainGoalOperation(op)
    owner.updateConversation({ version: 1, drafts: [['original-draft', '继续输入']], attempts: [], responses: [] })
    owner.updateNavigation({ selectedSessionId: 'other', hostUrl: '', panel: 'terminal' })
    const restored = new DeviceWorkfaceStore(() => localStorage).snapshot().record
    expect(restored.goalWork).toEqual({ selection: goalWorkTarget(f.client, owner, 'session-original', goal.id), pending: [op] })
    expect(restored.conversation.drafts).toEqual([['original-draft', '继续输入']]); expect(restored.selectedSessionId).toBe('other')
    expect(owner.parseBackup(owner.exportBackup())).toEqual(restored)
  })
  it('accepts original six-field v1 bytes and rejects unknown, duplicate or changed same OP without covering existing bytes', () => {
    expect(parseDeviceWorkface(emptyDeviceWorkface())).toEqual(emptyDeviceWorkface())
    expect(Object.keys(emptyDeviceWorkface())).toHaveLength(6)
    const f = goalFixture(), owner = getDeviceWorkface(), op = operation(f)
    owner.retainGoalOperation(op); const before = localStorage.getItem('agentmux-mobile-workface-v1')
    expect(() => owner.retainGoalOperation({ ...op, goalId: 'foreign' })).toThrow('内容不同')
    expect(localStorage.getItem('agentmux-mobile-workface-v1')).toBe(before)
    expect(() => parseDeviceWorkface({ ...emptyDeviceWorkface(), goalWork: { selection: null, pending: [op, op] } })).toThrow()
    expect(() => parseDeviceWorkface({ ...emptyDeviceWorkface(), goalWork: { selection: null, pending: [], token: 'secret' } })).toThrow()
  })
  it('rejects Goal association from original inspect, not a name, Mote or first result', async () => {
    const f = goalFixture(); f.state.goal.sessionIds = ['other']
    await rejectsOriginal(inspectGoal(f.client, goal.id, 'session-original'), '关联')
    expect(f.calls.some(call => call.method === 'goal.start')).toBe(false)
  })
  it('preserves old OP across Host process identity and refuses a changed durable Runtime or relay Host', async () => {
    const f = goalFixture(), owner = getDeviceWorkface(), op = operation(f)
    owner.retainGoalOperation(op); f.identity('original-runtime', 'new-process')
    await sendGoalOperation(f.client, owner, op, () => true)
    expect(f.calls.find(call => call.method === 'goal.start')?.params.operationId).toBe(op.operationId)
    f.identity('another-runtime'); f.calls.length = 0
    await rejectsOriginal(sendGoalOperation(f.client, owner, op, () => true), '另一个')
    expect(f.calls).toEqual([])
    f.identity('original-runtime'); owner.confirmHost({ origin: location.origin, hostId: 'relay-server' })
    await sendGoalOperation(f.client, owner, op, () => true)
    const known = { ...op, deviceHostId: 'relay-server' }; owner.retainGoalOperation(known)
    owner.replaceBackup({ ...owner.snapshot().record, host: { origin: location.origin, hostId: 'different-relay' } })
    await rejectsOriginal(sendGoalOperation(f.client, owner, known, () => true), '另一个')
  })
  it('keeps later intent and other pending operations when an old receipt confirms', () => {
    const f = goalFixture(), owner = getDeviceWorkface(), old = operation(f), later = { ...old, operationId: 'later-original-operation', goalId: 'later-goal' }
    owner.retainGoalOperation(old); owner.retainGoalOperation(later); owner.selectGoal(goalWorkTarget(f.client, owner, 'session-original', later.goalId))
    owner.confirmGoalOperation(old)
    expect(owner.snapshot().record.goalWork?.pending).toEqual([later]); expect(owner.snapshot().record.goalWork?.selection?.goalId).toBe('later-goal')
    owner.confirmGoalOperation({ ...later, goalId: 'foreign' }); expect(owner.snapshot().record.goalWork?.pending).toEqual([later])
  })
  it('keeps the same pending intent when another actual Device owner tries a new operation for the same target', () => {
    const f = goalFixture(), owner = getDeviceWorkface(), old = operation(f)
    owner.retainGoalOperation(old)
    const otherWindow = new DeviceWorkfaceStore(() => localStorage)
    expect(() => otherWindow.retainGoalOperation({ ...old, operationId: 'second-window-new-operation' })).toThrow('已有待确认操作')
    expect(new DeviceWorkfaceStore(() => localStorage).snapshot().record.goalWork?.pending).toEqual([old])
  })
  it('does not forward after a delayed fresh read belongs to an old A-B-A scope', async () => {
    const f = goalFixture(), wait = deferred<AgentMuxRpcResult<'goal.inspect'>>(), op = operation(f)
    const original = f.forward.getMockImplementation()!
    f.forward.mockImplementation((method, params) => method === 'goal.inspect' ? wait.promise : original(method, params))
    let current = true
    const result = sendGoalOperation(f.client, getDeviceWorkface(), op, () => current)
    current = false; wait.resolve({ goal, goalContinuations: [] })
    const settled = await result.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
    expect(f.client.forwardRpc).toHaveBeenCalledTimes(1)
    expect(f.calls.some(row => row.method === 'goal.start')).toBe(false)
    expect(settled.error).toBeInstanceOf(Error); expect(settled.error.message).toContain('改变')
  })
  it('keeps an unknown start pending and reuses its exact business OP on explicit retry', async () => {
    const f = goalFixture(), op = operation(f), owner = getDeviceWorkface()
    owner.retainGoalOperation(op)
    const original = f.forward.getMockImplementation()!
    f.forward.mockImplementation(async (method, params) => { const result = await original(method, params); if (method === 'goal.start') { f.state.loops[0]!.initialDelivery!.state = 'unknown'; result.continuation.initialDelivery.state = 'unknown' } return result })
    await sendGoalOperation(f.client, owner, op, () => true)
    expect(owner.snapshot().record.goalWork?.pending).toEqual([op])
    f.forward.mockImplementation(original); f.state.loops[0]!.initialDelivery!.state = 'confirmed'
    await sendGoalOperation(f.client, owner, op, () => true)
    expect(f.calls.filter(call => call.method === 'goal.start').map(call => call.params.operationId)).toEqual([op.operationId, op.operationId])
    expect(owner.snapshot().record.goalWork?.pending).toEqual([])
  })
  it('rejects foreign Session or wrong operation receipts and preserves the original intent', async () => {
    const f = goalFixture(), op = operation(f), owner = getDeviceWorkface(); owner.retainGoalOperation(op)
    const original = f.forward.getMockImplementation()!
    f.forward.mockImplementation(async (method, params) => { const result = await original(method, params); if (method === 'goal.start') result.continuation.agentSessionId = 'other'; return result })
    await rejectsOriginal(sendGoalOperation(f.client, owner, op, () => true), '其他执行会话')
    expect(owner.snapshot().record.goalWork?.pending).toEqual([op])
  })
  it('reconciles a lost mutation ACK with the original OP/revision after re-open, never replacing it with resume', async () => {
    const f = goalFixture([loop()]), owner = getDeviceWorkface(), op = operation(f, 'action'); owner.retainGoalOperation(op)
    const original = f.forward.getMockImplementation()!
    f.forward.mockImplementation(async (method, params) => { const result = await original(method, params); if (method === 'goal.continuation-action') throw new Error('lost original ACK'); return result })
    await rejectsOriginal(sendGoalOperation(f.client, owner, op, () => true), 'lost original ACK')
    const restored = new DeviceWorkfaceStore(() => localStorage); f.forward.mockImplementation(original)
    await sendGoalOperation(f.client, restored, restored.snapshot().record.goalWork!.pending[0]!, () => true)
    expect(f.calls.filter(call => call.method === 'goal.continuation-action').map(call => call.params)).toEqual([
      { goalId: goal.id, loopId: 'original-loop', action: 'pause', expectedRevision: 1, operationId: op.operationId },
      { goalId: goal.id, loopId: 'original-loop', action: 'pause', expectedRevision: 1, operationId: op.operationId }])
    expect(restored.snapshot().record.goalWork?.pending).toEqual([])
  })
  it('refuses an unrelated newer loop revision rather than adopting another action receipt', async () => {
    const current = { ...loop(), revision: 2, lastMutation: { operationId: 'other-operation', action: 'pause' as const, expectedRevision: 1 } }
    const f = goalFixture([current]), owner = getDeviceWorkface(), op = operation(f, 'action'); owner.retainGoalOperation(op)
    await rejectsOriginal(sendGoalOperation(f.client, owner, op, () => true), '版本已变化')
    expect(f.calls.some(call => call.method === 'goal.continuation-action')).toBe(false)
    expect(owner.snapshot().record.goalWork?.pending).toEqual([op])
  })
  it('refuses unknown initial resume and old Goal scope start but still permits stopping the exact old loop', async () => {
    const current = { ...loop(), status: 'paused' as const, initialDelivery: { ...loop().initialDelivery!, state: 'unknown' as const } }
    const f = goalFixture([current]), owner = getDeviceWorkface(), base = operation(f, 'action')
    if (base.kind !== 'action') throw new Error('Controlled original action required')
    await rejectsOriginal(sendGoalOperation(f.client, owner, { ...base, action: 'resume' }, () => true), '尚未确认')
    f.state.goal.alignment!.revision = 2
    await rejectsOriginal(sendGoalOperation(f.client, owner, operation(f), () => true))
    await sendGoalOperation(f.client, owner, { ...base, action: 'stop' }, () => true)
    expect(f.state.loops[0]!.status).toBe('stopped'); expect(f.submit).not.toHaveBeenCalled()
  })
  it('refuses duplicate loops and wrong original Host/provider/cwd facts without taking away manual input', async () => {
    const f = goalFixture([loop(), loop()])
    await rejectsOriginal(inspectGoal(f.client, goal.id, 'session-original'), '不一致')
    f.state.loops = [{ ...loop(), hostId: 'foreign-host' }]
    await rejectsOriginal(inspectGoal(f.client, goal.id, 'session-original'), '不一致')
    f.state.loops = [{ ...loop(), workspacePath: fixturePath("foreign-cwd") }]
    await rejectsOriginal(inspectGoal(f.client, goal.id, 'session-original'), '不一致')
    expect(f.submit).not.toHaveBeenCalled()
  })
  it('retains old durable bytes and the temporary same OP after a device save failure, and never forwards that write', async () => {
    const f = goalFixture(), view = await mount(renderPanel(f)); await click(button(view.element, `查看目标 ${goal.title}`))
    const before = localStorage.getItem('agentmux-mobile-workface-v1')
    vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => { throw new Error('device quota') })
    await click(button(view.element, '开始并持续推进'))
    expect(localStorage.getItem('agentmux-mobile-workface-v1')).toBe(before)
    expect(getDeviceWorkface().snapshot().record.goalWork?.pending).toHaveLength(1)
    expect(f.calls.some(call => call.method === 'goal.start')).toBe(false)
    expect(view.element.textContent).toContain('device quota')
  })
  it('enforces bounded intent records while preserving unrelated original drafts and pending bytes', () => {
    const f = goalFixture(), op = operation(f)
    const valid = { ...emptyDeviceWorkface(), goalWork: { selection: null, pending: Array.from({ length: 256 }, (_, i) => ({ ...op, operationId: 'original-' + i })) } }
    expect(parseDeviceWorkface(valid).goalWork?.pending).toHaveLength(256)
    expect(() => parseDeviceWorkface({ ...valid, goalWork: { selection: null, pending: [...valid.goalWork.pending, { ...op, operationId: 'overflow' }] } })).toThrow()
  })
})

describe('actual mobile Goal panel consumer', () => {
  it('does not select first Goal or mutate on mount/reconnect and retains last confirmed results offline', async () => {
    const f = goalFixture(), view = await mount(renderPanel(f))
    expect(view.element.querySelector('h1')?.textContent).toBe('目标与结果')
    expect(f.calls.filter(call => !['goal.ls', 'goal.inspect'].includes(call.method))).toEqual([])
    await click(button(view.element, `查看目标 ${goal.title}`))
    expect(view.element.textContent).toContain('准确完成原工作')
    await view.render(renderPanel(f, { connected: false }))
    expect(view.element.textContent).toContain('准确完成原工作'); expect(view.element.textContent).toContain('连接中断')
    await view.render(renderPanel(f))
    expect(f.calls.filter(call => !['goal.ls', 'goal.inspect'].includes(call.method))).toEqual([])
  })
  it('retains the exact selected detail when runtime observation disappears and does not adopt same SID on another Host', async () => {
    const f = goalFixture(), view = await mount(renderPanel(f)); await click(button(view.element, `查看目标 ${goal.title}`))
    const identity = f.client.runtimeOwnerIdentity
    f.client.runtimeOwnerIdentity = () => null
    await view.render(renderPanel(f, { connected: false }))
    expect(view.element.querySelector('h1')?.textContent).toBe(goal.title)
    expect(view.element.textContent).toContain('准确完成原工作')
    expect(getDeviceWorkface().snapshot().record.goalWork?.selection?.goalId).toBe(goal.id)
    f.client.runtimeOwnerIdentity = identity; f.identity('different-runtime')
    f.calls.length = 0; f.state.goal.title = '新Host同名地址'; f.state.goal.alignment!.summary = '其他Host的正文'
    await view.render(renderPanel(f))
    expect(view.element.querySelector('h1')?.textContent).toBe(goal.title)
    expect(view.element.textContent).toContain('当前连接尚未确认同一身份')
    expect(view.element.textContent).not.toContain('其他Host的正文')
    expect(button(view.element, '开始并持续推进').disabled).toBe(true)
    expect(f.calls.some(call => call.method === 'goal.inspect')).toBe(false)
    expect(f.calls.some(call => call.method === 'goal.start')).toBe(false)
  })
  it('allows the saved absent Relay ID to use the same confirmed Runtime and keeps the known-host pending visible', async () => {
    const f = goalFixture(), owner = getDeviceWorkface()
    owner.selectGoal(goalWorkTarget(f.client, owner, 'session-original', goal.id))
    owner.confirmHost({ origin: location.origin, hostId: 'confirmed-original-relay' })
    const original = f.forward.getMockImplementation()!
    f.forward.mockImplementation(async (method, params) => { const result = await original(method, params); if (method === 'goal.start') throw new Error('original receipt unknown'); return result })
    const view = await mount(renderPanel(f))
    expect(button(view.element, '开始并持续推进').disabled).toBe(false)
    await click(button(view.element, '开始并持续推进'))
    expect(f.calls.find(call => call.method === 'goal.start')?.params.sessionId).toBe('session-original')
    expect(view.element.textContent).toContain('原开始操作待确认')
    expect(button(view.element, '检查并重试原开始').disabled).toBe(false)
    expect(owner.snapshot().record.goalWork?.selection?.deviceHostId).toBeNull()
    expect(owner.snapshot().record.goalWork?.pending[0]?.deviceHostId).toBe('confirmed-original-relay')
  })
  it('refuses the original Goal focus exit when Runtime changes during its fresh inspection', async () => {
    const f = goalFixture(), view = await mount(renderPanel(f)); await click(button(view.element, `查看目标 ${goal.title}`))
    const wait = deferred<AgentMuxRpcResult<'goal.inspect'>>(), original = f.forward.getMockImplementation()!
    f.forward.mockImplementation((method, params) => method === 'goal.inspect' ? wait.promise : original(method, params))
    await act(async () => { button(view.element, '在 Host 查看原目标').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    f.identity('foreign-runtime')
    await act(async () => { wait.resolve({ goal, goalContinuations: [] }); await Promise.resolve() })
    expect(f.calls.some(call => call.method === 'goal.focus')).toBe(false)
    expect(view.element.textContent).toContain('不能把原目标导航发送到当前 Host')
  })
  it('requires scope confirmation, shows original acceptance separately, and starts only the exact selected Core Session', async () => {
    const f = goalFixture(); f.state.goal.grounding = { alignmentRevision: 1, summary: '原成果', checks: [{ criterionId: 'criterion', outcome: 'met', evidence: ['relative/result.md'], note: '原证据' }], submissionId: 'original-submission', acceptedAt: null }
    f.state.goal.alignment!.confirmedAt = null
    const view = await mount(renderPanel(f)); await click(button(view.element, `查看目标 ${goal.title}`))
    expect(view.element.textContent).toContain('等待人验收'); expect(view.element.textContent).toContain('relative/result.md')
    expect(button(view.element, '开始并持续推进').disabled).toBe(true)
    f.state.goal.alignment!.confirmedAt = 1; await click(button(view.element, '刷新目标状态'))
    await click(button(view.element, '开始并持续推进'))
    const write = f.calls.find(call => call.method === 'goal.start')!
    expect(write.params.sessionId).toBe('session-original'); expect(write.params.continuation.alignmentRevision).toBe(1)
    expect(write.params.operationId).toBeTruthy(); expect(f.submit).not.toHaveBeenCalled()
  })
  it('uses the durable original start from a restored Host loop, with no local attempt ref', async () => {
    const pending = { ...loop(), status: 'paused' as const, initialDelivery: { ...loop().initialDelivery!, state: 'unknown' as const } }
    const f = goalFixture([pending]), view = await mount(renderPanel(f)); await click(button(view.element, `查看目标 ${goal.title}`))
    expect(view.element.textContent).not.toContain('恢复')
    await click(button(view.element, '检查并重试原开始'))
    expect(f.calls.find(call => call.method === 'goal.start')?.params.operationId).toBe('original-start')
  })
  it('restores exact pending mutation after panel unmount and does no write until explicit same OP retry', async () => {
    const f = goalFixture([loop()]), view = await mount(renderPanel(f)); await click(button(view.element, `查看目标 ${goal.title}`))
    const original = f.forward.getMockImplementation()!
    f.forward.mockImplementation(async (method, params) => { const result = await original(method, params); if (method === 'goal.continuation-action') throw new Error('lost pause ACK'); return result })
    await click(button(view.element, '暂停'))
    const saved = getDeviceWorkface().snapshot().record.goalWork!.pending[0]!
    expect(saved.kind).toBe('action')
    await view.render(null); f.forward.mockImplementation(original); f.calls.length = 0
    await view.render(renderPanel(f))
    expect(view.element.querySelector('h1')?.textContent).toBe(goal.title)
    expect(f.calls.some(call => call.method === 'goal.continuation-action')).toBe(false)
    await click(button(view.element, '检查并重试原暂停'))
    expect(f.calls.find(call => call.method === 'goal.continuation-action')?.params.operationId).toBe(saved.operationId)
    expect(getDeviceWorkface().snapshot().record.goalWork?.pending).toEqual([])
  })
  it('does not replace original source-qualified details while a new namespace selection awaits its first read', async () => {
    const f = goalFixture(), view = await mount(renderPanel(f)); await click(button(view.element, `查看目标 ${goal.title}`))
    f.identity('new-runtime'); await view.render(renderPanel(f, { visible: false })); await view.render(renderPanel(f))
    await click(button(view.element, '全部目标'))
    const wait = deferred<AgentMuxRpcResult<'goal.inspect'>>(), original = f.forward.getMockImplementation()!
    f.forward.mockImplementation((method, params) => method === 'goal.inspect' ? wait.promise : original(method, params))
    await click(button(view.element, `查看目标 ${goal.title}`))
    expect(view.element.querySelector('h1')?.textContent).toBe('原目标')
    expect(view.element.textContent).not.toContain('准确完成原工作')
    const nextGoal = { ...goal, title: '新Host原目标', description: '新Host正文' }; delete nextGoal.alignment
    await act(async () => { wait.resolve({ goal: nextGoal, goalContinuations: [] }) })
    expect(view.element.textContent).toContain('新Host正文')
  })
  it('rejects late list/detail from A-B-A and does not steal a later Goal or write', async () => {
    const f = goalFixture(), wait = deferred<any>(); f.forward.mockImplementationOnce(() => wait.promise)
    const view = await mount(renderPanel(f)); await view.render(renderPanel(f, { agentSessionId: 'other' })); await view.render(renderPanel(f))
    await act(async () => { wait.resolve({ goals: [{ ...goal, id: 'late-old-goal', title: '迟到的旧目标' }] }) })
    expect(view.element.textContent).not.toContain('迟到的旧目标'); expect(view.element.querySelector('h1')?.textContent).toBe('目标与结果')
  })
  it('keeps the original Composer DOM node, draft and current selection through Goal open/close/offline', async () => {
    const f = goalFixture(), original = f.forward.getMockImplementation()!
    localStorage.setItem('agentmux-mobile-home', 'space')
    const catalog = { spaces: [{ spaceId: 'space', kind: 'folder', name: 'Original Space', hostId: 'host-original', directoryPath: fixturePath("space"), projectId: null }], zones: [],
      tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'workspace', name: 'Original Agent', regionIds: ['region'] }], regions: [{ regionId: 'region', tabId: 'tab', kind: 'agent', agentSessionId: 'session-original', runId: 'run-original', execution: { hostId: 'host-original', cwd: fixturePath("workspace") } }], bindings: [{ spaceId: 'space', zoneId: 'zone' }], locations: [{ spaceId: 'space', zoneId: 'zone', workspaceId: 'workspace', displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab', regionId: 'region' }] }
    f.forward.mockImplementation(async (method, params) => method.startsWith('goal.') ? original(method, params) : method === 'app.snapshot' ? { agents: [] } : method === 'agent.inspect' ? { session: f.client.agentSession('session-original'), displayName: { override: null, availability: 'observed' } } : { catalog })
    const app = (connected: boolean) => <MobileApp client={f.client} connection={{ state: connected ? 'connected' : 'disconnected', message: connected ? '原连接' : '连接不可用' }} platform={createBrowserPlatform()} />
    const view = await mount(app(true)); await click(view.element.querySelector<HTMLButtonElement>('.mobile-spatial-panel > .mobile-session-list button')!); await click(view.element.querySelector<HTMLButtonElement>('.mobile-spatial-tab .mobile-session-list button')!)
    await paste(view.element, '后来仍在编辑的原草稿'); const input = editor(view.element)
    await click(button(view.element, '目标与结果')); await click(button(view.element, `查看目标 ${goal.title}`)); await click(button(view.element, '返回原对话'))
    expect(editor(view.element)).toBe(input); expect(input.textContent).toContain('后来仍在编辑的原草稿')
    await view.render(app(false)); expect(editor(view.element)).toBe(input)
    expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original')
    expect(f.submit).not.toHaveBeenCalled()
  })
})
