import { useEffect, useState, useSyncExternalStore } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'
import { DEVICE_WORKFACE_KEY, getDeviceWorkface } from '../recovery/device-workface'
import type { MobileGoalOperationRecord } from '../recovery/goal-operation-record'
import { useMobileWebUpdateSafetyOwner } from '../mobile-web/update-safety'

type Pending = { item: MobileGoalOperationRecord; fence?: { runtimeId: string; ownerInstanceId: string }; recordId: string | null; inFlight: boolean; saved: boolean; confirmed: boolean; issue: string | null; exitRequested?: boolean; discarded?: boolean; saving?: Promise<void>; abort?: AbortController }
const operations = new Set<Pending>()
const listeners = new Set<() => void>()
let revision = 0
const notify = () => { revision++; for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const snapshot = () => revision

function persist(value: Pending): Promise<void> {
  if (value.saving) return value.saving
  let write: Promise<void>
  const confirming = value.confirmed
  const abort = new AbortController(); value.abort = abort
  try { write = confirming ? getDeviceWorkface().markGoalRequestConfirmed(value.item, value.recordId, abort.signal) : getDeviceWorkface().retainGoalRequest(value.item, value.recordId, abort.signal) }
  catch (error) { write = Promise.reject(error) }
  value.saving = write.then(() => { value.saved = true; value.issue = null; if (confirming) operations.delete(value) }, error => {
    value.issue = error instanceof Error ? error.message : String(error)
  }).finally(() => { delete value.saving; delete value.abort; notify() })
  return value.saving
}

/** Dispatch is independent of this best-effort bookkeeping. */
export function beginGoalOperation(client: AgentMuxHostedClient, method: MobileGoalOperationRecord['method'], request: MobileGoalOperationRecord['request']): Pending {
  const owner = getDeviceWorkface(), identity = owner.snapshotIdentity()
  let fence: Pending['fence']
  try { const runtime = client.runtimeOwnerIdentity(); if (runtime?.runtimeId && runtime.ownerInstanceId) fence = { runtimeId: runtime.runtimeId, ownerInstanceId: runtime.ownerInstanceId } } catch { /* Keep the request in the original page. */ }
  const item = { ...(fence ?? { runtimeId: null, ownerInstanceId: null }), deviceHostId: identity.host?.hostId ?? null, origin: identity.host?.origin ?? location.origin, method, request: structuredClone(request) }
  const value: Pending = { item, ...(fence ? { fence } : {}), recordId: identity.recordId, inFlight: true, saved: false, confirmed: false, issue: null }
  operations.add(value); notify(); void persist(value)
  return value
}

export async function finishGoalOperation(value: Pending, confirmed: boolean): Promise<boolean> {
  if (value.discarded) {
    if (!confirmed) return false
    value.discarded = false; value.inFlight = false; value.confirmed = true; value.saved = false
    value.issue = '原 RPC 在本页副本移除后已收到回执；请保存确认，或重新复制保全。'
    operations.add(value); notify()
    await persist(value)
    return value.saved
  }
  value.inFlight = false
  value.confirmed = confirmed
  notify()
  await value.saving
  if (value.exitRequested || value.discarded) return false
  if (confirmed) {
    if (value.saved) {
      try { await getDeviceWorkface().confirmGoalRequest(value.item, value.recordId) }
      catch (error) { value.saved = false; value.issue = error instanceof Error ? error.message : String(error); notify(); return false }
    }
    if (!value.saved && getDeviceWorkface().snapshot().issue) { notify(); return false }
    operations.delete(value); notify(); return true
  }
  notify(); return value.saved
}

/** Mounted for the whole app, so switching Goal views cannot lose an unsafe request. */
export function MobileGoalOperationSafety() {
  useMobileWebUpdateSafetyOwner(() => {
    const current = getDeviceWorkface().snapshot()
    const retained = new Map((current.record.goalOperationRecords ?? []).map(value => {
      const { confirmation: _confirmation, ...original } = value
      return [JSON.stringify(original), value] as const
    }))
    for (const item of operations) {
      const record = retained.get(JSON.stringify(item.item))
      if (!item.saved || current.issue || (current.record.recordId ?? null) !== item.recordId || !record || item.confirmed && record.confirmation !== 'confirmed') return '目标原请求或已收到的回执尚未保存在当前设备工作面；请在提醒与诊断中重试保存，当前页面可继续使用。'
    }
    return null
  })
  return null
}

export function MobileGoalOperationRecovery({ copyText }: { copyText: ClientUiPlatform['copyText'] }) {
  useSyncExternalStore(subscribe, snapshot)
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === DEVICE_WORKFACE_KEY) notify() }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [])
  const owner = getDeviceWorkface()
  useSyncExternalStore(owner.subscribeGoalIntents, owner.goalIntentRevision)
  const [copyIssue, setCopyIssue] = useState('')
  const [copied, setCopied] = useState<{ pending: Pending; content: string } | null>(null), [confirmingExit, setConfirmingExit] = useState<Pending | null>(null)
  const current = owner.snapshot(), saved = current.record.goalOperationRecords ?? []
  const key = (recordId: string | null, item: MobileGoalOperationRecord) => { const { confirmation: _confirmation, ...original } = item; return JSON.stringify([recordId, original]) }
  const byRecord = new Map<string, { values: Pending[]; offset: number }>(), used = new Set<Pending>()
  for (const pending of operations) {
    const identity = key(pending.recordId, pending.item), bucket = byRecord.get(identity) ?? { values: [], offset: 0 }
    bucket.values.push(pending); byRecord.set(identity, bucket)
  }
  const records = saved.map(item => {
    const bucket = byRecord.get(key(current.record.recordId ?? null, item))
    const pending = bucket?.values[bucket.offset++]
    if (pending) used.add(pending)
    return { item, pending }
  })
  for (const pending of operations) if (!used.has(pending)) records.push({ item: pending.item, pending })
  if (!records.length) return copyIssue ? <p role="status">{copyIssue}</p> : null
  const action = { 'goal.assign': '分配负责人', 'goal.start': '开始执行', 'goal.handoff': '交接', 'goal.delete': '删除', 'goal.link-session': '关联会话', 'goal.link-project': '关联项目' }
  return <section className="mobile-web-diagnostics mobile-goal-recovery" aria-label="未确认的目标操作"><h3>目标操作记录</h3><p>回执未确认时，请核对原请求；不会自动重发。</p>
    {records.map(({ item, pending }, index) => {
      const { request, method } = item
      const content = JSON.stringify({ ...item, result: pending?.confirmed || item.confirmation === 'confirmed' ? '原 RPC 已收到回执' : '原 RPC 回执未确认' }, null, 2)
      const retained = pending && !current.issue && pending.saved && used.has(pending)
      return <details key={`${request.operationId}:${index}`}><summary>{action[method]} · {request.goalId} · {pending?.inFlight ? '等待回执' : pending?.confirmed || item.confirmation === 'confirmed' ? '已收到原回执' : '回执未确认'}</summary>
        <pre>{content}</pre><button className="mobile-text-button" onClick={() => { void copyText(content, error => setCopyIssue(`复制未完成：${error instanceof Error ? error.message : String(error)}；原请求可手动选取。`)).then(success => { if (success && pending && operations.has(pending)) { setCopied({ pending, content }); setConfirmingExit(null); setCopyIssue('完整原请求已复制。') } }).catch(error => setCopyIssue(`复制未完成：${error instanceof Error ? error.message : String(error)}；原请求可手动选取。`)) }}>复制原请求</button>
        {pending && !retained && <><p>设备记录尚未确认：{pending.recordId !== (current.record.recordId ?? null) ? '设备工作面身份已变化；原请求不会写入其他记录。' : pending.issue ?? '请保全原请求'}</p><button className="mobile-text-button" disabled={Boolean(pending.saving) || !owner.canRetrySave()} onClick={() => {
          if (owner.recordIdentity() !== pending.recordId) { pending.issue = '设备工作面已替换；原请求不写入其他记录，请恢复原工作面后重试。'; notify(); return }
          void persist(pending)
        }}>{pending.confirmed ? '重试更新设备记录' : '保存原设备工作面'}</button></>}
        {pending && !retained && copied?.pending === pending && copied.content === content && (confirmingExit !== pending
          ? <button className="mobile-text-button" onClick={() => setConfirmingExit(pending)}>已另行保全，移除本页副本…</button>
          : <><p>确认已在别处保全完整原请求及当前回执状态？设备记录状态可能未知，未确认的回执需自行核对；设备存储故障仍需恢复。此操作不改动设备记录、不重发也不确认原操作。</p><button className="mobile-text-button" onClick={() => {
            const copiedContent = copied.content
            if (copiedContent !== JSON.stringify({ ...pending.item, result: pending.confirmed ? '原 RPC 已收到回执' : '原 RPC 回执未确认' }, null, 2)) { setCopied(null); setConfirmingExit(null); setCopyIssue('原操作状态已变化，请重新复制后再核对。'); return }
            pending.exitRequested = true; pending.abort?.abort()
            void (async () => {
              await pending.saving
              const actual = owner.readGoalRequest(pending.item, pending.recordId)
              const currentContent = JSON.stringify({ ...pending.item, result: pending.confirmed ? '原 RPC 已收到回执' : '原 RPC 回执未确认' }, null, 2)
              if (currentContent !== copiedContent) {
                pending.exitRequested = false; setCopyIssue('原操作状态已变化，请重新复制后再核对。')
              } else if (actual === 'confirmed') {
                pending.saved = true; pending.confirmed = true; pending.exitRequested = false; operations.delete(pending)
                setCopyIssue('原设备记录已保存该操作的确认状态，记录保留。')
              } else if (actual === 'saved') {
                pending.saved = !pending.confirmed; pending.exitRequested = false
                pending.issue = pending.confirmed ? '原请求已保存；已收到回执的确认状态尚未保存，请重试更新设备记录。' : null
                setCopyIssue('原请求已写入设备记录，未移除。')
              } else {
                pending.discarded = true; operations.delete(pending)
                setCopyIssue(actual === 'absent' ? '本页副本已移除；设备已有记录未删除，原操作没有重发。' : '本页副本已移除；设备原记录状态未知，未确认的回执需自行核对，设备存储故障仍需恢复。原操作没有重发。')
              }
              setConfirmingExit(null); setCopied(null); notify()
            })()
          }}>确认已保全并移除本页副本</button><button className="mobile-text-button" onClick={() => setConfirmingExit(null)}>取消移除</button></>)}
      </details>
    })}{copyIssue && <p role="status">{copyIssue}</p>}
  </section>
}
