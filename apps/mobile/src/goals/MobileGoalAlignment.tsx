import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxRpcGoal, AgentMuxRpcParams } from '@agentmux/core'
import { alignmentConfirmationIssue, groundingAcceptanceIssue } from '@agentmux/demand/goals'
import type { GoalDiscussionReceipt } from './MobileGoalCreate'
import { assertGoalIntentScope, goalIntentScope, useGoalIntents } from './goal-intents'
import type { GoalIntent } from '../recovery/device-workface'

/** Proposals remain with the Goal owner; only explicit people acknowledge them. */
export function MobileGoalAlignment({ client, goal, updated, openDiscussion, beginPresentation }: {
  client: AgentMuxHostedClient | null; goal: AgentMuxRpcGoal
  updated(goal: AgentMuxRpcGoal, fields: Array<keyof AgentMuxRpcGoal>): void
  openDiscussion(receipt: GoalDiscussionReceipt): void
  beginPresentation(): () => boolean
}) {
  const { owner, intents, issue: deviceIssue } = useGoalIntents(client)
  const retained = intents.find(intent => intent.kind !== 'create' && intent.goalId === goal.id)
  const currentGoal = useRef(goal); currentGoal.current = goal
  const flights = useRef(new Set<string>())
  const [pending, setPending] = useState<string[]>([]), [issue, setIssue] = useState('')
  const [localNeedsRead, setNeedsRead] = useState(false)
  const needsRead = !!retained || localNeedsRead
  const [records, setRecords] = useState<Array<{ method: string; params: unknown; message: string }>>([])
  const alignment = goal.alignment, grounding = goal.grounding
  const confirmIssue = alignmentConfirmationIssue(alignment)
  const acceptIssue = groundingAcceptanceIssue(alignment, grounding), gapIssue = groundingAcceptanceIssue(alignment, grounding, true)
  const accepted = !!grounding?.acceptedAt && gapIssue === null
  const humanPending = pending.some(method => method === 'goal.confirm' || method === 'goal.accept') || !!retained && owner.goalIntentRunning(retained.operationId)
  const start = (method: string) => { flights.current.add(method); setPending([...flights.current]) }
  const finish = (method: string) => { flights.current.delete(method); setPending([...flights.current]) }
  async function readCurrent() {
    if (flights.current.has('read') || humanPending) return
    if (!client?.forwardRpc) { setIssue('读取未发送：原目标公共端口暂不可用。原提案和记录保留。'); return }
    start('read')
    const before = JSON.stringify(currentGoal.current), recordId = owner.recordIdentity()
    try {
      if (retained) assertGoalIntentScope(client, owner, retained)
      const result = await client.forwardRpc('goal.inspect', { goalId: goal.id })
      if (!result.goal || result.goal.id !== goal.id) throw new Error('原目标当前未确认；其他目标不能代签它的结果。')
      const current = currentGoal.current
      const latest = JSON.stringify(current)
      const read = JSON.stringify(result.goal)
      if ((current.alignment?.revision ?? 0) > (result.goal.alignment?.revision ?? 0) || before !== latest && read !== latest && (result.goal.alignment?.revision ?? 0) <= (current.alignment?.revision ?? 0)) throw new Error('读取期间已显示较新提案或报告；迟到旧读取不能代签当前内容，请重新读取。')
      if (retained) await owner.settleGoalIntent(retained, 'confirmed', recordId, retained)
      updated(result.goal, ['alignment', 'grounding', 'title', 'description', 'status', 'sessionIds'])
      setNeedsRead(false); setIssue('已读取原目标当前内容。请读过当前提案和结果后，再明确选择；原未知记录保留。')
    } catch (error) { setIssue(`读取当前提案未确认：${error instanceof Error ? error.message : String(error)}。原内容和记录保留。`) }
    finally { finish('read') }
  }
  async function invoke(method: 'goal.discuss' | 'goal.confirm' | 'goal.accept', params: AgentMuxRpcParams<typeof method>) {
    if (flights.current.has(method) || method !== 'goal.discuss' && (needsRead || humanPending || flights.current.has('read'))) return
    if (!client?.forwardRpc) { setIssue('请求未发送：原目标公共端口暂不可用，原目标与会话保留。'); return }
    start(method)
    const input = { ...params, operationId: randomClientRequestId() }
    const present = beginPresentation(), recordId = owner.recordIdentity()
    let retainedIntent: GoalIntent | undefined
    try {
      if (method !== 'goal.discuss') {
        const target = goalIntentScope(client, owner)
        retainedIntent = method === 'goal.confirm' ? { ...target, goalId: goal.id, operationId: input.operationId, phase: 'sending', kind: 'confirm', expectedRevision: (params as AgentMuxRpcParams<'goal.confirm'>).expectedRevision }
          : { ...target, goalId: goal.id, operationId: input.operationId, phase: 'sending', kind: 'accept', expectedAlignmentRevision: (params as AgentMuxRpcParams<'goal.accept'>).expectedAlignmentRevision, expectedSubmissionId: (params as AgentMuxRpcParams<'goal.accept'>).expectedSubmissionId, acceptGaps: (params as AgentMuxRpcParams<'goal.accept'>).acceptGaps }
        await owner.retainGoalIntent(retainedIntent, recordId)
      }
      if (method === 'goal.discuss') {
        const result = await client.forwardRpc(method, input as AgentMuxRpcParams<'goal.discuss'>)
        if (result.goal.id !== goal.id || result.receipt.goalId !== goal.id || result.receipt.operationId !== input.operationId || result.receipt.mode !== (params as AgentMuxRpcParams<'goal.discuss'>).mode) throw new Error('原讨论回执身份未匹配。')
        setIssue(result.receipt.agentSessionId ? '原目标讨论工作面已打开；队列或导航回执不代表 Agent 已接受或完成请求。' : '原目标专属 Tab 已保留。Agent 尚未接上；请在 Mac 的原主 Mote 工作面选择 Agent 并启动。')
        if (present()) openDiscussion(result.receipt)
      } else if (method === 'goal.confirm') {
        const result = await client.forwardRpc(method, input as AgentMuxRpcParams<'goal.confirm'>)
        if (result.goal.id !== goal.id || result.receipt.goalId !== goal.id || result.receipt.confirmedRevision !== alignment?.revision || result.goal.alignment?.confirmedAt !== result.receipt.confirmedAt) throw new Error('原目标确认回执未匹配当前提案。')
        owner.releaseGoalIntent(retainedIntent!, recordId); await owner.settleGoalIntent(retainedIntent!, 'confirmed', recordId, retainedIntent!)
        if ((currentGoal.current.alignment?.revision ?? 0) <= result.receipt.confirmedRevision) {
          updated(result.goal, ['alignment']); setIssue('已确认读过的当前目标提案。')
        } else setIssue('原确认回执已收到；当前已有较新提案，保留较新内容，仍需重新阅读。')
      } else {
        const result = await client.forwardRpc(method, input as AgentMuxRpcParams<'goal.accept'>)
        if (result.goal.id !== goal.id || result.receipt.goalId !== goal.id || result.receipt.submissionId !== grounding?.submissionId || result.receipt.alignmentRevision !== alignment?.revision || result.goal.grounding?.acceptedAt !== result.receipt.acceptedAt) throw new Error('原结果接受回执未匹配当前报告。')
        owner.releaseGoalIntent(retainedIntent!, recordId); await owner.settleGoalIntent(retainedIntent!, 'confirmed', recordId, retainedIntent!)
        if (currentGoal.current.alignment?.revision === result.receipt.alignmentRevision && currentGoal.current.grounding?.submissionId === result.receipt.submissionId) {
          updated(result.goal, ['grounding']); setIssue(result.receipt.acceptedWithGaps ? '已接受原结果，报告差距仍保留。' : '已接受当前原结果。')
        } else setIssue('原接受回执已收到；当前已有另一提案或报告，保留当前内容，不能用旧回执认可新结果。')
      }
    } catch (error) {
      if (retainedIntent) {
        owner.releaseGoalIntent(retainedIntent, recordId)
        try { await owner.settleGoalIntent(retainedIntent, 'unknown', recordId, retainedIntent) } catch { /* Original device bytes and intent remain available for recovery. */ }
      }
      const message = error instanceof Error ? error.message : String(error)
      setRecords(values => [...values, { method, params: input, message }])
      if (method !== 'goal.discuss') setNeedsRead(true)
      setIssue(`原操作回执未确认：${message}。原提案、报告与会话保留；先读取当前内容，不会自动再次提交。`)
    } finally { if (retainedIntent) owner.releaseGoalIntent(retainedIntent, recordId); finish(method) }
  }
  const acknowledgementAvailable = !needsRead && !humanPending && !pending.includes('read')
  return <section className="mobile-goal-alignment" aria-label="目标确认与原讨论">
    {needsRead && <button type="button" disabled={pending.includes('read')} onClick={() => void readCurrent()}>读取当前提案与报告</button>}
    {!alignment?.confirmedAt && alignment && !confirmIssue && acknowledgementAvailable && <button type="button" onClick={() => void invoke('goal.confirm', { goalId: goal.id, expectedRevision: alignment.revision })}>确认当前目标</button>}
    {confirmIssue && alignment && <p>目标待明确：{confirmIssue}</p>}
    {!accepted && alignment && grounding && !acceptIssue && acknowledgementAvailable && <button type="button" onClick={() => void invoke('goal.accept', { goalId: goal.id, expectedAlignmentRevision: alignment.revision, expectedSubmissionId: grounding.submissionId, acceptGaps: false })}>接受当前结果</button>}
    {!accepted && alignment && grounding && acceptIssue && gapIssue === null && acknowledgementAvailable && <button type="button" onClick={() => void invoke('goal.accept', { goalId: goal.id, expectedAlignmentRevision: alignment.revision, expectedSubmissionId: grounding.submissionId, acceptGaps: true })}>接受结果并保留差距</button>}
    {acceptIssue && grounding && !accepted && <p>结果待核对：{acceptIssue}</p>}
    {humanPending && <p role="status">原操作正在等待回执，原工作面保留。</p>}{issue && <p role="status">{issue}</p>}{deviceIssue && <p role="status">{deviceIssue}</p>}
    {retained && !humanPending && <p role="status">原人认可回执未知，准确目标版本、结果和操作身份保留；先读取当前提案与报告，不会重复提交。</p>}
    <div className="mobile-goal-discussion-actions">
      <button type="button" disabled={pending.includes('goal.discuss')} onClick={() => void invoke('goal.discuss', { goalId: goal.id, mode: 'open' })}>打开目标原讨论</button>
      <button type="button" disabled={pending.includes('goal.discuss')} onClick={() => void invoke('goal.discuss', { goalId: goal.id, mode: 'grill' })}>{alignment ? '讨论目标变更' : '澄清目标'}</button>
      {alignment?.confirmedAt && <button type="button" disabled={pending.includes('goal.discuss')} onClick={() => void invoke('goal.discuss', { goalId: goal.id, mode: 'grounding' })}>{grounding ? '请求重新核对结果' : '请求核对结果'}</button>}
    </div>
    {retained && <details><summary>原设备认可意图</summary><pre>{JSON.stringify(retained, null, 2)}</pre></details>}
    {!!records.length && <details><summary>原操作未确认记录（{records.length}）</summary>{records.map((value, index) => <div key={index}><p>{value.message}</p><code>{value.method}</code><pre>{JSON.stringify(value.params, null, 2)}</pre></div>)}</details>}
  </section>
}
