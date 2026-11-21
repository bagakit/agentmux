import { MobileNotice } from '../notices/MobileNotice'
import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { useRef, useState } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import dialogueArt from '@agentmux/client-ui/brand/illustrations/goals/demand-dialogue.png'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxRpcGoal, AgentMuxRpcParams } from '@agentmux/core'
import { alignmentConfirmationIssue, groundingAcceptanceIssue, isCurrentGroundingAccepted } from '@agentmux/demand/goals'
import type { GoalDiscussionReceipt } from './MobileGoalCreate'
import { assertGoalIntentScope, goalIntentScope, useGoalIntents } from './goal-intents'
import type { GoalIntent } from '../recovery/device-workface'

/** Proposals remain with the Goal owner; only explicit people acknowledge them. */
export function MobileGoalAlignment({ client, goal, updated, openDiscussion, beginPresentation, visible }: {
  client: AgentMuxHostedClient | null; goal: AgentMuxRpcGoal; visible: boolean
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
  // This summary explains observed Goal facts. The original domain issues still
  // decide eligibility and stay available in full; display copy grants no action.
  const acceptanceSummary = !alignment ? '请先提出目标与成功标准，再核对结果。'
    : alignment.confirmedAt === null ? '请先确认当前目标，再接受结果。'
    : grounding?.alignmentRevision !== alignment.revision ? '结果报告对应旧版目标，请核对当前目标与结果。'
    : '当前结果还不满足接受条件，请查看核对原因。'
  const accepted = isCurrentGroundingAccepted(alignment, grounding)
  const humanPending = pending.some(method => method === 'goal.confirm' || method === 'goal.accept') || !!retained && owner.goalIntentRunning(retained.operationId)
  const start = (method: string) => { flights.current.add(method); setPending([...flights.current]) }
  const finish = (method: string) => { flights.current.delete(method); setPending([...flights.current]) }
  async function readCurrent() {
    if (flights.current.has('read') || humanPending) return
    if (!client?.forwardRpc) { setIssue('读取未发送：Mac 上的目标服务暂不可用。'); return }
    start('read')
    const before = JSON.stringify(currentGoal.current), recordId = owner.recordIdentity()
    try {
      if (retained) assertGoalIntentScope(client, owner, retained)
      const result = await client.forwardRpc('goal.inspect', { goalId: goal.id })
      if (!result.goal || result.goal.id !== goal.id) throw new Error('没有读到这个目标')
      const current = currentGoal.current
      const latest = JSON.stringify(current)
      const read = JSON.stringify(result.goal)
      if ((current.alignment?.revision ?? 0) > (result.goal.alignment?.revision ?? 0) || before !== latest && read !== latest && (result.goal.alignment?.revision ?? 0) <= (current.alignment?.revision ?? 0)) throw new Error('读取期间已显示较新提案或报告；迟到旧读取不能代签当前内容，请重新读取。')
      if (retained) await owner.settleGoalIntent(retained, 'confirmed', recordId, retained)
      updated(result.goal, ['alignment', 'grounding', 'title', 'description', 'status', 'sessionIds'])
      setNeedsRead(false); setIssue('已读取当前目标。请看过提案和结果后再选择。')
    } catch (error) { setIssue(`读取当前提案没有完成：${error instanceof Error ? error.message : String(error)}。可以再试一次。`) }
    finally { finish('read') }
  }
  async function invoke(method: 'goal.discuss' | 'goal.confirm' | 'goal.accept', params: AgentMuxRpcParams<typeof method>) {
    if (flights.current.has(method) || method !== 'goal.discuss' && (needsRead || humanPending || flights.current.has('read'))) return
    if (!client?.forwardRpc) { setIssue('请求未发送：Mac 上的目标服务暂不可用。'); return }
    start(method)
    const input = { ...params, operationId: randomClientRequestId() }
    const present = beginPresentation(), recordId = owner.recordIdentity()
    let retainedIntent: GoalIntent | undefined
    try {
      if (method !== 'goal.discuss') {
        const target = goalIntentScope(client, owner)
        retainedIntent = method === 'goal.confirm' ? { ...target, goalId: goal.id, operationId: input.operationId, phase: 'sending', kind: 'confirm', expectedRevision: (params as AgentMuxRpcParams<'goal.confirm'>).expectedRevision }
          : { ...target, goalId: goal.id, operationId: input.operationId, phase: 'sending', kind: 'accept', expectedAlignmentRevision: (params as AgentMuxRpcParams<'goal.accept'>).expectedAlignmentRevision, expectedSubmissionId: (params as AgentMuxRpcParams<'goal.accept'>).expectedSubmissionId, acceptGaps: (params as AgentMuxRpcParams<'goal.accept'>).acceptGaps, ...((params as AgentMuxRpcParams<'goal.accept'>).finish === true ? { finish: true } : {}) }
        await owner.retainGoalIntent(retainedIntent, recordId)
      }
      if (method === 'goal.discuss') {
        const result = await client.forwardRpc(method, input as AgentMuxRpcParams<'goal.discuss'>)
        if (result.goal.id !== goal.id || result.receipt.goalId !== goal.id || result.receipt.operationId !== input.operationId || result.receipt.mode !== (params as AgentMuxRpcParams<'goal.discuss'>).mode) throw new Error('返回的讨论与这次请求不一致')
        setIssue(result.receipt.agentSessionId ? '已打开目标讨论。' : '讨论页已建好，还没有 Agent 接上；请在 Mac 上为主 Mote 选择 Agent 并启动。')
        if (present()) openDiscussion(result.receipt)
      } else if (method === 'goal.confirm') {
        const result = await client.forwardRpc(method, input as AgentMuxRpcParams<'goal.confirm'>)
        if (result.goal.id !== goal.id || result.receipt.goalId !== goal.id || result.receipt.confirmedRevision !== alignment?.revision || result.goal.alignment?.confirmedAt !== result.receipt.confirmedAt) throw new Error('Mac 返回的确认与当前提案不一致')
        owner.releaseGoalIntent(retainedIntent!, recordId); await owner.settleGoalIntent(retainedIntent!, 'confirmed', recordId, retainedIntent!)
        if ((currentGoal.current.alignment?.revision ?? 0) <= result.receipt.confirmedRevision) {
          updated(result.goal, ['alignment']); setIssue('已确认读过的当前目标提案。')
        } else setIssue('Mac 已确认，但现在有更新的提案，请重新阅读。')
      } else {
        const result = await client.forwardRpc(method, input as AgentMuxRpcParams<'goal.accept'>)
        if (result.goal.id !== goal.id || result.receipt.goalId !== goal.id || result.receipt.submissionId !== grounding?.submissionId || result.receipt.alignmentRevision !== alignment?.revision || result.goal.grounding?.acceptedAt !== result.receipt.acceptedAt) throw new Error('Mac 返回的验收与当前报告不一致')
        owner.releaseGoalIntent(retainedIntent!, recordId); await owner.settleGoalIntent(retainedIntent!, 'confirmed', recordId, retainedIntent!)
        if (currentGoal.current.alignment?.revision === result.receipt.alignmentRevision && currentGoal.current.grounding?.submissionId === result.receipt.submissionId) {
          updated(result.goal, ['grounding', 'status']); setIssue(result.goal.status === 'done' ? '已验收并结束目标。' : result.receipt.acceptedWithGaps ? '已验收并保留差距。' : '已验收。')
        } else setIssue('Mac 已确认验收，但现在有新的提案或报告，请重新阅读。')
      }
    } catch (error) {
      if (retainedIntent) {
        owner.releaseGoalIntent(retainedIntent, recordId)
        try { await owner.settleGoalIntent(retainedIntent, 'unknown', recordId, retainedIntent) } catch { /* Original device bytes and intent remain available for recovery. */ }
      }
      const message = error instanceof Error ? error.message : String(error)
      setRecords(values => [...values, { method, params: input, message }])
      if (method !== 'goal.discuss') setNeedsRead(true)
      setIssue(`Mac 还没确认这次操作：${message}。请先读取当前提案与报告。`)
    } finally { if (retainedIntent) owner.releaseGoalIntent(retainedIntent, recordId); finish(method) }
  }
  const acknowledgementAvailable = !needsRead && !humanPending && !pending.includes('read')
  return <section className="mobile-goal-alignment" aria-label="目标确认与讨论">
    {needsRead && <Button type="button" disabled={pending.includes('read')} onClick={() => void readCurrent()}>读取当前提案与报告</Button>}
    {!alignment?.confirmedAt && alignment && !confirmIssue && acknowledgementAvailable && <Button type="button" variant="primary" className="mobile-goal-decision" onClick={() => void invoke('goal.confirm', { goalId: goal.id, expectedRevision: alignment.revision })}>确认当前目标</Button>}
    {confirmIssue && alignment && <p>目标待明确：{confirmIssue}</p>}
    {alignment && grounding && gapIssue === null && goal.status !== 'done' && acknowledgementAvailable && <Button type="button" variant="primary" className="mobile-goal-decision" onClick={() => void invoke('goal.accept', { goalId: goal.id, expectedAlignmentRevision: alignment.revision, expectedSubmissionId: grounding.submissionId, acceptGaps: grounding.checks.some(check => check.outcome === 'gap'), finish: true })}>{accepted ? '结束目标' : grounding.checks.some(check => check.outcome === 'gap') ? '接受差距并结束目标' : '接受并结束目标'}</Button>}
    {accepted && <p>{grounding?.unknownDecision ? '已结案，仍有未核实结果。' : goal.status === 'done' ? '已验收，目标已结束。' : '已验收，目标仍开放。'}</p>}
    {!accepted && alignment && grounding && !acceptIssue && acknowledgementAvailable && <Button type="button" onClick={() => void invoke('goal.accept', { goalId: goal.id, expectedAlignmentRevision: alignment.revision, expectedSubmissionId: grounding.submissionId, acceptGaps: false })}>接受当前结果</Button>}
    {!accepted && alignment && grounding && acceptIssue && gapIssue === null && acknowledgementAvailable && <Button type="button" onClick={() => void invoke('goal.accept', { goalId: goal.id, expectedAlignmentRevision: alignment.revision, expectedSubmissionId: grounding.submissionId, acceptGaps: true })}>接受结果并保留差距</Button>}
    {acceptIssue && grounding && !accepted && <><p>结果待核对：{acceptanceSummary}</p><details><summary>查看核对原因</summary><p>{acceptIssue}</p></details></>}
    {humanPending && <p role="status">正在等待 Mac 确认…</p>}{issue && <MobileNotice identity={[goal.id,issue,deviceIssue]} role="status">{issue}</MobileNotice>}{deviceIssue && <MobileNotice identity={[goal.id,issue,deviceIssue]} role="status">{deviceIssue}</MobileNotice>}
    {retained && !humanPending && <MobileNotice identity={[retained?.operationId]} role="status">还不确定你的确认是否已生效；请先读取当前提案与报告。</MobileNotice>}
    <div className="mobile-goal-discussion-heading">{visible && <img src={dialogueArt} alt="" width="64" height="46" loading="lazy" decoding="async" />}<div><h3>和 Mote 一起想清楚</h3><p>讨论目标，也核对做成的结果。</p></div></div>
    <div className="mobile-goal-discussion-actions">
      <Button type="button" disabled={pending.includes('goal.discuss')} onClick={() => void invoke('goal.discuss', { goalId: goal.id, mode: 'open' })}>打开目标讨论</Button>
      <Button type="button" disabled={pending.includes('goal.discuss')} onClick={() => void invoke('goal.discuss', { goalId: goal.id, mode: 'grill' })}>{alignment ? '讨论目标变更' : '澄清目标'}</Button>
      {alignment?.confirmedAt && <Button type="button" disabled={pending.includes('goal.discuss')} onClick={() => void invoke('goal.discuss', { goalId: goal.id, mode: 'grounding' })}>{grounding ? '请求重新核对结果' : '请求核对结果'}</Button>}
    </div>
    {retained && <details><summary>本机记录的确认请求</summary><pre>{JSON.stringify(retained, null, 2)}</pre></details>}
    {!!records.length && <details><summary>未确认的操作（{records.length}）</summary>{records.map((value, index) => <div key={index}><p>{value.message}</p><code>{value.method}</code><pre>{JSON.stringify(value.params, null, 2)}</pre></div>)}</details>}
  </section>
}
