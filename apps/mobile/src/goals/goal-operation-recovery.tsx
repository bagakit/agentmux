import { useEffect, useState, useSyncExternalStore } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'
import { DEVICE_WORKFACE_KEY, getDeviceWorkface } from '../recovery/device-workface'
import type { MobileGoalOperationRecord } from '../recovery/goal-operation-record'
import { useMobileWebUpdateSafetyOwner } from '../mobile-web/update-safety'

type Pending = { item: MobileGoalOperationRecord; fence?: { runtimeId: string; ownerInstanceId: string }; recordId: string | null; inFlight: boolean; saved: boolean; confirmed: boolean; issue: string | null; saving?: Promise<void> }
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
  try { write = confirming ? getDeviceWorkface().confirmGoalRequest(value.item, value.recordId) : getDeviceWorkface().retainGoalRequest(value.item, value.recordId) }
  catch (error) { write = Promise.reject(error) }
  value.saving = write.then(() => { value.saved = true; value.issue = null; if (confirming) operations.delete(value) }, error => {
    value.issue = error instanceof Error ? error.message : String(error)
  }).finally(() => { delete value.saving; notify() })
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
  value.inFlight = false
  value.confirmed = confirmed
  notify()
  await value.saving
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
    const retained = new Set((current.record.goalOperationRecords ?? []).map(value => JSON.stringify(value)))
    for (const item of operations) {
      if (!item.saved || current.issue || (current.record.recordId ?? null) !== item.recordId || !retained.has(JSON.stringify(item.item))) return '目标原请求尚未保存在当前设备工作面；请在提醒与诊断中重试保存，当前页面可继续使用。'
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
  const current = owner.snapshot(), saved = current.record.goalOperationRecords ?? []
  const key = (recordId: string | null, item: MobileGoalOperationRecord) => JSON.stringify([recordId, item])
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
  if (!records.length) return null
  const action = { 'goal.assign': '分配负责人', 'goal.start': '开始执行', 'goal.handoff': '交接', 'goal.delete': '删除', 'goal.link-session': '关联会话', 'goal.link-project': '关联项目' }
  return <section className="mobile-web-diagnostics mobile-goal-recovery" aria-label="未确认的目标操作"><h3>目标操作记录</h3><p>回执未确认时，请核对原请求；不会自动重发。</p>
    {records.map(({ item, pending }, index) => {
      const { request, method } = item
      const content = JSON.stringify(item, null, 2)
      const retained = pending && !current.issue && pending.saved && used.has(pending)
      return <details key={`${request.operationId}:${index}`}><summary>{action[method]} · {request.goalId} · {pending?.inFlight ? '等待回执' : pending?.confirmed ? '已收到原回执，设备记录待更新' : '回执未确认'}</summary>
        <pre>{content}</pre><button className="mobile-text-button" onClick={() => { void copyText(content, error => setCopyIssue(`复制未完成：${error instanceof Error ? error.message : String(error)}；原请求可手动选取。`)) }}>复制原请求</button>
        {pending && !retained && <><p>设备记录尚未更新：{pending.issue ?? '请保全原请求'}</p><button className="mobile-text-button" disabled={Boolean(pending.saving) || !owner.canRetrySave()} onClick={() => { pending.recordId = owner.recordIdentity(); void persist(pending) }}>{pending.confirmed ? '重试更新设备记录' : '保存到当前设备工作面'}</button></>}
      </details>
    })}{copyIssue && <p role="status">{copyIssue}</p>}
  </section>
}
