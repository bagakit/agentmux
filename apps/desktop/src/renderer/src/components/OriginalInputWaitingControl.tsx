import { useEffect, useRef, useState } from 'react'
import type { AgentInputSubmissionReceipt, AgentInputWaitRef, AgentInputWaitStopReceipt, AgentPromptInputKey } from '@agentmux/core'
import { agentPromptInputId } from '@agentmux/core/prompt-condition'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { api } from '../lib/api'
import '../styles/original-input-waiting.css'

type Props = { hostId: string; receipt: AgentInputSubmissionReceipt; onRefresh?: (() => void | Promise<unknown>) | undefined }
const inputKey = (key: AgentPromptInputKey) => [key.kind, key.agentSessionId, key.expectedRun.runId, agentPromptInputId(key)]
const referenceKey = (ref: AgentInputWaitRef) => JSON.stringify([...inputKey(ref.key), ref.waitGeneration])
const stopMessages: Record<AgentInputWaitStopReceipt['outcome'], string> = {
  'stopped-before-dispatch': '已停止这次等待，原消息保留。',
  'observation-stopped': '已停止等待观察；原输入可能已派发，未撤回。',
  'already-settled': '原输入已结束等待；请检查原输入结果。',
  'stale-generation': '等待批次已变化；未停止新的等待。重新打开详情查看当前等待。'
}

/** The original Core journal owns cancellation. A repeated explicit click uses the same original action identity. */
export function OriginalInputWaitingControl(props: Props) {
  return <OriginalWaiting key={JSON.stringify([props.hostId, ...inputKey(props.receipt.ref.key)])} {...props} />
}

function OriginalWaiting({ hostId, receipt, onRefresh }: Props) {
  // A newer parent observation cannot retarget an open original action or discard its in-flight ACK.
  const [ref] = useState(() => receipt.ref)
  const [cancelOperationId] = useState(() => `desktop-input-stop-v1:${bytesToHex(sha256(utf8ToBytes(JSON.stringify([hostId, ...inputKey(ref.key), ref.waitGeneration]))))}`)
  const alive = useRef(true), running = useRef(false)
  const [busy, setBusy] = useState<'stop' | 'check' | null>(null)
  const [ack, setAck] = useState<AgentInputWaitStopReceipt | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState<{ source: AgentInputSubmissionReceipt; value: AgentInputSubmissionReceipt | null } | null>(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const observed = checked?.source === receipt ? checked.value ?? receipt : receipt
  const changed = referenceKey(observed.ref) !== referenceKey(ref)
  const enabled = !changed && observed?.status === 'waiting' && observed.control.state === 'enabled'
  const control = { kind: 'agent' as const, hostId, agentSessionId: ref.key.agentSessionId, run: ref.key.expectedRun }

  async function refresh() {
    try { await onRefresh?.() }
    catch { if (alive.current) setError('刷新未确认；已收到的操作回执保留。') }
  }
  async function run(action: 'stop' | 'check') {
    if (running.current) return
    running.current = true; setBusy(action); setError(null)
    try {
      if (action === 'stop') {
        const result = await api.sessions.stopInputWaiting(control, ref, cancelOperationId)
        if (!alive.current) return
        if (referenceKey(result.ref) !== referenceKey(ref) || result.cancelOperationId !== cancelOperationId) {
          throw new Error('停止回执与原请求不匹配。')
        }
        setAck(result)
      } else {
        const result = await api.sessions.inspectInput(control, ref.key)
        if (!alive.current) return
        if (result && JSON.stringify(inputKey(result.key)) !== JSON.stringify(inputKey(ref.key))) {
          throw new Error('检查结果与原输入不匹配。')
        }
        setChecked({ source: receipt, value: result })
      }
      if (alive.current) await refresh()
    } catch (failure) {
      if (alive.current) setError(`${action === 'stop' ? '停止结果未确认；保留原请求，可检查后再次明确停止。' : '本次检查未确认；保留原记录。'} ${failure instanceof Error ? failure.message : String(failure)}`)
    } finally {
      if (alive.current) { running.current = false; setBusy(null) }
    }
  }

  if (!enabled && !changed && !ack && !checked && !error && !busy) return null
  return <section className="original-input-waiting" aria-label="原输入等待操作" data-original-input-waiting>
    <div className="original-input-waiting__actions">
      {enabled && !ack ? <button className="small-button" type="button" data-input-wait-action="stop" disabled={busy !== null} onClick={() => void run('stop')}>停止这次等待</button> : null}
      <button className="small-button" type="button" data-input-wait-action="check" disabled={busy !== null} onClick={() => void run('check')}>{busy === 'check' ? '正在检查…' : '检查原输入'}</button>
    </div>
    {busy === 'stop' ? <p role="status">正在停止这次等待…</p> : null}
    {ack ? <p role="status" data-input-stop-outcome={ack.outcome}>{ack.outcome === 'already-settled' && receipt.status === 'waiting'
      ? '上方等待状态是此前观测。原输入已结束等待；请检查原输入结果。' : stopMessages[ack.outcome]}</p> : null}
    {changed && ack?.outcome !== 'stale-generation' ? <p role="status" data-input-wait-generation>等待批次已变化；当前操作仍绑定原批次。重新打开详情可查看新的等待。</p> : null}
    {checked && !changed ? <p role="status" data-input-wait-observation>{checked.value === null ? '未读到原输入回执，结果仍未确认。'
      : observed?.status === 'waiting' ? '原输入仍在等待。'
      : observed?.status === 'stopped' ? '原输入已停止等待。'
      : observed?.status === 'admitted' ? '原输入已被 Agent 接收。'
      : observed?.status === 'terminal-confirmed' ? '原输入已写入终端；Agent 是否接收仍未确认。'
      : observed?.status === 'not-applied' ? '原输入未应用。' : '原输入结果未确认。'}</p> : null}
    {error ? <p role="status" data-input-wait-error>{error}</p> : null}
  </section>
}
