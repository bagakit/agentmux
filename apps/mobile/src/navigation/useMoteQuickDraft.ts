import { useEffect, useRef, useState } from 'react'
import { useMobileWebUpdateSafetyOwner } from '../mobile-web/update-safety'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { DEFAULT_MOTE_PRESENCE, moteMinutesToMs, moteQuickBaseline, parseMotePreferencesReadResult, parseMotePreferencesSaveParams, parseMotePreferencesSaveResult,
  mergeMoteQuickChoices, sameMotePreferencesTarget, type MotePreferencesTarget, type MoteQuickChoices, type MoteQuickPreferencesReadResult, type MoteQuickDefaults } from '@agentmux/core/mote-preferences'
import { getDeviceWorkface, DeviceWorkfaceRecordChangedError, type DeviceWorkfaceStore } from '../recovery/device-workface'
import { moteQuickDraftKey, parseMoteQuickDraft, parseMoteQuickScope, MoteQuickDraftInvalidError, MoteQuickDraftCapacityError,
  type MoteQuickDraft, type MoteRolloverEditor, type MoteQuickScope, type MoteQuickAttempt, type MoteMaintenanceAttempt } from '../recovery/mote-quick-drafts'
import { parseScheduleRpcParams, validateScheduleRpcResult } from '@agentmux/core/schedule-rpc'

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
  return { ...draft, ...(draft.maintenanceAttempts ? { maintenanceAttempts: draft.maintenanceAttempts.map(a => a.phase === 'sending' ? { ...a, phase: 'unknown' as const, issue: a.issue ?? '上次恢复心跳还没确认，重新打开不会再次恢复。' } : a) } : {}),
    attempts: draft.attempts.map(a => a.phase === 'sending' ? { ...a, phase: 'unknown', issue: a.issue ?? '上次保存还没确认，重新打开不会再次保存。' } : a) }
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
  // A raw invalid input can be stored before the first canonical preference read.
  const awaitingInitialValues = saved?.invalidHeartbeatInput !== undefined && saved.baseline === null &&
    Object.keys(saved.values).length === 0 && saved.conversationRolloverEditor === undefined
  const flight = useRef(false), adopting = useRef(false), changed = useRef(!!saved && !awaitingInitialValues), conflicted = useRef(false)
  const reloadDirty = useRef(false), reloadRevision = useRef(0), reloadCopies = useRef(false)
  useMobileWebUpdateSafetyOwner(() => reloadCopies.current ? '本页保留了 Mote 配置冲突副本；请先复制保全并关闭编辑器，再更新网页。'
    : reloadDirty.current || flight.current || adopting.current ? 'Mote 配置草稿或保存操作尚未确认；请保存或复制保全后再更新网页。' : null)
  const [busy, setBusy] = useState(false), [adoptionBusy, setAdoptionBusy] = useState(false), [notice, setNotice] = useState('')
  const [preparedResume, setPreparedResume] = useState<{ operationId: string; ownerInstanceId: string } | null>(null)
  const [storageIssue, setStorageIssue] = useState(''), [memoryOnly, setMemoryOnly] = useState(false)
  const [read, setRead] = useState<MoteQuickPreferencesReadResult | null>(null), [copies, setCopies] = useState<Editable[]>([])
  const latest = useRef({ client, visible, onSaved }); latest.current = { client, visible, onSaved }
  const readEpoch = useRef(0)
  const readController = useRef<AbortController | null>(null)
  const maintenanceOwner = useRef<{ client: AgentMuxHostedClient; scope: string; ownerInstanceId: string } | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; readEpoch.current++ } }, [])
  const display = (next: Editable) => { current.current = next; if (mounted.current) setDraft(next) }
  async function retain(next: Editable) {
    reloadDirty.current = true
    const revision = ++reloadRevision.current
    display(next)
    const work = queue.current.catch(() => {}).then(async () => {
      if (!next.scope) { if (mounted.current) setStorageIssue('Mac 还没确认，选择只在本页，可以复制。'); return { committed: false, canForward: false } }
      try {
        const ack = await owner.editMoteQuickDraft(durable.current, parseMoteQuickDraft(next), recordId)
        if (owner.recordIdentity() !== recordId || ack.recordId !== recordId) throw new DeviceWorkfaceRecordChangedError('这台设备的工作面已被替换，此页不能再保存。')
        durable.current = ack.draft
        if (!ack.applied) { conflicted.current = true; if (mounted.current) setStorageIssue('另一个页面改了这份配置，可以复制或采用设备上的那份。') }
        else if (mounted.current) { setStorageIssue(''); setMemoryOnly(false) }
        return { committed: ack.applied, canForward: ack.applied }
      } catch (error) {
        const domain = error instanceof DeviceWorkfaceRecordChangedError || error instanceof MoteQuickDraftInvalidError && !(error instanceof MoteQuickDraftCapacityError)
        const canForward = !domain && owner.recordIdentity() === recordId && owner.canRetrySave()
        if (mounted.current) { setStorageIssue(`${message(error)}。本页选择尚未进入设备备份。`); setMemoryOnly(canForward) }
        return { committed: false, canForward }
      }
    })
    queue.current = work
    void work.then(result => { if (revision === reloadRevision.current && result.committed) reloadDirty.current = false })
    return work
  }
  function edit(values: MoteQuickDefaults, conversationRolloverEditor?: MoteRolloverEditor) {
    changed.current = true
    void retain({ ...current.current, values, ...(conversationRolloverEditor ? { conversationRolloverEditor } : {}) })
  }
  function editHeartbeatMinutes(value: string) {
    const intervalMs = moteMinutesToMs(value, { wholeMinutes: true })
    if (intervalMs === null) {
      void retain({ ...current.current, invalidHeartbeatInput: value })
      return
    }
    const { invalidHeartbeatInput: _invalid, ...draft } = current.current
    const presence = draft.values.presence ?? DEFAULT_MOTE_PRESENCE
    changed.current = true
    void retain({ ...draft, values: { ...draft.values, presence: { ...presence, intervalMs } } })
  }
  async function inspect() {
    const source = connection(latest.current.client, owner, target), epoch = ++readEpoch.current, original = latest.current.client
    readController.current?.abort()
    const controller = new AbortController(); readController.current = controller
    if (!source || !original?.forwardRpc || !latest.current.visible) { setNotice('暂时无法核对 Mac 上的配置。'); return }
    const sameReader = () => {
      const now = connection(original, owner, target)
      return !controller.signal.aborted && mounted.current && latest.current.visible && epoch === readEpoch.current && latest.current.client === original &&
        now?.ownerInstanceId === source.ownerInstanceId && moteQuickDraftKey(now.scope) === moteQuickDraftKey(source.scope) && owner.recordIdentity() === recordId
    }
    try {
      const input = { kind: 'quick' as const, target, includeChoices: false }
      const result = parseMotePreferencesReadResult(await original.forwardRpc('space.mote.preferences.read', input, { signal: controller.signal }), input)
      if (!sameReader()) return
      setRead(result)
      maintenanceOwner.current = { client: original, scope: moteQuickDraftKey(source.scope), ownerInstanceId: source.ownerInstanceId }
      const baseline = moteQuickBaseline(result)
      if (baseline && !current.current.baseline && !current.current.blockedAttemptId) {
        void retain({ ...current.current, scope: source.scope, baseline, values: changed.current ? current.current.values : baseline.defaults })
      }
      setNotice(result.status === 'ready' ? '已核对当前配置；读取不确认旧保存。' : result.issue ?? '配置还没确认。')
      if (result.status === 'ready') void original.forwardRpc('space.mote.preferences.read', { kind: 'quick', target, includeChoices: 'executors' }, { signal: controller.signal }).then(value => {
        const discovery = parseMotePreferencesReadResult(value, { kind: 'quick', target, includeChoices: 'executors' })
        if (!sameReader()) return
        if (discovery.status !== 'ready' || !discovery.choices) throw new Error(discovery.issue ?? '候选尚未确认，原设置保留。')
        const choices = discovery.choices
        setRead(previous => previous ? { ...previous, choices: mergeMoteQuickChoices(previous.choices, choices) } : previous)
      }).catch(error => {
        const failure: MoteQuickChoices = { executors: [], conversations: null, destinations: null, issues: { executors: message(error) } }
        if (sameReader()) setRead(previous => previous ? { ...previous, choices: mergeMoteQuickChoices(previous.choices, failure) } : previous)
      })
    } catch (error) { if (mounted.current && epoch === readEpoch.current) setNotice(message(error)) }
  }
  useEffect(() => { if (visible) void inspect(); return () => { readEpoch.current++; readController.current?.abort() } }, [client, visible])
  async function resumeMaintenance(pending?: MoteMaintenanceAttempt) {
    if (flight.current || adopting.current) return
    const original = latest.current.client, source = connection(original, owner, target), selected = current.current
    if (!latest.current.visible || !original?.forwardRpc || !source || !selected.scope || moteQuickDraftKey(selected.scope) !== moteQuickDraftKey(source.scope) || owner.recordIdentity() !== recordId) {
      setNotice('心跳安排对应的连接或设备还没确认。'); return
    }
    if (!pending && selected.maintenanceAttempts?.some(value => value.phase === 'unknown' || value.phase === 'sending')) {
      setNotice('上次恢复还没确认，请先核对那一次。'); return
    }
    const schedule = read?.maintenance?.schedule, admitted = maintenanceOwner.current
    if (!pending && (!schedule || schedule.status !== 'paused' || !schedule.revision || read?.defaults?.presence?.enabled === false ||
      admitted?.client !== original || admitted.scope !== moteQuickDraftKey(source.scope) || admitted.ownerInstanceId !== source.ownerInstanceId)) {
      setNotice('请先核对并保存启用配置，再恢复暂停的心跳。'); return
    }
    const input = pending?.input ?? parseScheduleRpcParams('schedule.resume', { scheduleId: schedule!.loopId, expectedRevision: schedule!.revision, operationId: randomClientRequestId() })
    let operation: MoteMaintenanceAttempt = pending ?? { input, ownerInstanceId: source.ownerInstanceId, phase: 'sending', result: null, issue: null }
    const retryPrepared = pending !== undefined && preparedResume?.operationId === input.operationId && preparedResume.ownerInstanceId === source.ownerInstanceId
    let requested = false
    const sameSource = () => {
      const now = connection(original, owner, target)
      return mounted.current && latest.current.visible && latest.current.client === original && owner.recordIdentity() === recordId && now?.ownerInstanceId === source.ownerInstanceId && moteQuickDraftKey(now.scope) === moteQuickDraftKey(source.scope)
    }
    flight.current = true; setBusy(true); setPreparedResume(null)
    try {
      if (!pending || retryPrepared) {
        operation = { ...operation, phase: 'sending', result: null, issue: null }
        const attempts = current.current.maintenanceAttempts ?? []
        const ack = await retain({ ...current.current, maintenanceAttempts: pending
          ? attempts.map(value => value.input.operationId === input.operationId ? operation : value) : [...attempts, operation] })
        if (!ack.canForward || !sameSource()) { operation = pending ?? { ...operation, phase: 'not-sent', issue: '请求尚未发送。' }; return }
      }
      requested = true
      const fence = { runtimeId: source.scope.runtimeId, ownerInstanceId: source.ownerInstanceId }
      const result = pending && !retryPrepared
        ? validateScheduleRpcResult('schedule.inspect', await original.forwardRpc('schedule.inspect', { operationId: input.operationId }, {}, fence), { operationId: input.operationId })
        : validateScheduleRpcResult('schedule.resume', await original.forwardRpc('schedule.resume', input, {}, fence), input)
      if (!sameSource()) return
      if (!result.schedule || result.schedule.loopId !== input.scheduleId || result.schedule.lastMutation?.operationId !== input.operationId || result.schedule.lastMutation.action !== 'resume' || result.schedule.lastMutation.expectedRevision !== input.expectedRevision) {
        operation = { ...operation, phase: 'unknown', issue: '这次恢复还没确认，不会重复恢复。' }; return
      }
      if (result.schedule.lastMutation.phase === 'prepared') {
        setPreparedResume({ operationId: input.operationId, ownerInstanceId: source.ownerInstanceId })
        operation = { ...operation, phase: 'unknown', issue: '原恢复尚未完成，可以继续同一次恢复。' }
        return
      }
      operation = { ...operation, phase: pending && !retryPrepared ? 'observed' : 'confirmed', result, issue: null }
      setNotice(operation.phase === 'observed' ? '已读到恢复记录，心跳投递另行核对。' : '心跳已恢复，主 Agent 接回和心跳投递另行核对。')
    } catch (error) { operation = { ...operation, phase: requested || pending ? 'unknown' : 'not-sent', issue: message(error) }; if (mounted.current) setNotice('恢复还没确认，可以核对。') }
    finally {
      if (operation.phase === 'sending') operation = { ...operation, phase: requested ? 'unknown' : 'not-sent', issue: '连接或页面已变化，请求没有发往别处。' }
      const retained = { ...current.current, maintenanceAttempts: (current.current.maintenanceAttempts ?? []).map(value => value.input.operationId === input.operationId ? operation : value) }
      if (owner.recordIdentity() === recordId) await retain(retained); else display(retained)
      if (sameSource() && (operation.phase === 'confirmed' || operation.phase === 'observed')) void inspect()
      flight.current = false; if (mounted.current) setBusy(false)
    }
  }
  async function adopt() {
    const baseline = read && moteQuickBaseline(read), source = connection(latest.current.client, owner, target), old = current.current
    if (!baseline || !source || flight.current || adopting.current || conflicted.current || !latest.current.visible) return
    if (old.scope && moteQuickDraftKey(old.scope) !== moteQuickDraftKey(source.scope)) { setNotice('当前 Mac 与这份配置不同，未采用。'); return }
    adopting.current = true; setAdoptionBusy(true)
    try {
      const ack = await retain({ ...old, scope: source.scope, baseline, blockedAttemptId: null })
      if (!ack.committed) {
        // Later form edits remain; an optimistic baseline must never release an original unknown request.
        await retain({ ...current.current, baseline: old.baseline, blockedAttemptId: old.blockedAttemptId })
        if (mounted.current) setNotice('采用当前修订尚未持久完成；旧请求仍未确认。')
      } else if (mounted.current) setNotice('已采用当前版本，下次需要再保存一次。')
    } finally { adopting.current = false; if (mounted.current) setAdoptionBusy(false) }
  }
  async function save() {
    if (flight.current || adopting.current) return
    const original = latest.current.client, source = connection(original, owner, target), submitted = current.current
    if (!latest.current.visible || !original?.forwardRpc || !source || !submitted.scope || !submitted.baseline || submitted.blockedAttemptId || conflicted.current ||
      moteQuickDraftKey(source.scope) !== moteQuickDraftKey(submitted.scope) || owner.recordIdentity() !== recordId) {
      setNotice('配置或上次保存还没确认，请先核对并采用当前版本。'); return
    }
    const { conversation: _main, conversationRollover: _policy, ...draftValues } = submitted.values
    const saved = submitted.baseline.defaults
    const values = { ...draftValues, ...(saved.conversation ? { conversation: saved.conversation } : {}),
      ...(saved.conversationRollover ? { conversationRollover: saved.conversationRollover } : {}) }
    const input = parseMotePreferencesSaveParams({ kind: 'quick', target, baseline: submitted.baseline, values,
      operationId: randomClientRequestId() }), attempt: MoteQuickAttempt = { input, ownerInstanceId: source.ownerInstanceId, phase: 'sending', result: null, issue: null }
    flight.current = true; setBusy(true)
    try {
      const ack = await retain({ ...submitted, attempts: [...submitted.attempts, attempt], blockedAttemptId: input.operationId })
      const now = connection(original, owner, target)
      if (!ack.canForward || !mounted.current || !latest.current.visible || owner.recordIdentity() !== recordId || !now || latest.current.client !== original ||
        now.ownerInstanceId !== source.ownerInstanceId || moteQuickDraftKey(now.scope) !== moteQuickDraftKey(source.scope) ||
        !current.current.attempts.some(a => a.input.operationId === input.operationId)) {
        await retain({ ...current.current, attempts: current.current.attempts.filter(a => a.input.operationId !== input.operationId), blockedAttemptId: null })
        if (mounted.current) setNotice('本次尚未发送。'); return
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
      const originalScope = mounted.current && latest.current.visible && latest.current.client === original && owner.recordIdentity() === recordId &&
        !!afterSettle && afterSettle.ownerInstanceId === source.ownerInstanceId && moteQuickDraftKey(afterSettle.scope) === moteQuickDraftKey(source.scope)
      if (!settled.committed && settled.canForward && confirmed && originalScope && !conflicted.current) {
        // Host's exact receipt is authoritative even when this device cannot back it up.
        // Keep its baseline for a later explicit Save; never claim a Device commit ACK.
        setNotice('Mac 已保存，这份选择尚未进入设备备份；可以再次保存或复制。')
        return
      }
      if (!settled.committed || !originalScope) {
        const held = { ...current.current, baseline: latestDraft.baseline, blockedAttemptId: input.operationId,
          attempts: current.current.attempts.map(a => a.input.operationId === input.operationId ? { ...resolved, phase: 'unknown' as const,
            issue: 'Mac 已回应，这台设备还没记下结果。' } : a) }
        if (owner.recordIdentity() === recordId) await retain(held)
        else display(held)
        if (mounted.current) setNotice(confirmed ? 'Mac 已保存，这台设备还没记下结果。' : '这台设备还没记下保存结果。')
        return
      }
      setNotice(confirmed ? '快捷配置已保存。' : resolved.phase === 'failed' ? '保存未写入，可以重试。' : '保存还没确认，可以核对当前配置。')
      if (confirmed) latest.current.onSaved()
    } finally { flight.current = false; if (mounted.current) setBusy(false) }
  }
  async function chooseStored() {
    if (flight.current || adopting.current || owner.recordIdentity() !== recordId) return
    await queue.current.catch(() => {})
    if (flight.current || adopting.current || !mounted.current || owner.recordIdentity() !== recordId) return
    const localCopy = structuredClone(current.current), snapshot = owner.snapshot()
    reloadCopies.current = true
    setCopies(previous => [...previous, localCopy])
    const canonical = snapshot.issue === null && localCopy.scope
      ? snapshot.record.moteQuickDrafts?.find(d => moteQuickDraftKey(d.scope) === moteQuickDraftKey(localCopy.scope!)) : durable.current
    if (!canonical) { setNotice('设备上的配置还没确认，本页选择仍可复制。'); return }
    durable.current = canonical; conflicted.current = false; display(restore(canonical)); setNotice('已采用设备上的配置，本页的另一份选择仍可复制。')
  }
  return { draft, read, edit, editHeartbeatMinutes, inspect, adopt, save, chooseStored, busy, adoptionBusy, notice, storageIssue, memoryOnly,
    conflict: conflicted.current, copies, resumeMaintenance, preparedResumeOperationId: preparedResume?.operationId }
}
