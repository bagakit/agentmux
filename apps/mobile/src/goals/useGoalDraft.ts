import { useEffect, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxRpcGoal } from '@agentmux/core'
import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { getDeviceWorkface, DeviceWorkfaceRecordChangedError, type DeviceWorkfaceStore } from '../recovery/device-workface'
import { freezeMobileGoalUpdateRequest, mobileGoalDraftKey, parseMobileGoalDraft, parseMobileGoalDraftScope,
  sameMobileGoalDraftScope, MobileGoalDraftInvalidError, type MobileGoalDraft, type MobileGoalDraftScope,
  type MobileGoalEditOperation, type MobileGoalPatch } from '../recovery/goal-drafts'

type EditableDraft = Omit<MobileGoalDraft, 'scope'> & { scope: MobileGoalDraftScope | null }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const body = (goal: AgentMuxRpcGoal) => ({ title: goal.title, description: goal.description, updatedAt: goal.updatedAt })
const dirty = (draft: EditableDraft) => draft.title !== draft.baseline.title || draft.description !== draft.baseline.description

/** The original client and device owner supply scope; null is never a wildcard. */
export function mobileGoalDraftSource(client: AgentMuxHostedClient | null, owner: DeviceWorkfaceStore):
  { scope: MobileGoalDraftScope; ownerInstanceId: string } | null {
  try {
    const runtime = client?.runtimeOwnerIdentity(), record = owner.snapshot().record
    if (!runtime || runtime.availability !== 'connected' || !runtime.ownerInstanceId) return null
    const scope = parseMobileGoalDraftScope({ origin: record.host?.origin || record.hostUrl || location.origin,
      runtimeId: runtime.runtimeId, deviceHostId: record.host?.hostId ?? null })
    return { scope, ownerInstanceId: runtime.ownerInstanceId }
  } catch { return null }
}

/** Retain text and exact requests in the original device record. Reads do not settle unknown saves. */
export function useGoalDraft(goalId: string, goal: AgentMuxRpcGoal | null, factScope: MobileGoalDraftScope | null,
  client: AgentMuxHostedClient | null, connected: boolean, updated: (goal: AgentMuxRpcGoal, fields: Array<keyof AgentMuxRpcGoal>) => void) {
  const initial = useRef<{ owner: DeviceWorkfaceStore; recordId: string | null; saved: MobileGoalDraft | null; draft: EditableDraft } | null>(null)
  if (!initial.current) {
    const owner = getDeviceWorkface(), record = owner.snapshot().record
    const drafts = (record.goalDrafts ?? []).filter(value => value.goalId === goalId)
    const exact = factScope ? drafts.find(value => sameMobileGoalDraftScope(value.scope, factScope)) : undefined
    const retained = drafts.filter(value => value.scope.origin === (record.host?.origin || record.hostUrl || location.origin)
      && value.scope.deviceHostId === (record.host?.hostId ?? null))
    const saved = exact ?? (retained.length === 1 ? retained[0]! : null)
    initial.current = { owner, recordId: owner.recordIdentity(), saved,
      draft: saved ?? { goalId, scope: factScope, title: goal?.title ?? '', description: goal?.description ?? '',
        baseline: goal ? body(goal) : { title: '', description: '', updatedAt: 0 }, operations: [] } }
  }
  const { owner, recordId } = initial.current
  const [draft, setDraft] = useState<EditableDraft>(initial.current.draft)
  const current = useRef(draft); current.current = draft
  const durable = useRef<MobileGoalDraft | null>(initial.current.saved)
  const conflict = useRef<{ canonical: MobileGoalDraft | null } | null>(null)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const [storageIssue, setStorageIssue] = useState(''), [messages, setMessages] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false), flight = useRef(false), mounted = useRef(true)
  const context = useRef({ client, epoch: 0 }); if (context.current.client !== client) context.current = { client, epoch: context.current.epoch + 1 }
  const latest = useRef({ goal, factScope, connected }); latest.current = { goal, factScope, connected }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; context.current.epoch += 1 } }, [])
  const display = (next: EditableDraft) => { current.current = next; if (mounted.current) setDraft(next) }

  function retain(next: EditableDraft): Promise<{ canForward: boolean; committed: boolean }> {
    display(next)
    const work = queue.current.catch(() => {}).then(async () => {
      if (!next.scope) {
        if (mounted.current) setStorageIssue('原 Host 身份尚未核实；正文仍在本页可编辑，尚未进入工作面备份。请先复制保全，再连接原 Host。')
        return { canForward: false, committed: false }
      }
      if (conflict.current) return { canForward: false, committed: false }
      try {
        const parsed = parseMobileGoalDraft(next)
        const acknowledgement = await owner.editGoalDraft(durable.current, parsed, recordId)
        if (acknowledgement.recordId !== recordId || owner.recordIdentity() !== recordId) throw new DeviceWorkfaceRecordChangedError('原记录已替换；此页正文未写入新工作面。')
        if (!acknowledgement.applied) {
          conflict.current = { canonical: acknowledgement.draft }
          if (mounted.current) setStorageIssue('另一页面已保存这份目标草稿。原稿与本次完整正文／未知请求已分别保全；后来输入仍在本页，先复制或明确采用版本。本次请求未发送。')
          return { canForward: false, committed: false }
        }
        // Only this transaction's committed draft advances the durable baseline.
        durable.current = acknowledgement.draft
        if (mounted.current) setStorageIssue('')
        return { canForward: true, committed: true }
      } catch (error) {
        if (mounted.current) setStorageIssue(`${message(error)} 本页正文与原请求仍保留；请复制保全，备份中未确认包含本次输入。`)
        if (error instanceof DeviceWorkfaceRecordChangedError || error instanceof MobileGoalDraftInvalidError) return { canForward: false, committed: false }
        // A same-record I/O failure retains the original in-memory intent. It
        // does not deny an explicit original-Host request or local editing.
        return { canForward: owner.recordIdentity() === recordId && owner.canRetrySave() && owner.snapshot().issue !== null, committed: false }
      }
    })
    queue.current = work
    return work
  }
  useEffect(() => {
    const old = current.current
    if (!goal || goal.id !== goalId || !factScope || old.scope && !sameMobileGoalDraftScope(old.scope, factScope)
      || dirty(old) || old.operations.length || goal.updatedAt < old.baseline.updatedAt) return
    const next = { ...old, scope: old.scope ?? factScope, title: goal.title, description: goal.description, baseline: body(goal) }
    if (!same(old, next)) display(next)
  }, [goal, goalId, factScope])
  const editText = (field: 'title' | 'description', value: string) => { void retain({ ...current.current, [field]: value }) }
  function combinedOperations(canonical: MobileGoalDraft | null, old: EditableDraft) {
    const operations = [...(canonical?.operations ?? [])]
    for (const operation of old.operations) {
      const at = operations.findIndex(value => value.request.operationId === operation.request.operationId)
      const existing = operations[at]
      if (existing && (!same(existing.request, operation.request) || existing.ownerInstanceId !== operation.ownerInstanceId)) {
        setStorageIssue('同一原操作有不同完整请求；双方仍保全，请核对原请求，未发送新保存。'); return null
      }
      if (!existing) operations.push(operation)
      else if (operation.phase === 'unknown') operations[at] = operation
    }
    return operations
  }
  function keepDeviceConflict() {
    const held = conflict.current, old = current.current
    if (!held) return
    if (owner.recordIdentity() !== recordId) {
      setStorageIssue('原设备记录已替换；本页正文与原请求保留，未写入新工作面。请先复制保全。'); return
    }
    const operations = combinedOperations(held.canonical, old)
    if (!operations) return
    // Explicitly keep this page's complete text. No Host version is adopted,
    // and all original requests retain their original CAS and body.
    durable.current = held.canonical
    conflict.current = null
    void retain({ ...old, operations })
  }
  function rebase() {
    const old = current.current, facts = latest.current, source = mobileGoalDraftSource(client, owner)
    if (!facts.goal || !facts.factScope || !source || !sameMobileGoalDraftScope(facts.factScope, source.scope)
      || old.scope && !sameMobileGoalDraftScope(old.scope, source.scope) || owner.recordIdentity() !== recordId) {
      setStorageIssue('采用版本未完成：原目标与 Host 尚未匹配；当前正文和原请求保留。'); return
    }
    const canonical = conflict.current?.canonical
    if (conflict.current) durable.current = canonical ?? null
    const operations = combinedOperations(canonical ?? null, old)
    if (!operations) return
    conflict.current = null
    void retain({ ...old, scope: old.scope ?? source.scope,
      title: old.title === old.baseline.title ? facts.goal.title : old.title,
      description: old.description === old.baseline.description ? facts.goal.description : old.description,
      baseline: body(facts.goal), operations })
  }
  async function save(patch: MobileGoalPatch) {
    const old = current.current
    const field = 'title' in patch || 'description' in patch ? '正文' : 'status' in patch ? '工作状态' : '优先级'
    const report = (text: string) => { if (mounted.current) setMessages(values => ({ ...values, [field]: text })) }
    if (flight.current) return
    const source = mobileGoalDraftSource(client, owner), facts = latest.current
    if (!client?.forwardRpc || !facts.connected || !source || !old.scope || !sameMobileGoalDraftScope(old.scope, source.scope)
      || !facts.factScope || !sameMobileGoalDraftScope(facts.factScope, source.scope) || owner.recordIdentity() !== recordId) {
      report('保存未发送：原目标、Host 或设备记录尚未匹配；正文仍可编辑和复制保全。'); return
    }
    let request
    try { request = freezeMobileGoalUpdateRequest({ goalId, operationId: randomClientRequestId(), patch,
      expectedUpdatedAt: field === '正文' ? old.baseline.updatedAt : facts.goal?.updatedAt ?? old.baseline.updatedAt }) }
    catch (error) { report(`保存未发送：${message(error)} 当前正文保留。`); return }
    const operation: MobileGoalEditOperation = { request, ownerInstanceId: source.ownerInstanceId, phase: 'sending', issue: null }
    const originalClient = client, epoch = context.current.epoch
    const sameOwner = () => {
      const now = mobileGoalDraftSource(context.current.client, owner)
      return mounted.current && context.current.client === originalClient && context.current.epoch === epoch && latest.current.connected
        && owner.recordIdentity() === recordId && !!now && now.ownerInstanceId === operation.ownerInstanceId
        && sameMobileGoalDraftScope(now.scope, old.scope!)
    }
    const active = () => sameOwner() && current.current.operations.some(value => same(value, operation))
    flight.current = true; setSaving(true)
    try {
      const preserved = await retain({ ...old, operations: [...old.operations, operation] })
      if (!preserved.canForward || !active()) { report('保存未发送：原请求的保全或归属尚未核实，正文和完整请求保留。'); return }
      const result = await originalClient.forwardRpc!('goal.update', request)
      if (!active()) return
      if (result.goal.id !== goalId || result.receipt.goalId !== goalId || result.receipt.updatedAt !== result.goal.updatedAt
        || result.goal.updatedAt < request.expectedUpdatedAt) throw new Error('原保存回执的目标或版本未匹配。')
      const now = current.current, newest = latest.current.goal
      const stale = newest && newest.updatedAt > result.goal.updatedAt
      const bodyWrite = patch.title !== undefined || patch.description !== undefined
      const next = { ...now, operations: now.operations.filter(value => !same(value, operation)),
        ...(!stale && patch.title !== undefined && now.title === patch.title ? { title: result.goal.title } : {}),
        ...(!stale && patch.description !== undefined && now.description === patch.description ? { description: result.goal.description } : {}),
        baseline: stale || !bodyWrite && dirty(now) ? now.baseline : body(result.goal) }
      const settled = await retain(next)
      const unknown = { ...operation, phase: 'unknown' as const, issue: '原 Host 已回应保存，但设备记录尚未确认保存该回执；完整原请求继续保留。' }
      if (!sameOwner()) {
        // The old page keeps its guard; this branch cannot write the new
        // record/Host or publish the old response as their current facts.
        display({ ...current.current, operations: [...current.current.operations.filter(value => value.request.operationId !== operation.request.operationId), unknown] })
        if (mounted.current) setStorageIssue('原设备记录或 Host 已变化；本页正文与完整原请求保留，未将原回执写入新工作面。请先复制保全。')
        return
      }
      if (!settled.committed) {
        // Also retain the guard in the original Store's optimistic/exportable
        // record. A failed settlement must not remove it from backup bytes.
        await retain({ ...current.current, operations: [...current.current.operations.filter(value => value.request.operationId !== operation.request.operationId), unknown] })
        if (!sameOwner()) return
        report('原 Host 已确认此次保存；设备回执保全尚未完成，请复制当前正文并核对原请求。')
        return
      }
      if (!stale) updated(result.goal, Object.keys(patch) as Array<keyof AgentMuxRpcGoal>)
      report(stale ? '原保存回执已收到；较新版本与后来正文仍保留。' : '原目标已确认保存；后来正文与其他未确认请求保留。')
    } catch (error) {
      if (!active()) return
      await retain({ ...current.current, operations: current.current.operations.map(value => same(value, operation)
        ? { ...value, phase: 'unknown' as const, issue: message(error) } : value) })
      // The pending operation exposes the concise status and the complete
      // original diagnosis beside its frozen request. Do not repeat it here
      // or leave an earlier confirmation above this newer unknown save.
      if (mounted.current) setMessages(values => { const next = { ...values }; delete next[field]; return next })
    } finally { flight.current = false; if (mounted.current) setSaving(false) }
  }
  const remoteChanged = !!goal && !!factScope && (!draft.scope || sameMobileGoalDraftScope(draft.scope, factScope))
    && (goal.updatedAt !== draft.baseline.updatedAt || goal.title !== draft.baseline.title || goal.description !== draft.baseline.description)
    && (dirty(draft) || draft.operations.length > 0)
  const conflicts = owner.recordIdentity() === recordId ? (owner.snapshot().record.goalDraftConflicts ?? []).filter(value =>
    draft.scope && mobileGoalDraftKey(value.goalId, value.scope) === mobileGoalDraftKey(goalId, draft.scope)) : []
  return { draft, storageIssue, messages, saving, editText, save, rebase, remoteChanged, conflicts,
    storageConflict: conflict.current !== null, keepDeviceConflict }
}
