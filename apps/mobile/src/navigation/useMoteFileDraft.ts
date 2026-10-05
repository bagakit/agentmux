import { useEffect, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { parseFileReadResult, parseFileWriteResult, parseFileCreateResult, type FileReadResult, type FileReadResource } from '@agentmux/core/files'
import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { getDeviceWorkface, DeviceWorkfaceRecordChangedError, type DeviceWorkfaceStore } from '../recovery/device-workface'
import { freezeMoteFileWrite, freezeMoteFileCreate, moteFileBaseline, moteFileDraftKey, moteFileReadParams,
  parseMoteFileDraft, parseMoteFileDraftScope, sameMoteFileResource, sameMoteFileScope,
  MoteFileDraftInvalidError, MoteFileDraftCapacityError, type MoteFileAttempt, type MoteFileDraft, type MoteFileDraftScope, type MoteFilePath } from '../recovery/mote-file-drafts'

export type MoteFileEditTarget = { spaceId: string; path: MoteFilePath; observation: FileReadResult | null;
  reference: Pick<FileReadResource, 'zoneId' | 'hostId' | 'workspaceId' | 'workspacePath'> }
type Editable = Omit<MoteFileDraft, 'scope'> & { scope: MoteFileDraftScope | null }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
function source(client: AgentMuxHostedClient | null, owner: DeviceWorkfaceStore, target: MoteFileEditTarget, resource: FileReadResource) {
  try {
    const runtime = client?.runtimeOwnerIdentity(), record = owner.snapshot().record
    if (!runtime || runtime.availability !== 'connected' || !runtime.ownerInstanceId) return null
    const scope = parseMoteFileDraftScope({ origin: record.host?.origin || record.hostUrl || location.origin,
      runtimeId: runtime.runtimeId, deviceHostId: record.host?.hostId ?? null, spaceId: target.spaceId, path: target.path, resource })
    return { scope, ownerInstanceId: runtime.ownerInstanceId }
  } catch { return null }
}
function restore(draft: MoteFileDraft): MoteFileDraft {
  return { ...draft, attempts: draft.attempts.map(attempt => attempt.phase === 'sending'
    ? { ...attempt, phase: 'unknown', issue: attempt.issue ?? '原页面的保存回执尚未确认；重开不会重发。' } : attempt) }
}

/** Explicit File writes after the original transaction has classified the complete input's preservation. */
export function useMoteFileDraft(target: MoteFileEditTarget, client: AgentMuxHostedClient | null, visible: boolean, onSaved: () => void, refreshOriginal: () => void) {
  const initial = useRef<{ owner: DeviceWorkfaceStore; recordId: string | null; saved: MoteFileDraft | null; draft: Editable; choices: MoteFileDraft[] } | null>(null)
  if (!initial.current) {
    const owner = getDeviceWorkface(), record = owner.snapshot().record
    const choices = (record.moteFileDrafts ?? []).filter(value => value.scope.spaceId === target.spaceId && value.scope.path === target.path
      && (['zoneId', 'hostId', 'workspaceId', 'workspacePath'] as const).every(key => value.scope.resource[key] === target.reference[key]))
    const resource = target.observation?.resource, origin = record.host?.origin || record.hostUrl || location.origin
    const original = resource ? source(client, owner, target, resource) : null
    const matches = original ? choices.filter(value => sameMoteFileScope(value.scope, original.scope))
      : choices.filter(value => value.scope.origin === origin && value.scope.deviceHostId === (record.host?.hostId ?? null)
        && (!resource || sameMoteFileResource(value.scope.resource, resource)))
    // A retained exact original reference can be edited offline. Ambiguous
    // Runtime references remain explicit choices, never the first stored item.
    const saved = matches.length === 1 ? matches[0]! : null
    const baseline = target.observation ? moteFileBaseline(target.observation) : null
    initial.current = { owner, recordId: owner.recordIdentity(), saved, choices,
      draft: saved ? restore(saved) : { scope: original?.scope ?? null, body: baseline?.status === 'read' ? baseline.content : '',
        baseline, attempts: [], blockedAttemptId: null } }
  }
  const { owner, recordId } = initial.current
  const [draft, setDraft] = useState<Editable>(initial.current.draft), current = useRef(draft), durable = useRef(initial.current.saved)
  const queue = useRef<Promise<unknown>>(Promise.resolve()), flight = useRef(false), adoption = useRef(false), mounted = useRef(true)
  const [saving, setSaving] = useState(false), [adopting, setAdopting] = useState(false), [storageIssue, setStorageIssue] = useState(''), [notice, setNotice] = useState('')
  const [checked, setChecked] = useState<{ read: FileReadResult; scope: MoteFileDraftScope; ownerInstanceId: string } | null>(null)
  const [storageConflict, setStorageConflict] = useState(false), conflicted = useRef(false)
  const [localCopies, setLocalCopies] = useState<Editable[]>([])
  const edited = useRef(false)
  const context = useRef({ client, epoch: 0 })
  if (context.current.client !== client) context.current = { client, epoch: context.current.epoch + 1 }
  const latest = useRef({ visible, onSaved }); latest.current = { visible, onSaved }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; context.current.epoch += 1 } }, [])
  const display = (next: Editable) => { current.current = next; if (mounted.current) setDraft(next) }
  const connection = (originalClient = context.current.client) => current.current.scope
    ? source(originalClient, owner, target, current.current.scope.resource) : null
  function retain(next: Editable): Promise<{ committed: boolean; canForward: boolean }> {
    display(next)
    const work = queue.current.catch(() => {}).then(async () => {
      if (!next.scope) {
        if (mounted.current && !next.scope) setStorageIssue('原 Host 身份尚未核实；当前稿可编辑和复制，尚未进入设备备份。')
        return { committed: false, canForward: false }
      }
      try {
        const ack = await owner.editMoteFileDraft(durable.current, parseMoteFileDraft(next), recordId)
        if (ack.recordId !== recordId || owner.recordIdentity() !== recordId) throw new DeviceWorkfaceRecordChangedError('原设备记录已替换；此页不能写入新工作面。')
        if (!ack.applied) {
          conflicted.current = true
          if (mounted.current) { setStorageConflict(true); setStorageIssue('另一页面修改了同一原稿；双方正文与请求已保全，本次未发送。可复制或采用设备原稿。') }
          return { committed: false, canForward: false }
        }
        durable.current = ack.draft
        if (mounted.current) setStorageIssue('')
        return { committed: true, canForward: true }
      } catch (error) {
        const knownCapacityGap = error instanceof MoteFileDraftCapacityError
        const knownDomainFailure = error instanceof DeviceWorkfaceRecordChangedError || error instanceof MoteFileDraftInvalidError && !knownCapacityGap
        const canForward = !knownDomainFailure && owner.recordIdentity() === recordId && owner.canRetrySave()
          && (knownCapacityGap || owner.snapshot().issue !== null)
        if (mounted.current) setStorageIssue(message(error) + (canForward
          ? ' 本次完整请求未进入设备备份；当前原稿与冻结输入在内存保留，明确 Save 仍沿原 File 能力。'
          : ' 当前完整正文保留；本次设备提交未确认，请复制保全。'))
        // The existing owner distinguishes an actual storage write failure from
        // record/CAS/domain uncertainty. An explicit File action can remain
        // usable, with its frozen input in memory and no fabricated backup ACK.
        return { committed: false, canForward }
      }
    })
    queue.current = work
    return work
  }
  useEffect(() => {
    const read = target.observation, old = current.current
    if (!read?.resource || !latest.current.visible || owner.recordIdentity() !== recordId) return
    const original = source(context.current.client, owner, target, read.resource)
    if (!original || old.scope && !sameMoteFileScope(old.scope, original.scope)) return
    if (old.baseline === null && durable.current === null && !edited.current && old.attempts.length === 0) {
      const baseline = moteFileBaseline(read)
      display({ ...old, scope: original.scope, baseline, body: baseline?.status === 'read' ? baseline.content : old.body })
    } else if (old.scope === null) {
      // A late original read gives a pin, never permission to replace later text.
      void retain({ ...old, scope: original.scope })
      setChecked({ read, ...original }); setNotice('已核对当前原文件；后来正文保留，请明确采用修订。')
    }
  }, [target.observation, client, visible, owner, recordId])
  const edit = (body: string) => { edited.current = true; void retain({ ...current.current, body }) }
  async function chooseStored(value: MoteFileDraft) {
    if (flight.current || adoption.current || owner.recordIdentity() !== recordId) { setNotice('原设备记录或保存状态已变化；当前稿保留。'); return }
    await queue.current.catch(() => {})
    if (flight.current || adoption.current || !mounted.current || owner.recordIdentity() !== recordId) return
    // The explicit adoption cannot erase a memory-only later edit or its
    // complete unknown input, even when another Host key is chosen.
    const localCopy = structuredClone(current.current)
    setLocalCopies(values => [...values, localCopy])
    const snapshot = owner.snapshot()
    const canonical = snapshot.issue === null
      ? snapshot.record.moteFileDrafts?.find(item => sameMoteFileScope(item.scope, value.scope)) : value
    if (!canonical) { setNotice('原设备稿尚未核实，当前正文保留。'); return }
    durable.current = canonical; conflicted.current = false; setStorageConflict(false); setStorageIssue('')
    setChecked(null); display(restore(canonical)); setNotice('已采用原设备稿；原冲突稿仍可复制。')
  }
  function valid(originalClient: AgentMuxHostedClient, epoch: number, original: { scope: MoteFileDraftScope; ownerInstanceId: string }) {
    const now = connection()
    return mounted.current && latest.current.visible && context.current.client === originalClient && context.current.epoch === epoch
      && owner.recordIdentity() === recordId && !!now && now.ownerInstanceId === original.ownerInstanceId && sameMoteFileScope(now.scope, original.scope)
  }
  async function inspect() {
    const old = current.current, originalClient = context.current.client, original = connection(originalClient), epoch = context.current.epoch
    if (!old.scope) { refreshOriginal(); setNotice('正在核对原文件；当前正文仍保留。'); return }
    if (!old.scope || !originalClient?.forwardRpc || !original || !sameMoteFileScope(old.scope, original.scope) || !valid(originalClient, epoch, original)) {
      setNotice('核对未完成：原 Host 或记录尚未匹配；正文与原请求保留。'); return
    }
    try {
      const params = moteFileReadParams(old.scope), read = parseFileReadResult(await originalClient.forwardRpc('file.read', params), params)
      if (!read.resource || !sameMoteFileResource(read.resource, old.scope.resource)) throw new Error('原文件映射已改变；本次读取不能替代原 resource。')
      if (valid(originalClient, epoch, original)) { setChecked({ read, ...original }); setNotice('已核对原文件当前事实；未知保存仍未确认。') }
    } catch (error) { if (valid(originalClient, epoch, original)) setNotice('核对未完成：' + message(error) + ' 原稿与请求保留。') }
  }
  async function adoptChecked() {
    const old = current.current, originalClient = context.current.client, original = connection(), epoch = context.current.epoch
    const baseline = checked ? moteFileBaseline(checked.read) : null
    if (flight.current || adoption.current || !old.scope || !checked || !baseline || !originalClient || !original
      || !sameMoteFileScope(old.scope, checked.scope) || original.ownerInstanceId !== checked.ownerInstanceId || !valid(originalClient, epoch, original)) {
      setNotice('采用未完成：先核对同一原文件；正文与未知请求保留。'); return
    }
    // An optimistic device projection cannot authorize a new business write.
    // Keep explicit Save separate until this exact adoption has its commit ACK.
    adoption.current = true; setAdopting(true)
    try {
      const committed = await retain({ ...old, baseline, blockedAttemptId: null })
      if (committed.committed && valid(originalClient, epoch, original)) { setChecked(null); setNotice('已采用当前修订；未知原请求和后来正文保留，下次须明确 Save。') }
      else {
        if (mounted.current && owner.recordIdentity() === recordId) await retain({ ...current.current, baseline: old.baseline, blockedAttemptId: old.blockedAttemptId })
        if (mounted.current) setNotice('采用尚未确认；原 revision、未知请求与后来正文保留。')
      }
    } finally { adoption.current = false; if (mounted.current) setAdopting(false) }
  }
  async function save() {
    const old = current.current, originalClient = context.current.client, original = connection(originalClient), epoch = context.current.epoch
    if (flight.current || adoption.current || old.blockedAttemptId) { setNotice('先核对并明确采用原文件当前修订；完整原请求与当前正文保留。'); return }
    if (!old.scope || !old.baseline || !originalClient?.forwardRpc || !original || !sameMoteFileScope(old.scope, original.scope)
      || !valid(originalClient, epoch, original)) { setNotice('保存未发送：原文件基线、Host 或记录尚未核实；正文可编辑和复制。'); return }
    let attempt: MoteFileAttempt
    try {
      const common = { attemptId: randomClientRequestId(), ownerInstanceId: original.ownerInstanceId, phase: 'sending' as const, issue: null }
      const params = { ...moteFileReadParams(old.scope), expectedResource: old.scope.resource, content: old.body }
      attempt = old.baseline.status === 'read' ? { ...common, kind: 'write', input: freezeMoteFileWrite({ ...params, expectedRevision: old.baseline.revision }) }
        : { ...common, kind: 'create', input: freezeMoteFileCreate({ ...params, expectedRevision: null }) }
    } catch (error) { setNotice('保存未发送：' + message(error)); return }
    let memoryOnly = false
    const matchesAttempt = (value: MoteFileAttempt) => value.attemptId === attempt.attemptId
      && value.ownerInstanceId === attempt.ownerInstanceId && same(value.input, attempt.input)
    const active = () => {
      const stored = owner.snapshot().record.moteFileDrafts?.find(value => sameMoteFileScope(value.scope, old.scope!))
      const knownStorageGap = memoryOnly && !conflicted.current && owner.canRetrySave()
      return valid(originalClient, epoch, original) && current.current.attempts.some(matchesAttempt)
        && (stored?.attempts.some(matchesAttempt) === true || knownStorageGap)
    }
    const hold = (phase: MoteFileAttempt['phase'], issue: string) => ({ ...current.current, baseline: old.baseline,
      blockedAttemptId: phase === 'failed' ? null : attempt.attemptId,
      attempts: [...current.current.attempts.filter(value => value.attemptId !== attempt.attemptId), { ...attempt, phase, issue }] })
    flight.current = true; setSaving(true); setChecked(null); setNotice('')
    try {
      const committed = await retain({ ...old, attempts: [...old.attempts, attempt], blockedAttemptId: attempt.attemptId })
      memoryOnly = committed.canForward && !committed.committed
      if (!committed.canForward || !active()) {
        if (mounted.current && owner.recordIdentity() === recordId) await retain(hold('failed', '本次请求未发送；完整设备意图的提交或归属未确认。'))
        if (mounted.current) setNotice('本次保存未发送；原稿和完整请求保留。')
        return
      }
      const result = attempt.kind === 'write'
        ? parseFileWriteResult(await originalClient.forwardRpc('file.write', attempt.input), attempt.input)
        : parseFileCreateResult(await originalClient.forwardRpc('file.create', attempt.input), attempt.input)
      if (!active()) return
      if (result.result.status !== 'written') {
        const issue = result.result.status === 'conflict' ? '原 revision 已改变；先核对同一原文件并明确采用。'
          : result.result.code + '：' + result.result.message
        await retain({ ...hold(result.result.status === 'unknown' ? 'unknown' : 'failed', issue), blockedAttemptId: attempt.attemptId })
        if (mounted.current) setNotice(result.result.status === 'unknown' ? '保存回执未确认；原请求和后来正文保留。' : '本次保存未完成；核对原文件，正文仍可编辑。')
        return
      }
      const settled = await retain({ ...current.current, baseline: { status: 'read', content: attempt.input.content, revision: result.result.revision },
        blockedAttemptId: null, attempts: current.current.attempts.filter(value => value.attemptId !== attempt.attemptId) })
      if (!settled.committed || !valid(originalClient, epoch, original)) {
        if (mounted.current && owner.recordIdentity() === recordId) await retain(hold('unknown', 'Host 已回应，设备回执或页面归属尚未持久确认。'))
        return
      }
      setNotice(current.current.body === attempt.input.content ? '原文件已保存。' : '原文件已保存；后来正文尚未保存。')
      latest.current.onSaved()
    } catch (error) {
      if (active()) { await retain(hold('unknown', message(error))); if (mounted.current) setNotice('保存回执未确认；原稿、完整请求与后来正文保留。') }
    } finally { flight.current = false; if (mounted.current) setSaving(false) }
  }
  const canonical = owner.recordIdentity() === recordId && draft.scope
    ? owner.snapshot().record.moteFileDrafts?.find(value => sameMoteFileScope(value.scope, draft.scope!)) ?? null : null
  const copies = owner.recordIdentity() === recordId ? (owner.snapshot().record.moteFileDraftConflicts ?? []).filter(value =>
    value.scope.spaceId === target.spaceId && value.scope.path === target.path) : []
  return { draft, edit, save, inspect, adoptChecked, checked, notice, saving, adopting, storageIssue, storageConflict, canonical, copies, localCopies,
    choices: initial.current.choices.filter(value => !draft.scope || !sameMoteFileScope(value.scope, draft.scope)), chooseStored }
}
