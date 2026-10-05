import { useEffect, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { parseTopicResult, type TopicKnowledge } from '@agentmux/core/control'
import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { getDeviceWorkface, DeviceWorkfaceRecordChangedError, type DeviceWorkfaceStore } from '../recovery/device-workface'
import { freezeMobileKnowledgeInput, mobileKnowledgeDraftKey, parseMobileKnowledgeDraft,
  parseMobileKnowledgeDraftKey, parseMobileKnowledgeDraftScope, sameMobileKnowledgeDraftScope,
  MobileKnowledgeDraftInvalidError, type MobileKnowledgeDraft, type MobileKnowledgeDraftScope,
  type MobileKnowledgeAttempt } from '../recovery/knowledge-drafts'

type EditableDraft = Omit<MobileKnowledgeDraft, 'scope'> & { scope: MobileKnowledgeDraftScope | null }
export type MobileKnowledgeEditTarget = { topicId: string; entryId: string; entry?: TopicKnowledge;
  scope?: MobileKnowledgeDraftScope | null; draftKey?: string; isNew?: boolean }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const authored = (draft: EditableDraft) => ({ title: draft.title.trim(), content: draft.content, form: draft.form,
  certainty: draft.certainty, sources: draft.sources, ...(draft.authoringScope.trim() ? { scope: draft.authoringScope.trim() } : {}) })

/** Read the original client identity, never infer a Host from the RPC function. */
export function mobileKnowledgeDraftSource(client: AgentMuxHostedClient | null, owner: DeviceWorkfaceStore):
  { scope: MobileKnowledgeDraftScope; ownerInstanceId: string } | null {
  try {
    const runtime = client?.runtimeOwnerIdentity(), record = owner.snapshot().record
    if (!runtime || runtime.availability !== 'connected' || !runtime.ownerInstanceId) return null
    return { scope: parseMobileKnowledgeDraftScope({ origin: record.host?.origin || record.hostUrl || location.origin,
      runtimeId: runtime.runtimeId, deviceHostId: record.host?.hostId ?? null }), ownerInstanceId: runtime.ownerInstanceId }
  } catch { return null }
}
function restore(draft: MobileKnowledgeDraft): MobileKnowledgeDraft {
  return { ...draft, attempts: draft.attempts.map(attempt => attempt.phase === 'sending'
    ? { ...attempt, phase: 'unknown', issue: attempt.issue ?? '原页面的保存回执尚未确认；完整原请求保留，重开不会重发。' } : attempt) }
}

/** One scoped device draft. Public reads never settle its unknown attempts. */
export function useKnowledgeDraft(target: MobileKnowledgeEditTarget, client: AgentMuxHostedClient | null,
  connected: boolean, onSaved: (entry: TopicKnowledge, keepEditing: boolean) => void) {
  const initial = useRef<{ owner: DeviceWorkfaceStore; recordId: string | null; saved: MobileKnowledgeDraft | null;
    draft: EditableDraft; choices: MobileKnowledgeDraft[] } | null>(null)
  if (!initial.current) {
    const owner = getDeviceWorkface(), record = owner.snapshot().record, source = mobileKnowledgeDraftSource(client, owner)
    const choices = (record.knowledgeDrafts ?? []).filter(value => value.topicId === target.topicId && value.entryId === target.entryId)
    let exactKey: string | null = null
    if (target.draftKey) {
      try {
        const key = parseMobileKnowledgeDraftKey(target.draftKey)
        if (key.topicId === target.topicId && key.entryId === target.entryId) exactKey = target.draftKey
      } catch { /* A malformed reference cannot choose another stored draft. */ }
    } else if (source) exactKey = mobileKnowledgeDraftKey(target.topicId, target.entryId, target.scope ?? source.scope)
    const saved = choices.find(value => mobileKnowledgeDraftKey(value.topicId, value.entryId, value.scope) === exactKey) ?? null
    const entry = target.entry
    const scope = saved?.scope ?? (target.scope === undefined ? source?.scope ?? null : target.scope)
    initial.current = { owner, recordId: owner.recordIdentity(), saved, choices,
      draft: saved ? restore(saved) : { topicId: target.topicId, entryId: target.entryId, scope,
        title: entry?.title ?? '', content: entry?.content ?? '', form: entry?.form ?? 'derived', certainty: entry?.certainty ?? 'proposal',
        sources: structuredClone(entry?.sources ?? []), authoringScope: entry?.scope ?? '', expectedRevision: entry?.revision ?? null,
        attempts: [], blockedAttemptId: null } }
  }
  const { owner, recordId } = initial.current
  const [draft, setDraft] = useState<EditableDraft>(initial.current.draft), current = useRef(draft)
  const durable = useRef(initial.current.saved), queue = useRef<Promise<unknown>>(Promise.resolve())
  const [storageIssue, setStorageIssue] = useState(''), [notice, setNotice] = useState(''), [saving, setSaving] = useState(false)
  const [checked, setChecked] = useState<{ entry: TopicKnowledge | null; scope: MobileKnowledgeDraftScope; ownerInstanceId: string } | null>(null)
  const [localCopies, setLocalCopies] = useState<EditableDraft[]>([])
  const conflict = useRef<{ canonical: MobileKnowledgeDraft | null } | null>(null)
  const flight = useRef(false), mounted = useRef(true)
  const newIntentRetained = useRef(initial.current.saved !== null || target.isNew !== true)
  const edited = useRef(false), baselineKnown = useRef(initial.current.saved !== null || target.entry !== undefined || target.isNew === true)
  const context = useRef({ client, epoch: 0 }); if (context.current.client !== client) context.current = { client, epoch: context.current.epoch + 1 }
  const latest = useRef({ connected, onSaved }); latest.current = { connected, onSaved }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; context.current.epoch += 1 } }, [])
  const display = (next: EditableDraft) => { current.current = next; if (mounted.current) setDraft(next) }
  useEffect(() => {
    const entry = target.entry, source = mobileKnowledgeDraftSource(client, owner), old = current.current
    if (!entry || entry.topicId !== old.topicId || entry.entryId !== old.entryId || !source || !target.scope
      || !sameMobileKnowledgeDraftScope(source.scope, target.scope) || owner.recordIdentity() !== recordId) return
    // A late original read can initialize an untouched empty editor, never
    // overwrite an existing durable draft or input typed while it was pending.
    if (!baselineKnown.current && !edited.current && durable.current === null && old.attempts.length === 0) {
      baselineKnown.current = true
      display({ ...old, scope: target.scope, title: entry.title, content: entry.content, form: entry.form,
        certainty: entry.certainty, sources: structuredClone(entry.sources), authoringScope: entry.scope ?? '', expectedRevision: entry.revision })
    } else if (!baselineKnown.current) setChecked({ entry, ...source })
  }, [target.entry, target.scope, client, owner, recordId])

  function retain(next: EditableDraft, originalOwner?: () => boolean): Promise<{ canForward: boolean; committed: boolean }> {
    display(next)
    const work = queue.current.catch(() => {}).then(async () => {
      if (originalOwner && !originalOwner()) {
        if (mounted.current) setStorageIssue('新建知识的原 Host 或设备记录已变化；原 ID 与本页正文保留，尚未确认进入设备备份。')
        return { canForward: false, committed: false }
      }
      if (!next.scope) {
        if (mounted.current) setStorageIssue('原 Host 身份尚未核实；本页正文可编辑和复制，尚未进入设备备份。请连接原 Host 或明确选择原已存草稿。')
        return { canForward: false, committed: false }
      }
      if (conflict.current) return { canForward: false, committed: false }
      try {
        const acknowledgement = await owner.editKnowledgeDraft(durable.current, parseMobileKnowledgeDraft(next), recordId)
        if (acknowledgement.recordId !== recordId || owner.recordIdentity() !== recordId) throw new DeviceWorkfaceRecordChangedError('原设备记录已替换；此页正文未写入新工作面。')
        if (!acknowledgement.applied) {
          conflict.current = { canonical: acknowledgement.draft }
          if (mounted.current) setStorageIssue('另一页面已保存同一知识草稿。双方正文和完整原请求已分别保全；本次请求未发送，请复制或明确保留版本。')
          return { canForward: false, committed: false }
        }
        durable.current = acknowledgement.draft
        if (mounted.current) setStorageIssue('')
        return { canForward: true, committed: true }
      } catch (error) {
        if (mounted.current) setStorageIssue(`${message(error)} 本页正文与完整请求保留；备份尚未确认包含本次输入，请复制保全。`)
        if (error instanceof DeviceWorkfaceRecordChangedError || error instanceof MobileKnowledgeDraftInvalidError) return { canForward: false, committed: false }
        return { canForward: owner.recordIdentity() === recordId && owner.canRetrySave() && owner.snapshot().issue !== null, committed: false }
      }
    })
    queue.current = work
    return work
  }
  useEffect(() => {
    if (newIntentRetained.current) return
    const old = current.current, originalClient = context.current.client, epoch = context.current.epoch
    const source = mobileKnowledgeDraftSource(originalClient, owner)
    if (!connected || !source || !old.scope || !sameMobileKnowledgeDraftScope(old.scope, source.scope)
      || owner.recordIdentity() !== recordId) {
      setStorageIssue('新建知识的原 ID 与本页正文保留；原 Host 身份尚未核实，尚未确认进入设备备份。')
      return
    }
    // The user's explicit New action minted this ID. Retain even an empty
    // draft, without creating a Host entry or treating a read as a write ACK.
    newIntentRetained.current = true
    setStorageIssue('新建知识的原 ID 与空草稿正在设备保全中；尚未写入 Host。')
    void retain(old, () => {
      const now = mobileKnowledgeDraftSource(context.current.client, owner)
      return mounted.current && context.current.client === originalClient && context.current.epoch === epoch
        && latest.current.connected && owner.recordIdentity() === recordId && !!now
        && now.ownerInstanceId === source.ownerInstanceId && sameMobileKnowledgeDraftScope(now.scope, old.scope!)
    })
  }, [client, connected, owner, recordId])
  function edit(field: 'title' | 'content' | 'form' | 'certainty' | 'authoringScope', value: string) {
    edited.current = true
    void retain({ ...current.current, [field]: value } as EditableDraft)
  }
  function keepDeviceConflict() {
    if (!conflict.current) return
    if (owner.recordIdentity() !== recordId) { setStorageIssue('原记录已替换；本页正文与原请求未进入新备份，请先复制保全。'); return }
    const old = current.current, canonical = conflict.current.canonical, attempts = [...(canonical?.attempts ?? [])]
    for (const attempt of old.attempts) {
      const existing = attempts.find(value => value.attemptId === attempt.attemptId)
      if (existing && (!same(existing.input, attempt.input) || existing.ownerInstanceId !== attempt.ownerInstanceId)) {
        setStorageIssue('同一本地尝试的完整原请求不同；双方仍保全，未发送新保存。'); return
      }
      if (!existing) attempts.push(attempt)
    }
    durable.current = canonical; conflict.current = null
    void retain({ ...old, attempts, blockedAttemptId: old.blockedAttemptId ?? canonical?.blockedAttemptId ?? null })
  }
  function chooseStored(value: MobileKnowledgeDraft) {
    if (flight.current || owner.recordIdentity() !== recordId) return
    // This explicit choice never guesses a Runtime. Keep the unsaved local
    // version available for copying before adopting the selected stored key.
    setLocalCopies(values => [...values, current.current])
    durable.current = value; conflict.current = null; setChecked(null); setNotice('已明确采用这份原草稿；其 Host 未匹配时不会发送。')
    baselineKnown.current = true
    display(restore(value))
  }
  async function inspect() {
    const old = current.current, originalClient = context.current.client, source = mobileKnowledgeDraftSource(originalClient, owner), epoch = context.current.epoch
    if (!originalClient?.forwardRpc || !latest.current.connected || !old.scope || !source || !sameMobileKnowledgeDraftScope(old.scope, source.scope)
      || owner.recordIdentity() !== recordId) { setNotice('核对未完成：原条目与 Host 尚未匹配，正文和原请求保留。'); return }
    const valid = () => {
      const now = mobileKnowledgeDraftSource(context.current.client, owner)
      return mounted.current && context.current.client === originalClient && context.current.epoch === epoch && latest.current.connected
        && owner.recordIdentity() === recordId && !!now && now.ownerInstanceId === source.ownerInstanceId
        && sameMobileKnowledgeDraftScope(now.scope, old.scope!)
    }
    try {
      const input = { topicId: old.topicId, entryId: old.entryId }
      const result = parseTopicResult('topic.knowledge.read', await originalClient.forwardRpc('topic.knowledge.read', input), input)
      if (valid()) { setChecked({ entry: result.entry, ...source }); setNotice('已读回原条目当前版本；草稿和未知请求仍保留。') }
    } catch (error) { if (valid()) setNotice(`检查原保存结果失败：${message(error)}。草稿与完整请求保留。`) }
  }
  async function adoptChecked() {
    const old = current.current, source = mobileKnowledgeDraftSource(context.current.client, owner)
    if (!checked || !old.scope || !source || !latest.current.connected || owner.recordIdentity() !== recordId
      || source.ownerInstanceId !== checked.ownerInstanceId || !sameMobileKnowledgeDraftScope(old.scope, checked.scope)
      || !sameMobileKnowledgeDraftScope(old.scope, source.scope)) { setNotice('采用版本未完成：原条目、Host 或设备记录已变化，原稿和请求保留。'); return }
    const originalCheck = checked
    const result = await retain({ ...old, expectedRevision: checked.entry?.revision ?? null, blockedAttemptId: null })
    const now = mobileKnowledgeDraftSource(context.current.client, owner)
    const valid = mounted.current && owner.recordIdentity() === recordId && latest.current.connected && now
      && now.ownerInstanceId === originalCheck.ownerInstanceId && sameMobileKnowledgeDraftScope(now.scope, old.scope)
    if (!result.committed || !valid) {
      const held = { ...current.current, expectedRevision: old.expectedRevision, blockedAttemptId: old.blockedAttemptId }
      if (mounted.current && owner.recordIdentity() === recordId && !conflict.current) await retain(held)
      else display(held)
      if (mounted.current) setNotice('采用版本尚未持久确认；原 unknown 请求、revision 与后来正文保留，请先复制或重试明确采用。')
      return
    }
    baselineKnown.current = true
    setChecked(null); setNotice('已采用刚读回的 revision；原未知请求与后来正文保留，下次保存须明确提交。')
  }
  async function save() {
    const old = current.current
    if (flight.current || old.blockedAttemptId) return
    if (!baselineKnown.current) { setNotice('原条目基线尚未确认；先检查并明确采用原版本，正文保留。'); return }
    const originalClient = context.current.client, source = mobileKnowledgeDraftSource(originalClient, owner)
    if (!originalClient?.forwardRpc || !latest.current.connected || !source || !old.scope
      || !sameMobileKnowledgeDraftScope(old.scope, source.scope) || owner.recordIdentity() !== recordId) {
      setNotice('保存未发送：原知识、Host 或设备记录尚未匹配；正文仍可编辑和复制保全。'); return
    }
    let input
    try { input = freezeMobileKnowledgeInput({ topicId: old.topicId, entryId: old.entryId, ...authored(old), expectedRevision: old.expectedRevision }) }
    catch (error) { setNotice(`保存未发送：${message(error)} 当前正文保留。`); return }
    const attempt: MobileKnowledgeAttempt = { attemptId: randomClientRequestId(), ownerInstanceId: source.ownerInstanceId, input, phase: 'sending', issue: null }
    const epoch = context.current.epoch
    const sameOwner = () => {
      const now = mobileKnowledgeDraftSource(context.current.client, owner)
      return mounted.current && context.current.client === originalClient && context.current.epoch === epoch && latest.current.connected
        && owner.recordIdentity() === recordId && !!now && now.ownerInstanceId === attempt.ownerInstanceId
        && sameMobileKnowledgeDraftScope(now.scope, old.scope!)
    }
    const active = () => sameOwner() && current.current.attempts.some(value => value.attemptId === attempt.attemptId && same(value.input, input))
    const unknown = (issue: string) => ({ ...attempt, phase: 'unknown' as const, issue })
    const hold = (issue: string) => ({ ...current.current, blockedAttemptId: attempt.attemptId,
      attempts: [...current.current.attempts.filter(value => value.attemptId !== attempt.attemptId), unknown(issue)] })
    flight.current = true; setSaving(true); setChecked(null); setNotice('')
    try {
      const preserved = await retain({ ...old, attempts: [...old.attempts, attempt], blockedAttemptId: attempt.attemptId })
      if (!preserved.canForward || !active()) { setNotice('保存未发送：完整请求的保全或归属尚未核实，正文仍保留。'); return }
      const result = parseTopicResult('topic.knowledge.write', await originalClient.forwardRpc('topic.knowledge.write', input), input)
      if (!active()) return
      const now = current.current
      const settled = await retain({ ...now, expectedRevision: result.entry.revision, blockedAttemptId: null,
        attempts: now.attempts.filter(value => value.attemptId !== attempt.attemptId) })
      if (!sameOwner()) {
        const held = hold('原 Host 已回应，但页面归属已变化；原完整请求继续保留，未作为新工作面的确认。')
        if (owner.recordIdentity() === recordId && mounted.current) await retain(held)
        else display(held)
        return
      }
      if (!settled.committed) {
        await retain(hold('原 Host 已回应，但设备尚未持久确认该回执；完整原请求继续保留。'))
        if (sameOwner()) setNotice('原 Host 已回应；设备回执保全尚未完成，请核对原请求。')
        return
      }
      if (sameOwner()) {
        const now = current.current, keepEditing = !same(authored(now), authored({ ...now, ...input, scope: now.scope, authoringScope: input.scope ?? '' }))
        setNotice('原知识已确认保存；后来正文与其他原未知请求仍保留。'); latest.current.onSaved(result.entry, keepEditing)
      }
    } catch (error) {
      if (!active()) return
      await retain(hold(message(error)))
      if (mounted.current) setNotice('')
    } finally { flight.current = false; if (mounted.current) setSaving(false) }
  }
  const choices = initial.current.choices.filter(value => !draft.scope || !sameMobileKnowledgeDraftScope(value.scope, draft.scope))
  const copies = owner.recordIdentity() === recordId ? (owner.snapshot().record.knowledgeDraftConflicts ?? []).filter(value =>
    value.topicId === draft.topicId && value.entryId === draft.entryId && draft.scope && sameMobileKnowledgeDraftScope(value.scope, draft.scope)) : []
  return { draft, storageIssue, notice, saving, checked, edit, save, inspect, adoptChecked,
    storageConflict: conflict.current !== null, keepDeviceConflict, choices, chooseStored, copies, localCopies }
}
