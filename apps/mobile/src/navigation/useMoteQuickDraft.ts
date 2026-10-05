import { useEffect, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { moteQuickBaseline, parseMotePreferencesReadResult, parseMotePreferencesSaveParams, parseMotePreferencesSaveResult,
  sameMotePreferencesTarget, type MotePreferencesTarget, type MotePreferencesReadResult, type MoteQuickDefaults, type MotePreferencesDestination } from '@agentmux/core/mote-preferences'
import { getDeviceWorkface, DeviceWorkfaceRecordChangedError, type DeviceWorkfaceStore } from '../recovery/device-workface'
import { moteQuickDraftKey, parseMoteQuickDraft, parseMoteQuickScope, MoteQuickDraftInvalidError, MoteQuickDraftCapacityError,
  type MoteQuickDraft, type MoteQuickScope, type MoteQuickAttempt } from '../recovery/mote-quick-drafts'

type Editable = Omit<MoteQuickDraft, 'scope'> & { scope: MoteQuickScope | null }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
function connection(client: AgentMuxHostedClient | null, owner: DeviceWorkfaceStore, target: MotePreferencesTarget) {
  try {
    const runtime = client?.runtimeOwnerIdentity(), record = owner.snapshot().record
    if (!runtime || runtime.availability !== 'connected' || !runtime.ownerInstanceId) return null
    return { scope: parseMoteQuickScope({ origin: record.host?.origin || record.hostUrl || location.origin,
      runtimeId: runtime.runtimeId, deviceHostId: record.host?.hostId ?? null, target }), ownerInstanceId: runtime.ownerInstanceId }
  } catch { return null }
}
function restore(draft: MoteQuickDraft): MoteQuickDraft {
  return { ...draft, attempts: draft.attempts.map(a => a.phase === 'sending' ? { ...a, phase: 'unknown', issue: a.issue ?? '原保存回执尚未确认；重开不会重发。' } : a) }
}
export function useMoteQuickDraft(target: MotePreferencesTarget, client: AgentMuxHostedClient | null, visible: boolean, onSaved: () => void) {
  const initial = useRef<{ owner: DeviceWorkfaceStore; recordId: string | null; saved: MoteQuickDraft | null } | null>(null)
  if (!initial.current) {
    const owner = getDeviceWorkface(), record = owner.snapshot().record, source = connection(client, owner, target)
    const choices = (record.moteQuickDrafts ?? []).filter(d => sameMotePreferencesTarget(d.scope.target, target) &&
      d.scope.origin === (record.host?.origin || record.hostUrl || location.origin) && d.scope.deviceHostId === (record.host?.hostId ?? null) &&
      (!source || moteQuickDraftKey(d.scope) === moteQuickDraftKey(source.scope)))
    initial.current = { owner, recordId: owner.recordIdentity(), saved: choices.length === 1 ? choices[0]! : null }
  }
  const { owner, recordId, saved } = initial.current
  const [draft, setDraft] = useState<Editable>(() => saved ? restore(saved) : { scope: connection(client, owner, target)?.scope ?? null,
    values: {}, baseline: null, attempts: [], blockedAttemptId: null })
  const current = useRef(draft), durable = useRef(saved), queue = useRef<Promise<unknown>>(Promise.resolve()), mounted = useRef(true)
  const flight = useRef(false), adopting = useRef(false), changed = useRef(!!saved), conflicted = useRef(false)
  const [busy, setBusy] = useState(false), [adoptionBusy, setAdoptionBusy] = useState(false), [notice, setNotice] = useState('')
  const [storageIssue, setStorageIssue] = useState(''), [memoryOnly, setMemoryOnly] = useState(false)
  const [read, setRead] = useState<MotePreferencesReadResult | null>(null), [copies, setCopies] = useState<Editable[]>([])
  const [destination, setDestination] = useState<MotePreferencesDestination | null>(null)
  const latest = useRef({ client, visible, onSaved }); latest.current = { client, visible, onSaved }
  const readEpoch = useRef(0)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; readEpoch.current++ } }, [])
  const display = (next: Editable) => { current.current = next; if (mounted.current) setDraft(next) }
  async function retain(next: Editable) {
    display(next)
    const work = queue.current.catch(() => {}).then(async () => {
      if (!next.scope) { if (mounted.current) setStorageIssue('原 Host 尚未核实；选择仅在本页，可复制。'); return { committed: false, canForward: false } }
      try {
        const ack = await owner.editMoteQuickDraft(durable.current, parseMoteQuickDraft(next), recordId)
        if (owner.recordIdentity() !== recordId || ack.recordId !== recordId) throw new DeviceWorkfaceRecordChangedError('原设备记录已替换；此页不能写新工作面。')
        durable.current = ack.draft
        if (!ack.applied) { conflicted.current = true; if (mounted.current) setStorageIssue('另一页面已改原配置；双方选择和请求保留，可复制或采用设备原稿。') }
        else if (mounted.current) { setStorageIssue(''); setMemoryOnly(false) }
        return { committed: ack.applied, canForward: ack.applied }
      } catch (error) {
        const domain = error instanceof DeviceWorkfaceRecordChangedError || error instanceof MoteQuickDraftInvalidError && !(error instanceof MoteQuickDraftCapacityError)
        const canForward = !domain && owner.recordIdentity() === recordId && owner.canRetrySave()
        if (mounted.current) { setStorageIssue(`${message(error)}；本页完整选择和请求保留，尚未进入设备备份。`); setMemoryOnly(canForward) }
        return { committed: false, canForward }
      }
    })
    queue.current = work
    return work
  }
  function edit(values: MoteQuickDefaults) { changed.current = true; void retain({ ...current.current, values }) }
  async function inspect() {
    const source = connection(latest.current.client, owner, target), epoch = ++readEpoch.current, original = latest.current.client
    if (!source || !original?.forwardRpc || !latest.current.visible) { setNotice('原 Host 暂不可核对；选择和原请求保留。'); return }
    try {
      const result = parseMotePreferencesReadResult(await original.forwardRpc('space.mote.preferences.read', { kind: 'quick', target }), { kind: 'quick', target })
      const now = connection(original, owner, target)
      if (!mounted.current || epoch !== readEpoch.current || latest.current.client !== original || !now || now.ownerInstanceId !== source.ownerInstanceId ||
        moteQuickDraftKey(now.scope) !== moteQuickDraftKey(source.scope) || owner.recordIdentity() !== recordId) return
      setRead(result)
      setDestination(existing => existing && result.choices.destinations.some(c => JSON.stringify(c.reference) === JSON.stringify(existing)) ? existing :
        result.choices.destinations.length === 1 ? result.choices.destinations[0]!.reference : null)
      const baseline = moteQuickBaseline(result)
      if (baseline && !current.current.baseline && !current.current.blockedAttemptId) {
        void retain({ ...current.current, scope: source.scope, baseline, values: changed.current ? current.current.values : baseline.defaults })
      }
      setNotice(result.status === 'ready' ? '已核对当前配置；读取不确认旧保存。' : result.issue ?? '原配置未确认。')
    } catch (error) { if (mounted.current && epoch === readEpoch.current) setNotice(message(error)) }
  }
  useEffect(() => { if (visible) void inspect(); return () => { readEpoch.current++ } }, [client, visible])
  async function adopt() {
    const baseline = read && moteQuickBaseline(read), source = connection(latest.current.client, owner, target), old = current.current
    if (!baseline || !source || flight.current || adopting.current || conflicted.current || !latest.current.visible) return
    if (old.scope && moteQuickDraftKey(old.scope) !== moteQuickDraftKey(source.scope)) { setNotice('当前 Host 与原请求不同；原配置保留。'); return }
    adopting.current = true; setAdoptionBusy(true)
    try {
      const ack = await retain({ ...old, scope: source.scope, baseline, blockedAttemptId: null })
      if (!ack.committed) {
        // Later form edits remain; an optimistic baseline must never release an original unknown request.
        await retain({ ...current.current, baseline: old.baseline, blockedAttemptId: old.blockedAttemptId })
        if (mounted.current) setNotice('采用当前修订尚未持久完成；旧请求仍未确认。')
      } else if (mounted.current) setNotice('已明确采用当前修订；原请求保留，下次保存须明确提交。')
    } finally { adopting.current = false; if (mounted.current) setAdoptionBusy(false) }
  }
  async function save() {
    if (flight.current || adopting.current) return
    const original = latest.current.client, source = connection(original, owner, target), submitted = current.current
    if (!latest.current.visible || !original?.forwardRpc || !source || !submitted.scope || !submitted.baseline || submitted.blockedAttemptId || conflicted.current || !destination ||
      moteQuickDraftKey(source.scope) !== moteQuickDraftKey(submitted.scope) || owner.recordIdentity() !== recordId) {
      setNotice('原配置、保存位置或回执尚未确认；保留选择，请先核对并明确采用当前修订。'); return
    }
    const input = parseMotePreferencesSaveParams({ kind: 'quick', target, baseline: submitted.baseline, values: submitted.values, destination,
      operationId: randomClientRequestId() }), attempt: MoteQuickAttempt = { input, ownerInstanceId: source.ownerInstanceId, phase: 'sending', result: null, issue: null }
    flight.current = true; setBusy(true)
    try {
      const ack = await retain({ ...submitted, attempts: [...submitted.attempts, attempt], blockedAttemptId: input.operationId })
      const now = connection(original, owner, target)
      if (!ack.canForward || !mounted.current || !latest.current.visible || owner.recordIdentity() !== recordId || !now || latest.current.client !== original ||
        now.ownerInstanceId !== source.ownerInstanceId || moteQuickDraftKey(now.scope) !== moteQuickDraftKey(source.scope) ||
        !current.current.attempts.some(a => a.input.operationId === input.operationId)) {
        await retain({ ...current.current, attempts: current.current.attempts.filter(a => a.input.operationId !== input.operationId), blockedAttemptId: null })
        if (mounted.current) setNotice('本次尚未发送；原选择保留。'); return
      }
      let resolved: MoteQuickAttempt
      try {
        const result = parseMotePreferencesSaveResult(await original.forwardRpc('space.mote.preferences.save', input), input)
        const after = connection(original, owner, target)
        if (!mounted.current || !latest.current.visible || latest.current.client !== original) return
        if (!after || after.ownerInstanceId !== source.ownerInstanceId || moteQuickDraftKey(after.scope) !== moteQuickDraftKey(source.scope)) return
        resolved = { ...attempt, result, phase: result.status === 'saved' || result.status === 'unchanged' ? 'saved' : result.status === 'refused-before-write' ? 'failed' : 'unknown', issue: result.message }
      } catch (error) { resolved = { ...attempt, phase: 'unknown', issue: message(error) } }
      if (!mounted.current || !latest.current.visible || latest.current.client !== original || owner.recordIdentity() !== recordId) return
      const latestDraft = current.current, confirmed = resolved.phase === 'saved'
      const settled = await retain({ ...latestDraft, baseline: confirmed ? resolved.result!.source : latestDraft.baseline,
        attempts: latestDraft.attempts.map(a => a.input.operationId === input.operationId ? resolved : a), blockedAttemptId: resolved.phase === 'unknown' ? input.operationId : null })
      const afterSettle = connection(original, owner, target)
      if (!settled.committed || !mounted.current || !latest.current.visible || latest.current.client !== original || owner.recordIdentity() !== recordId ||
        !afterSettle || afterSettle.ownerInstanceId !== source.ownerInstanceId || moteQuickDraftKey(afterSettle.scope) !== moteQuickDraftKey(source.scope)) {
        const held = { ...current.current, baseline: latestDraft.baseline, blockedAttemptId: input.operationId,
          attempts: current.current.attempts.map(a => a.input.operationId === input.operationId ? { ...resolved, phase: 'unknown' as const,
            issue: '原 Host 已回应；设备回执或原页面归属尚未持久确认。' } : a) }
        if (owner.recordIdentity() === recordId) await retain(held)
        else display(held)
        if (mounted.current) setNotice(confirmed ? '原 Host 已确认保存；设备备份或页面归属未确认，原请求与后来选择保留。' : '原请求回执保留；设备备份或页面归属未确认。')
        return
      }
      setNotice(confirmed ? '原 Quick 配置已保存；后来选择保留。' : resolved.phase === 'failed' ? '原 owner 确认尚未写入；选择保留。' : '保存回执未确认；保留原请求，可核对当前配置。')
      if (confirmed) latest.current.onSaved()
    } finally { flight.current = false; if (mounted.current) setBusy(false) }
  }
  async function chooseStored() {
    if (flight.current || adopting.current || owner.recordIdentity() !== recordId) return
    await queue.current.catch(() => {})
    if (flight.current || adopting.current || !mounted.current || owner.recordIdentity() !== recordId) return
    const localCopy = structuredClone(current.current), snapshot = owner.snapshot()
    setCopies(previous => [...previous, localCopy])
    const canonical = snapshot.issue === null && localCopy.scope
      ? snapshot.record.moteQuickDrafts?.find(d => moteQuickDraftKey(d.scope) === moteQuickDraftKey(localCopy.scope!)) : durable.current
    if (!canonical) { setNotice('设备原稿尚未核实；本页完整选择和请求仍可复制。'); return }
    durable.current = canonical; conflicted.current = false; display(restore(canonical)); setNotice('已采用设备原稿；本页另一份选择与请求仍可复制。')
  }
  return { draft, read, destination, setDestination, edit, inspect, adopt, save, chooseStored, busy, adoptionBusy, notice, storageIssue, memoryOnly,
    conflict: conflicted.current, copies }
}
