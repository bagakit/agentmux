import { MobileNotice } from '../notices/MobileNotice'
import { useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore, type Ref } from 'react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxAgentSession } from '@agentmux/core'
import { FILE_UPLOAD_MAX_BYTES, parseFileUploadParams, type FileUploadIdentity } from '@agentmux/core/files'
import { localAttachmentFromBlob, pickLocalAttachment, type LocalAttachment, type LocalAttachmentFile } from '../platform/native/device'
import { getDeviceWorkface } from '../recovery/device-workface'
import { draftIncludesUpload, fileUploadIntentKey, fileUploadScopeMatches, uploadFromReceipt, type ConfirmedAttachmentPrompt, type MobileFileUpload } from './attachments'
import { errorMessage } from './delivery'
import { appendNamedFileReference } from '@agentmux/client-ui/composer-file-reference'
import type { MobilePromptPreparation } from './use-mobile-prompt-controller'
import { useMobileWebAttachmentOwner, useMobileWebUpdatePendingAction } from '../mobile-web/update-safety'
import type { AttachmentFlight, SelectionOperation, SelectionTarget } from './attachment-page-owner'

export type MobileAttachmentControls = {
  choose(): Promise<void>
  stageFile(file: LocalAttachmentFile): Promise<void>
  stageFiles(files: readonly LocalAttachmentFile[]): Promise<void>
  captureForSend(): MobilePromptPreparation | null
}
type CopyDecision = { upload: MobileFileUpload; file: LocalAttachment; kind: 'discard' | 'saved'; intent: string;
  recordId: string | null; revision: string; dataBase64: string }
type Props = {
  client: AgentMuxHostedClient | null; session: AgentMuxAgentSession | null; connected: boolean;
  agentSessionId?: string | null;
  promptOperationId: string | null; confirmedPrompt: ConfirmedAttachmentPrompt | null;
  onSendBodyOnly?(): void; bodyOnlyDisabled?: boolean;
  onCancelPreparation?(): void; preparing?: boolean;
  controls: Ref<MobileAttachmentControls>; insert(resolve: () => Promise<string | null>, original: MobileFileUpload): Promise<void>;
  pickFile?: (signal?: AbortSignal) => Promise<LocalAttachment | null>
  onPendingContentChange?: (pending: boolean) => void
}
/** A local selection and one original Host receipt, beside the maintained shared Composer. */
export function MobileAttachments({ client, session, agentSessionId, connected, promptOperationId, confirmedPrompt, onSendBodyOnly, bodyOnlyDisabled, onCancelPreparation, preparing, controls, insert, pickFile = signal => pickLocalAttachment(undefined, undefined, signal), onPendingContentChange }: Props) {
  const owner = useMobileWebAttachmentOwner(), ownerRevision = useSyncExternalStore(owner.subscribe, () => owner.revision, () => owner.revision)
  const uploads = owner.uploads.current
  const [notice, setNotice] = useState<string | null>(null)
  const [copyDecision, setCopyDecision] = useState<CopyDecision | null>(null)
  const [copyManager, setCopyManager] = useState<string | null>(null)
  const { pickerOpen, selectionTail, selections, nextSelection, recordIds, originalEntries, bytes, exports: exportedCopies, busy, current } = owner
  const protectUpdate = useMobileWebUpdatePendingAction()
  const latestUploads = owner.uploads
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  current.current = { client, session, connected, promptOperationId }
  const scope = () => {
    let original = current.current.session
    try { if (original) original = current.current.client?.agentSession(original.agentSessionId) ?? null }
    catch { original = null }
    return { runtimeId: current.current.client?.runtimeOwnerIdentity?.()?.runtimeId ?? null,
      hostId: original?.hostId ?? null, sessionId: original?.agentSessionId ?? null,
      runId: original?.run.runId ?? null }
  }
  const retain = async (upload: MobileFileUpload, required = false) => {
    if (upload.phase !== 'selected') {
      const id = upload.identity.operationId, recordId = recordIds.current.get(id) ?? null, intent = fileUploadIntentKey(upload)
      const sameOriginal = () => getDeviceWorkface().recordIdentity() === recordId && (recordIds.current.get(id) ?? null) === recordId &&
        (!latestUploads.current.some(item => item.identity.operationId === id) || latestUploads.current.some(item => item.identity.operationId === id && fileUploadIntentKey(item) === intent))
      try {
        if (!sameOriginal()) throw new Error('原设备工作面或附件请求已改变。')
        const previous = originalEntries.current.get(id)
        if (previous && fileUploadIntentKey(previous) === intent && (previous.phase === 'uploaded' || previous.phase === 'inserted') &&
            upload.phase !== 'uploaded' && upload.phase !== 'inserted') throw new Error('原上传已确认；不会用较早的未确认结果覆盖回执。')
        await getDeviceWorkface().retainFileUpload(upload, recordId, previous)
        if (!sameOriginal()) throw new Error('原设备工作面或附件请求已改变。')
        originalEntries.current.set(upload.identity.operationId, upload) }
      catch (error) {
        if (required) throw new Error(`原上传操作尚未保全；请核对原操作，附件和草稿保留。${errorMessage(error)}`)
        if (mounted.current) setNotice(`原附件回执尚未保全；可核对同一操作。${errorMessage(error)}`)
        return false
      }
    }
    latestUploads.current = latestUploads.current.some(item => item.identity.operationId === upload.identity.operationId)
      ? latestUploads.current.map(item => item.identity.operationId === upload.identity.operationId ? upload : item) : [...latestUploads.current, upload]
    owner.changed()
    return true
  }
  const remove = async (upload: MobileFileUpload) => {
    try {
      if (exportedCopies.current.has(upload.identity.operationId) && bytes.current.has(upload.identity.operationId)) return
      if (originalEntries.current.has(upload.identity.operationId)) await getDeviceWorkface().removeFileUpload(upload.identity.operationId, recordIds.current.get(upload.identity.operationId) ?? null)
      bytes.current.delete(upload.identity.operationId)
      latestUploads.current = latestUploads.current.filter(item => item.identity.operationId !== upload.identity.operationId)
      owner.changed()
    } catch (error) { setNotice(errorMessage(error)) }
  }
  function decideCopy(upload: MobileFileUpload, file: LocalAttachment, kind: CopyDecision['kind']): CopyDecision {
    return { upload, file, kind, intent: fileUploadIntentKey(upload), recordId: recordIds.current.get(upload.identity.operationId) ?? null,
      revision: file.revision, dataBase64: file.dataBase64 }
  }
  function exportCopy(upload: MobileFileUpload, file: LocalAttachment) {
    const id = upload.identity.operationId
    let created = false
    try {
      let saved = exportedCopies.current.get(id)
      if (!saved || saved.file !== file) {
        const binary = atob(file.dataBase64), data = Uint8Array.from(binary, character => character.charCodeAt(0))
        saved = { file, url: URL.createObjectURL(new Blob([data], { type: file.mimeType })) }; created = true
        exportedCopies.current.set(id, saved)
      }
      const url = saved.url
      const link = document.createElement('a'); link.href = url; link.download = file.name; link.click()
      setCopyDecision(decideCopy(upload, file, 'saved'))
      setNotice('已请求保存；浏览器尚未确认文件已保存。请核对保存结果后再确认。')
    } catch (error) {
      if (created) { const saved = exportedCopies.current.get(id); if (saved) { try { URL.revokeObjectURL(saved.url) } catch { /* The browser owns URL cleanup. */ }; exportedCopies.current.delete(id) } }
      setNotice(`本机副本未确认保存；原附件仍保留。${errorMessage(error)}`)
    }
  }
  function releaseCopy(decision: NonNullable<typeof copyDecision>) {
    const id = decision.upload.identity.operationId
    const currentUpload = latestUploads.current.find(item => item.identity.operationId === id)
    if (bytes.current.get(id) !== decision.file || decision.file.revision !== decision.revision || decision.file.dataBase64 !== decision.dataBase64 ||
        !currentUpload || fileUploadIntentKey(currentUpload) !== decision.intent || (recordIds.current.get(id) ?? null) !== decision.recordId || busy.current.has(id)) {
      setNotice('原附件或其操作已变化；本次没有移除本机副本。'); setCopyDecision(null); return
    }
    bytes.current.delete(id)
    const saved = exportedCopies.current.get(id)
    if (saved?.file === decision.file) { try { URL.revokeObjectURL(saved.url) } catch { /* The browser owns URL cleanup. */ }; exportedCopies.current.delete(id) }
    if (!originalEntries.current.has(id)) latestUploads.current = latestUploads.current.filter(item => item !== currentUpload)
    else latestUploads.current = latestUploads.current.map(item => item === currentUpload ? { ...item, issue: '本机副本已移除；原 Host 操作仍保留，可核对原回执。' } : item)
    owner.changed(); setCopyDecision(null)
    setNotice('本机副本已移除；原 Host 操作与其他附件未删除。')
  }
  useEffect(() => {
    if (!confirmedPrompt) return
    for (const upload of uploads) if (upload.phase === 'inserted' && fileUploadScopeMatches(upload, confirmedPrompt.source) && upload.path && draftIncludesUpload(confirmedPrompt.body, upload.path)) remove(upload)
  }, [confirmedPrompt?.operationId, confirmedPrompt?.body, confirmedPrompt?.source.runtimeId, confirmedPrompt?.source.hostId, confirmedPrompt?.source.sessionId, confirmedPrompt?.source.runId])

  function selectionTarget(): SelectionTarget | null {
    const { client, session } = current.current
    const runtimeId = client?.runtimeOwnerIdentity?.()?.runtimeId
    if (!client || !session || !runtimeId) { setNotice('尚未确认原会话与 Mac；这次附件没有上传。原消息仍可编辑。'); return null }
    return { runtimeId, hostId: session.hostId, sessionId: session.agentSessionId, runId: session.run.runId,
      recordId: getDeviceWorkface().recordIdentity() }
  }
  async function stageSelectedAttachment(file: LocalAttachment, original: SelectionTarget): Promise<void> {
    if (bytes.current.has(file.id) || latestUploads.current.some(item => item.identity.operationId === file.id) || originalEntries.current.has(file.id)) {
      throw new Error('附件操作标识与原记录冲突；原附件和这次正文保留，请重新选择文件。')
    }
    if ([...bytes.current.values()].reduce((total, item) => total + item.size, 0) + file.size > FILE_UPLOAD_MAX_BYTES * 4) {
      throw new Error('待上传附件已占用这台设备的本次选择预算；先上传或移除一个附件，再选择新文件。原草稿保留。')
    }
    const identity: FileUploadIdentity = { hostId: original.hostId, agentSessionId: original.sessionId,
      expectedRun: { runId: original.runId }, operationId: file.id, name: file.name,
      mimeType: file.mimeType, byteLength: file.size, revision: file.revision }
    parseFileUploadParams({ ...identity, dataBase64: file.dataBase64 })
    recordIds.current.set(file.id, original.recordId)
    bytes.current.set(file.id, file)
    owner.changed()
    const upload: MobileFileUpload = { runtimeId: original.runtimeId, identity, phase: 'selected' }
    const recordChanged = getDeviceWorkface().recordIdentity() !== original.recordId
    const changed = recordChanged || !fileUploadScopeMatches(upload, scope())
    await retain(changed ? { ...upload, issue: '选择开始时的会话、Run 或设备工作面已改变；附件仍保留在原目标，没有上传或转绑。' } : upload)
    if (changed && mounted.current) setNotice(`已保留 ${file.name} 的原选择（${original.sessionId}）；${recordChanged ? '设备工作面已替换，可移除后重新选择' : '返回原目标后继续'}，当前草稿未改变。`)
  }
  function beginSelection(kind: SelectionOperation['kind'], label: string, target: SelectionTarget, allowUpdate: () => void): SelectionOperation {
    let stop!: () => void
    const stopped = new Promise<void>(resolve => { stop = resolve })
    const operation: SelectionOperation = { id: ++nextSelection.current, kind, label, target, cancelled: false, expanded: false,
      controller: new AbortController(), allowUpdate, stopped, stop }
    selections.current.set(operation.id, operation)
    owner.changed()
    return operation
  }
  function finishSelection(operation: SelectionOperation) {
    if (pickerOpen.current === operation) pickerOpen.current = null
    if (!selections.current.delete(operation.id)) return
    owner.changed()
  }
  function cancelSelection(operation: SelectionOperation) {
    if (selections.current.get(operation.id) !== operation) return
    operation.cancelled = true; operation.controller.abort(); operation.stop(); operation.allowUpdate()
    finishSelection(operation)
    if (mounted.current) setNotice(`已结束本次${operation.kind === 'picker' ? '选择' : '读取'}等待；其他附件和原正文保留。`)
  }
  async function choose(): Promise<void> {
    if (pickerOpen.current) return
    const original = selectionTarget()
    if (!original) return
    setNotice(null)
    await protectUpdate(`原 Session ${original.sessionId} 的附件选择尚未结束；返回原对话结束该次等待，或等待完成后再更新。`, async allowUpdate => {
      const operation = beginSelection('picker', '附件', original, allowUpdate)
      pickerOpen.current = operation
      try {
        const pending = (async () => {
          const file = await pickFile(operation.controller.signal)
          if (operation.cancelled || !file) return
          await stageSelectedAttachment(file, original)
        })()
        await Promise.race([pending, operation.stopped])
      } catch (error) { if (mounted.current && !operation.cancelled) setNotice(errorMessage(error)) }
      finally { finishSelection(operation) }
    })
  }
  async function stageFiles(files: readonly LocalAttachmentFile[]): Promise<void> {
    const original = selectionTarget(), selected = [...files]
    if (!original || !selected.length) return
    setNotice(null)
    await protectUpdate(`原 Session ${original.sessionId} 的附件读取尚未结束；返回原对话结束该次等待，或等待完成后再更新。`, async allowUpdate => {
      const label = `${selected[0]!.name || '未命名附件'}${selected.length > 1 ? ` 等 ${selected.length} 项` : ''}`
      const operation = beginSelection('read', label, original, allowUpdate)
      const predecessor = selectionTail.current
      const pending = predecessor.then(async () => {
        const failures: string[] = []
        for (const rawFile of selected) {
          if (operation.cancelled) return
          try {
            const file = await localAttachmentFromBlob(rawFile, operation.controller.signal)
            if (operation.cancelled) return
            await stageSelectedAttachment(file, original)
          } catch (error) {
            if (operation.cancelled) return
            failures.push(`${rawFile.name || '未命名附件'}：${errorMessage(error)}`)
          }
        }
        if (mounted.current && failures.length) setNotice(failures.join('\n'))
      })
      const completion = Promise.race([pending, operation.stopped])
      selectionTail.current = predecessor.then(() => completion).catch(() => {})
      try { await completion } finally { finishSelection(operation) }
    })
  }
  async function stageFile(file: LocalAttachmentFile): Promise<void> { await stageFiles([file]) }
  useImperativeHandle(controls, () => ({ choose, stageFile, stageFiles, captureForSend }))

  async function add(upload: MobileFileUpload): Promise<void> {
    if (getDeviceWorkface().recordIdentity() !== (recordIds.current.get(upload.identity.operationId) ?? null) || !upload.path || !fileUploadScopeMatches(upload, scope())) throw new Error('原附件属于另一 Mac、Session 或 Run；回执已保留，当前草稿未改变。')
    await insert(async () => upload.path!, upload)
    await retain({ ...upload, phase: 'inserted' })
    if (!exportedCopies.current.has(upload.identity.operationId)) bytes.current.delete(upload.identity.operationId)
    owner.changed()
  }
  function retireFlight(flight: AttachmentFlight) {
    const id = flight.original.identity.operationId
    flight.cancelled = true; flight.claimedForSend = true
    if (flight.saved && busy.current.get(id) === flight) {
      flight.stop()
      busy.current.delete(id)
      const issue = flight.dispatched === 'upload' ? '已结束上传等待；原操作回执未知，可核对同一操作，不会自动重传。'
        : flight.dispatched === 'inspect' ? '已结束核对等待；原上传是否发生仍未知，可核对同一操作。'
        : '已取消本页续做；原请求尚未派发，原操作与附件保留。'
      const known = originalEntries.current.get(id)
      latestUploads.current = latestUploads.current.map(item => item.identity.operationId === id &&
        fileUploadIntentKey(item) === flight.intent && (recordIds.current.get(id) ?? null) === flight.recordId
        ? known && fileUploadIntentKey(known) === flight.intent && (known.phase === 'uploaded' || known.phase === 'inserted') ? known : { ...item, phase: 'unknown', issue } : item)
      owner.changed()
    }
    if (mounted.current) {
      setNotice(flight.saved ? null : '已取消后续上传；设备仍在保全原操作，完成前请保留当前页面。')
    }
  }
  function act(upload: MobileFileUpload, inspectOnly: boolean, insertIntoDraft = true): Promise<MobileFileUpload | null> {
    upload = structuredClone(upload)
    const id = upload.identity.operationId
    const existing = busy.current.get(id), recordId = getDeviceWorkface().recordIdentity(), intent = fileUploadIntentKey(upload)
    if (existing) {
      if (existing.client !== current.current.client || existing.recordId !== recordId || existing.intent !== intent || !fileUploadScopeMatches(upload, scope())) {
        const issue = '原上传仍属于另一客户端、工作面或目标；本次未上传、插入或发送，可核对原操作。'
        const { path: _path, ...original } = upload
        setNotice(issue); return Promise.resolve({ ...original, phase: 'error', issue })
      }
      if (!insertIntoDraft) existing.claimedForSend = true
      return existing.result
    }
    let stop!: () => void
    const stopped = new Promise<null>(resolve => { stop = () => resolve(null) })
    const flight: AttachmentFlight = { client: current.current.client, recordId, intent, claimedForSend: !insertIntoDraft,
      saved: false, dispatched: null, cancelled: false, original: structuredClone(upload), stop, stopped, result: null as unknown as Promise<MobileFileUpload | null> }
    const run = async (): Promise<MobileFileUpload | null> => {
      const originalClient = current.current.client, originalScope = scope(), originalPrompt = current.current.promptOperationId
      let requested = false, confirmed: MobileFileUpload | null = null
      try {
        if (getDeviceWorkface().recordIdentity() !== (recordIds.current.get(id) ?? null)) throw new Error('设备工作面已被替换；原附件仍保留，本次不上传或插入。')
        if (!current.current.connected || !originalClient?.forwardRpc) throw new Error('原 Mac 当前未连接；附件和草稿保留，可连接后再试。')
        if (upload.runtimeId !== originalScope.runtimeId || upload.identity.hostId !== originalScope.hostId || upload.identity.agentSessionId !== originalScope.sessionId) throw new Error('当前连接不属于原附件的 Mac 与 Session；本次未上传或重传。')
        if (upload.phase === 'uploaded' && !inspectOnly) { if (insertIntoDraft) await add(upload); return upload }
        if (!inspectOnly && !fileUploadScopeMatches(upload, originalScope)) throw new Error('原 Run 已变化；本次未上传，原文件仍保留。')
        const file = bytes.current.get(id)
        if (!inspectOnly && !file) throw new Error('本次设备选择已结束；原上传记录保留，可先核对原操作。')
        const persisted = originalEntries.current.get(id)
        if (!(inspectOnly && persisted && fileUploadIntentKey(persisted) === intent && (persisted.phase === 'uploaded' || persisted.phase === 'inserted'))) {
          await retain({ ...upload, phase: 'sending' }, true)
        }
        flight.saved = true
        if (flight.cancelled) { retireFlight(flight); return null }
        if (fileUploadIntentKey(upload) !== flight.intent || getDeviceWorkface().recordIdentity() !== flight.recordId) throw new Error('原设备工作面或附件请求已改变；没有派发这次操作。')
        let inserted = false
        const request = async () => {
          if (flight.cancelled) return null
          if (fileUploadIntentKey(upload) !== flight.intent || getDeviceWorkface().recordIdentity() !== flight.recordId) throw new Error('原设备工作面或附件请求已改变；没有派发这次操作。')
          requested = true
          const pending = inspectOnly ? originalClient.forwardRpc!('file.upload.inspect', upload.identity)
            : originalClient.forwardRpc!('file.upload', { ...upload.identity, dataBase64: file!.dataBase64 })
          flight.dispatched = inspectOnly ? 'inspect' : 'upload'
          const response = await pending
          confirmed = uploadFromReceipt(upload, response)
          if (!await retain(confirmed)) return null
          return confirmed
        }
        // Capture the maintained editor's bookmark before the asynchronous request. Its
        // transaction mapping keeps later typing without copying or replacing the draft.
        if (insertIntoDraft && fileUploadScopeMatches(upload, originalScope)) {
          await insert(async () => {
            const original = await request()
            if (!original || flight.cancelled || flight.claimedForSend || getDeviceWorkface().recordIdentity() !== (recordIds.current.get(id) ?? null) || original.phase !== 'uploaded' || !fileUploadScopeMatches(original, scope()) || originalPrompt !== current.current.promptOperationId) return null
            inserted = true; return original.path!
          }, upload)
        } else await request()
        if (inserted && confirmed) {
          await retain({ ...(confirmed as MobileFileUpload), phase: 'inserted' }); if (!exportedCopies.current.has(id)) bytes.current.delete(id); owner.changed()
        }
        return confirmed
      } catch (error) {
        const retained = confirmed as MobileFileUpload | null
        const failed: MobileFileUpload = retained?.phase === 'uploaded' ? { ...retained, issue: errorMessage(error) }
          : { ...upload, phase: requested ? 'unknown' : upload.phase, issue: errorMessage(error) }
        if (flight.cancelled) {
          if (!flight.saved && mounted.current) setNotice(`设备未能保全原操作；后续上传已取消，附件和正文保留。${errorMessage(error)}`)
          return null
        }
        await retain(failed)
        return failed
      }
    }
    flight.result = Promise.race([run(), flight.stopped]).finally(() => { if (busy.current.get(id) === flight) { busy.current.delete(id); owner.changed() } })
    busy.current.set(id, flight)
    owner.changed()
    return flight.result
  }
  function captureForSend(): MobilePromptPreparation | null {
    const originalClient = current.current.client, originalScope = scope(), originalRecord = getDeviceWorkface().recordIdentity()
    const selected = latestUploads.current.filter(upload => upload.phase !== 'inserted' && upload.identity.agentSessionId === originalScope.sessionId &&
      (!originalScope.runtimeId || upload.runtimeId === originalScope.runtimeId) && (!originalScope.hostId || upload.identity.hostId === originalScope.hostId))
    const wasReading = [...selections.current.values()].some(operation => operation.target.sessionId === originalScope.sessionId &&
      (!originalScope.runtimeId || operation.target.runtimeId === originalScope.runtimeId) && (!originalScope.hostId || operation.target.hostId === originalScope.hostId))
    if (!selected.length && !wasReading) return null
    const confirmed: MobileFileUpload[] = []
    let cancelled = false
    const originalSelection = selected.every(upload => recordIds.current.get(upload.identity.operationId) === originalRecord && fileUploadScopeMatches(upload, originalScope))
    const assertOriginal = () => {
      if (cancelled) throw new Error('本次发送准备已取消；原上传和附件仍保留。')
      const now = scope()
      if (!mounted.current || current.current.client !== originalClient || getDeviceWorkface().recordIdentity() !== originalRecord ||
          !originalSelection || now.sessionId !== originalScope.sessionId || now.runId !== originalScope.runId || now.runtimeId !== originalScope.runtimeId || now.hostId !== originalScope.hostId) {
        throw new Error('原附件消息的 Mac、Session、Run 或设备工作面已改变；原正文和附件保留，没有请求输入。')
      }
    }
    return {
      cancel() { cancelled = true },
      async prepare(body) {
        assertOriginal()
        if (wasReading) throw new Error('所选附件仍在读取；正文和选择保留，读取完成后再发送。')
        for (const upload of selected) {
          assertOriginal()
          const result = await act(upload, upload.phase === 'unknown' || upload.phase === 'sending', false)
          assertOriginal()
          if (result?.phase !== 'uploaded' || !result.path) throw new Error(`附件未就绪；本次消息没有发送。${result?.issue ?? '原上传结果尚未确认。'} 可在附件详情核对原操作，或明确仅发送正文。`)
          confirmed.push(result)
        }
        return confirmed.reduce((text, upload) => draftIncludesUpload(body, upload.path!) ? text : appendNamedFileReference(text, upload.path!, upload.identity.name), body)
      },
      async commit() {
        assertOriginal()
        for (const upload of confirmed) {
          await retain({ ...upload, phase: 'inserted' }, true)
          if (!exportedCopies.current.has(upload.identity.operationId)) bytes.current.delete(upload.identity.operationId)
          owner.changed()
          assertOriginal()
        }
      }
    }
  }
  useEffect(() => {
    const target = scope()
    const selectedSession = agentSessionId ?? session?.agentSessionId
    onPendingContentChange?.([...selections.current.values()].some(operation => operation.target.sessionId === selectedSession &&
      (!target.runtimeId || operation.target.runtimeId === target.runtimeId) && (!target.hostId || operation.target.hostId === target.hostId)) ||
      uploads.some(upload => upload.phase !== 'inserted' && upload.identity.agentSessionId === selectedSession &&
      (!target.runtimeId || upload.runtimeId === target.runtimeId) && (!target.hostId || upload.identity.hostId === target.hostId)))
  }, [uploads, client, session, agentSessionId, ownerRevision, onPendingContentChange])
  const visibleSelections = [...selections.current.values()].filter(operation => operation.target.sessionId === (agentSessionId ?? session?.agentSessionId))
  const visibleScope = scope()
  const visible = uploads.filter(upload => upload.identity.agentSessionId === (agentSessionId ?? session?.agentSessionId) &&
    (upload.phase !== 'inserted' || bytes.current.has(upload.identity.operationId) && exportedCopies.current.has(upload.identity.operationId)) &&
    (!visibleScope.hostId || upload.identity.hostId === visibleScope.hostId) && (!visibleScope.runtimeId || upload.runtimeId === visibleScope.runtimeId))
  const bodyOnlyToolbar = visible.find(upload => upload.phase !== 'inserted' && bytes.current.has(upload.identity.operationId) && !busy.current.has(upload.identity.operationId) &&
    (upload.phase === 'unknown' || exportedCopies.current.has(upload.identity.operationId) || copyDecision?.upload.identity.operationId === upload.identity.operationId))
  return <div className="mobile-attachments" aria-live="polite">
    {visibleSelections.map((operation, index) => <div className="mobile-attachment-pending" key={operation.id}>
      <div className="mobile-attachment-pending__row">
        <button type="button" className="mobile-attachment-pending__status" aria-expanded={operation.expanded} aria-label={`${operation.kind === 'picker' ? '附件选择' : `读取 ${operation.label}`}的原目标`}
          onClick={() => { operation.expanded = !operation.expanded; owner.changed() }}>
          <SemanticIcon name="status.loading" size={13} animation="spin" /><span>{operation.kind === 'picker' ? '选择附件中' : `读取 ${operation.label}`}</span><small>{operation.expanded ? '收起' : '详情'}</small>
        </button>
        <button type="button" className="mobile-text-button" aria-label={operation.kind === 'picker' ? '取消本次选择' : '取消本次读取'} onClick={() => cancelSelection(operation)}>取消</button>
        {index === 0 && onSendBodyOnly && <button type="button" className="mobile-text-button" aria-label="本次仅发送正文" disabled={bodyOnlyDisabled} onClick={onSendBodyOnly}>仅正文</button>}
      </div>
      {operation.expanded && <p className="mobile-attachment-pending__identity">原 Host {operation.target.hostId} · Session {operation.target.sessionId} · Run {operation.target.runId} · Runtime {operation.target.runtimeId}</p>}
    </div>)}
    {visible.map(upload => {
      const image = upload.identity.mimeType.startsWith('image/'), file = bytes.current.get(upload.identity.operationId)
      const inFlight = busy.current.has(upload.identity.operationId), busyUpload = upload.phase === 'sending' || inFlight, unknown = upload.phase === 'unknown', ready = upload.phase === 'uploaded' || upload.phase === 'inserted'
      const targetUnknown = !visibleScope.runtimeId || !visibleScope.hostId || !visibleScope.runId
      const canRemove = !busyUpload && !unknown && !exportedCopies.current.has(upload.identity.operationId)
      return <div className="mobile-attachment-entry" key={upload.identity.operationId}><div className="mobile-attachment" data-phase={upload.phase}>
        {image && file ? <img className="mobile-attachment-preview" alt="" src={`data:${file.mimeType};base64,${file.dataBase64}`} />
          : <span className="mobile-attachment-icon">{image ? <SemanticIcon name="object.image" size={19} /> : <SemanticIcon name="object.file" size={19} />}</span>}
        <div className="mobile-attachment-copy"><details className="mobile-attachment-details"><summary aria-label={`${upload.identity.name} 原上传详情`}><strong title={upload.identity.name}>{upload.identity.name}</strong>
          <small>{targetUnknown ? '目标未确认' : upload.identity.byteLength < 1024 ? `${upload.identity.byteLength} B` : `${(upload.identity.byteLength / 1024).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} KB`} · {busyUpload ? '正在核对原上传…' : unknown ? '回执待核对' : ready ? '已在原 Mac' : targetUnknown ? '仅在本机' : '仅在这台设备'}</small></summary>
          {targetUnknown && <p className="mobile-attachment-original">当前连接目标尚未确认；原目标：</p>}
          <p className={targetUnknown ? 'mobile-attachment-original' : undefined}>Host <code>{upload.identity.hostId}</code> · Session <code>{upload.identity.agentSessionId}</code> · Run <code>{upload.identity.expectedRun.runId}</code></p><p>操作 <code>{upload.identity.operationId}</code></p>{upload.issue && <p>{upload.issue}</p>}{upload.phase !== 'selected' && !busyUpload && !unknown && <button type="button" className="mobile-text-button" onClick={() => { void act(upload, true, false) }}>核对 {upload.identity.name} 原上传</button>}</details>
          </div>
        {!busyUpload && upload.phase !== 'inserted' && <button type="button" className="mobile-icon-button" aria-label={ready ? `将 ${upload.identity.name} 加入消息` : unknown ? `核对 ${upload.identity.name} 原上传` : `上传并加入 ${upload.identity.name}`}
          title={ready ? '加入消息' : unknown ? '核对原上传' : '上传并加入消息'} onClick={() => { void act(upload, unknown) }}>
          {ready ? <SemanticIcon name="action.confirm" size={17} /> : unknown ? <SemanticIcon name="action.refresh" size={17} /> : <SemanticIcon name="action.upload" size={17} />}</button>}
        {busyUpload && <><SemanticIcon name="status.loading" size={17} animation="spin" aria-label="上传回执待确认" />{inFlight && <button type="button" className="mobile-text-button" aria-label="结束等待" onClick={() => { const flight = busy.current.get(upload.identity.operationId); if (flight) retireFlight(flight) }}>结束等待</button>}</>}
        {canRemove && <button type="button" className="mobile-icon-button" aria-label={`移除 ${upload.identity.name} 本地引用`} onClick={() => remove(upload)}><SemanticIcon name="action.close" size={15} /></button>}
      </div>{upload.issue && !unknown && <MobileNotice className="mobile-attachment-notice" identity={[upload.identity.operationId,upload.phase,upload.issue]} role="status">{upload.issue.split('\n')[0]}</MobileNotice>}
      {file && !busyUpload && (unknown || exportedCopies.current.has(upload.identity.operationId) || copyDecision?.upload.identity.operationId === upload.identity.operationId) && <div className="mobile-attachment-copy-actions">
        <div className="mobile-attachment-copy-actions__toolbar">
          <button type="button" className="mobile-text-button" aria-label={`管理 ${upload.identity.name} 本机副本`} aria-expanded={copyManager === upload.identity.operationId}
            onClick={() => { setCopyManager(copyManager === upload.identity.operationId ? null : upload.identity.operationId); setCopyDecision(null) }}>{exportedCopies.current.has(upload.identity.operationId) ? '本机副本 · 另存待确认' : '本机副本'}</button>
          {bodyOnlyToolbar === upload && visibleSelections.length === 0 && onSendBodyOnly && <button type="button" className="mobile-text-button" aria-label="本次仅发送正文" disabled={bodyOnlyDisabled} onClick={onSendBodyOnly}>仅发送正文</button>}
        </div>
        {copyManager === upload.identity.operationId && (copyDecision?.upload.identity.operationId === upload.identity.operationId
          ? <div className="mobile-attachment-copy-actions__confirm"><p>{copyDecision.kind === 'saved' ? '确认已另行保存' : '确认放弃'} <strong>{upload.identity.name}</strong> 的本机副本？</p><div>
            <button type="button" className="mobile-text-button" onClick={() => { setCopyDecision(null); setNotice(value => value === '已请求保存；浏览器尚未确认文件已保存。请核对保存结果后再确认。' ? null : value) }}>保留</button>
            <button type="button" className="mobile-text-button" onClick={() => releaseCopy(copyDecision)}>{copyDecision.kind === 'saved' ? '已保存，移除副本' : '确认放弃'}</button>
          </div></div>
          : <div className="mobile-attachment-copy-actions__choices">
            <button type="button" className="mobile-text-button" onClick={() => exportCopy(upload, file)}>保存本机副本</button>
            {exportedCopies.current.has(upload.identity.operationId) && <button type="button" className="mobile-text-button" onClick={() => setCopyDecision(decideCopy(upload, file, 'saved'))}>确认已另存</button>}
            <button type="button" className="mobile-text-button" onClick={() => setCopyDecision(decideCopy(upload, file, 'discard'))}>放弃本机副本</button>
          </div>)}
      </div>}</div>
    })}
    {visible.some(upload => upload.phase !== 'inserted') && !bodyOnlyToolbar && visibleSelections.length === 0 && onSendBodyOnly && <button type="button" className="mobile-text-button" disabled={bodyOnlyDisabled} onClick={onSendBodyOnly}>本次仅发送正文</button>}
    {preparing && onCancelPreparation && <button type="button" className="mobile-text-button" onClick={onCancelPreparation}>取消发送准备</button>}
    {notice && <MobileNotice identity={[session?.agentSessionId,notice]} className="mobile-attachment-notice" role="status">{notice}</MobileNotice>}
  </div>
}
