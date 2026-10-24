import { MobileNotice } from '../notices/MobileNotice'
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
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

export type MobileAttachmentControls = {
  choose(): Promise<void>
  stageFile(file: LocalAttachmentFile): Promise<void>
  stageFiles(files: readonly LocalAttachmentFile[]): Promise<void>
  captureForSend(): MobilePromptPreparation | null
}
type SelectionTarget = { runtimeId: string; hostId: string; sessionId: string; runId: string; recordId: string | null }
type Props = {
  client: AgentMuxHostedClient | null; session: AgentMuxAgentSession | null; connected: boolean;
  promptOperationId: string | null; confirmedPrompt: ConfirmedAttachmentPrompt | null;
  onSendBodyOnly?(): void; bodyOnlyDisabled?: boolean;
  controls: Ref<MobileAttachmentControls>; insert(resolve: () => Promise<string | null>, original: MobileFileUpload): Promise<void>;
  pickFile?: () => Promise<LocalAttachment | null>
  onPendingContentChange?: (pending: boolean) => void
}
/** A local selection and one original Host receipt, beside the maintained shared Composer. */
export function MobileAttachments({ client, session, connected, promptOperationId, confirmedPrompt, onSendBodyOnly, bodyOnlyDisabled, controls, insert, pickFile = pickLocalAttachment, onPendingContentChange }: Props) {
  const [uploads, setUploads] = useState<MobileFileUpload[]>(() => (getDeviceWorkface().snapshot().record.fileUploads ?? []).map(item =>
    item.phase === 'sending' ? { ...item, phase: 'unknown', issue: '原上传回执尚未确认；核对同一操作，不会自动重传。' } : item))
  const [notice, setNotice] = useState<string | null>(null), [readingCount, setReadingCount] = useState(0)
  const pickerOpen = useRef(false), selectionTail = useRef(Promise.resolve())
  const recordIds = useRef(new Map(uploads.map(upload => [upload.identity.operationId, getDeviceWorkface().recordIdentity()])))
  const originalEntries = useRef(new Map((getDeviceWorkface().snapshot().record.fileUploads ?? []).map(upload => [upload.identity.operationId, upload])))
  const bytes = useRef(new Map<string, LocalAttachment>())
  const latestUploads = useRef(uploads)
  const reading = useRef(0)
  const busy = useRef(new Map<string, { client: AgentMuxHostedClient | null; recordId: string | null; intent: string; claimedForSend: boolean; result: Promise<MobileFileUpload | null> }>())
  const [, updateActivity] = useState(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const current = useRef({ client, session, connected, promptOperationId })
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
      try { await getDeviceWorkface().retainFileUpload(upload, recordIds.current.get(upload.identity.operationId) ?? null, originalEntries.current.get(upload.identity.operationId))
        originalEntries.current.set(upload.identity.operationId, upload) }
      catch (error) {
        if (required) throw new Error(`原上传操作尚未保全；本次没有上传，附件和草稿保留。${errorMessage(error)}`)
        if (mounted.current) setNotice(`附件回执仅在本次运行中保留：${errorMessage(error)}`)
      }
    }
    latestUploads.current = latestUploads.current.some(item => item.identity.operationId === upload.identity.operationId)
      ? latestUploads.current.map(item => item.identity.operationId === upload.identity.operationId ? upload : item) : [...latestUploads.current, upload]
    if (mounted.current) setUploads(latestUploads.current)
  }
  const remove = async (upload: MobileFileUpload) => {
    try {
      if (originalEntries.current.has(upload.identity.operationId)) await getDeviceWorkface().removeFileUpload(upload.identity.operationId, recordIds.current.get(upload.identity.operationId) ?? null)
      bytes.current.delete(upload.identity.operationId)
      latestUploads.current = latestUploads.current.filter(item => item.identity.operationId !== upload.identity.operationId)
      setUploads(latestUploads.current)
    } catch (error) { setNotice(errorMessage(error)) }
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
    if ([...bytes.current.values()].reduce((total, item) => total + item.size, 0) + file.size > FILE_UPLOAD_MAX_BYTES * 4) {
      throw new Error('待上传附件已占用这台设备的本次选择预算；先上传或移除一个附件，再选择新文件。原草稿保留。')
    }
    const identity: FileUploadIdentity = { hostId: original.hostId, agentSessionId: original.sessionId,
      expectedRun: { runId: original.runId }, operationId: file.id, name: file.name,
      mimeType: file.mimeType, byteLength: file.size, revision: file.revision }
    parseFileUploadParams({ ...identity, dataBase64: file.dataBase64 })
    recordIds.current.set(file.id, original.recordId)
    bytes.current.set(file.id, file)
    const upload: MobileFileUpload = { runtimeId: original.runtimeId, identity, phase: 'selected' }
    const recordChanged = getDeviceWorkface().recordIdentity() !== original.recordId
    const changed = recordChanged || !fileUploadScopeMatches(upload, scope())
    await retain(changed ? { ...upload, issue: '选择开始时的会话、Run 或设备工作面已改变；附件仍保留在原目标，没有上传或转绑。' } : upload)
    if (changed && mounted.current) setNotice(`已保留 ${file.name} 的原选择（${original.sessionId}）；${recordChanged ? '设备工作面已替换，可移除后重新选择' : '返回原目标后继续'}，当前草稿未改变。`)
  }
  async function choose(): Promise<void> {
    if (pickerOpen.current) return
    const original = selectionTarget()
    if (!original) return
    pickerOpen.current = true; reading.current++; setReadingCount(value => value + 1); setNotice(null)
    try {
      const file = await pickFile()
      if (!file) return
      await stageSelectedAttachment(file, original)
    } catch (error) { if (mounted.current) setNotice(errorMessage(error)) }
    finally { pickerOpen.current = false; reading.current--; if (mounted.current) setReadingCount(value => value - 1) }
  }
  async function stageFiles(files: readonly LocalAttachmentFile[]): Promise<void> {
    const original = selectionTarget(), selected = [...files]
    if (!original || !selected.length) return
    reading.current++; setReadingCount(value => value + 1); setNotice(null)
    const pending = selectionTail.current.then(async () => {
      const failures: string[] = []
      for (const rawFile of selected) {
        try { await stageSelectedAttachment(await localAttachmentFromBlob(rawFile), original) }
        catch (error) { failures.push(`${rawFile.name || '未命名附件'}：${errorMessage(error)}`) }
      }
      if (mounted.current && failures.length) setNotice(failures.join('\n'))
    })
    selectionTail.current = pending.catch(() => {})
    try { await pending }
    finally { reading.current--; if (mounted.current) setReadingCount(value => value - 1) }
  }
  async function stageFile(file: LocalAttachmentFile): Promise<void> { await stageFiles([file]) }
  useImperativeHandle(controls, () => ({ choose, stageFile, stageFiles, captureForSend }))

  async function add(upload: MobileFileUpload): Promise<void> {
    if (getDeviceWorkface().recordIdentity() !== (recordIds.current.get(upload.identity.operationId) ?? null) || !upload.path || !fileUploadScopeMatches(upload, scope())) throw new Error('原附件属于另一 Mac、Session 或 Run；回执已保留，当前草稿未改变。')
    await insert(async () => upload.path!, upload)
    await retain({ ...upload, phase: 'inserted' })
    bytes.current.delete(upload.identity.operationId)
  }
  function act(upload: MobileFileUpload, inspectOnly: boolean, insertIntoDraft = true): Promise<MobileFileUpload | null> {
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
    const flight = { client: current.current.client, recordId, intent, claimedForSend: !insertIntoDraft, result: null as unknown as Promise<MobileFileUpload | null> }
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
        await retain({ ...upload, phase: 'sending' }, true)
        requested = true
        let inserted = false
        const request = async () => {
          const response = inspectOnly ? await originalClient.forwardRpc!('file.upload.inspect', upload.identity)
            : await originalClient.forwardRpc!('file.upload', { ...upload.identity, dataBase64: file!.dataBase64 })
          confirmed = uploadFromReceipt(upload, response); await retain(confirmed)
          return confirmed
        }
        // Capture the maintained editor's bookmark before the asynchronous request. Its
        // transaction mapping keeps later typing without copying or replacing the draft.
        if (insertIntoDraft && fileUploadScopeMatches(upload, originalScope)) {
          await insert(async () => {
            const original = await request()
            if (flight.claimedForSend || getDeviceWorkface().recordIdentity() !== (recordIds.current.get(id) ?? null) || original.phase !== 'uploaded' || !fileUploadScopeMatches(original, scope()) || originalPrompt !== current.current.promptOperationId) return null
            inserted = true; return original.path!
          }, upload)
        } else await request()
        if (inserted && confirmed) {
          await retain({ ...(confirmed as MobileFileUpload), phase: 'inserted' }); bytes.current.delete(id)
        }
        return confirmed
      } catch (error) {
        const retained = confirmed as MobileFileUpload | null
        const failed: MobileFileUpload = retained?.phase === 'uploaded' ? { ...retained, issue: errorMessage(error) }
          : { ...upload, phase: requested ? 'unknown' : upload.phase, issue: errorMessage(error) }
        await retain(failed)
        return failed
      }
    }
    flight.result = run().finally(() => { if (busy.current.get(id) === flight) { busy.current.delete(id); if (mounted.current) updateActivity(value => value + 1) } })
    busy.current.set(id, flight)
    if (mounted.current) updateActivity(value => value + 1)
    return flight.result
  }
  function captureForSend(): MobilePromptPreparation | null {
    const originalClient = current.current.client, originalScope = scope(), originalRecord = getDeviceWorkface().recordIdentity()
    const selected = latestUploads.current.filter(upload => upload.identity.agentSessionId === originalScope.sessionId && upload.phase !== 'inserted')
    const wasReading = reading.current > 0
    if (!selected.length && !wasReading) return null
    const confirmed: MobileFileUpload[] = []
    let cancelled = false
    const originalSelection = selected.every(upload => recordIds.current.get(upload.identity.operationId) === originalRecord && fileUploadScopeMatches(upload, originalScope))
    const assertOriginal = () => {
      if (cancelled) throw new Error('本次已明确选择仅发送正文；原上传和附件仍保留。')
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
          bytes.current.delete(upload.identity.operationId)
          assertOriginal()
        }
      }
    }
  }
  useEffect(() => {
    const target = scope()
    onPendingContentChange?.(uploads.some(upload => upload.phase !== 'inserted' && fileUploadScopeMatches(upload, target) &&
      recordIds.current.get(upload.identity.operationId) === getDeviceWorkface().recordIdentity()))
  }, [uploads, client, session, onPendingContentChange])
  const visible = uploads.filter(upload => upload.identity.agentSessionId === session?.agentSessionId && upload.phase !== 'inserted')
  return <div className="mobile-attachments" aria-live="polite">
    {readingCount > 0 && <p className="mobile-attachment-notice"><SemanticIcon name="status.loading" size={13} animation="spin" />读取所选附件…</p>}
    {visible.map(upload => {
      const image = upload.identity.mimeType.startsWith('image/'), file = bytes.current.get(upload.identity.operationId)
      const inFlight = busy.current.has(upload.identity.operationId), busyUpload = upload.phase === 'sending' || inFlight, unknown = upload.phase === 'unknown', ready = upload.phase === 'uploaded'
      const canRemove = !busyUpload && !unknown
      return <div className="mobile-attachment" data-phase={upload.phase} key={upload.identity.operationId}>
        {image && file ? <img className="mobile-attachment-preview" alt="" src={`data:${file.mimeType};base64,${file.dataBase64}`} />
          : <span className="mobile-attachment-icon">{image ? <SemanticIcon name="object.image" size={19} /> : <SemanticIcon name="object.file" size={19} />}</span>}
        <div className="mobile-attachment-copy"><details className="mobile-attachment-details"><summary aria-label={`${upload.identity.name} 原上传详情`}><strong title={upload.identity.name}>{upload.identity.name}</strong>
          <small>{upload.identity.byteLength < 1024 ? `${upload.identity.byteLength} B` : `${(upload.identity.byteLength / 1024).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} KB`} · {busyUpload ? '正在核对原上传…' : unknown ? '回执待核对' : ready ? '已在原 Mac' : '仅在这台设备'}</small></summary>
          <p>操作 <code>{upload.identity.operationId}</code></p><p>Host <code>{upload.identity.hostId}</code> · Agent <code>{upload.identity.agentSessionId}</code> · Run <code>{upload.identity.expectedRun.runId}</code></p>{upload.issue && <p>{upload.issue}</p>}{upload.phase !== 'selected' && !busyUpload && !unknown && <button type="button" className="mobile-text-button" onClick={() => { void act(upload, true, false) }}>核对 {upload.identity.name} 原上传</button>}</details>
          {upload.issue && <MobileNotice identity={[upload.identity.operationId,upload.phase,upload.issue]} role="status">{upload.issue.split('\n')[0]}</MobileNotice>}
          </div>
        {!busyUpload && <button type="button" className="mobile-icon-button" aria-label={ready ? `将 ${upload.identity.name} 加入消息` : unknown ? `核对 ${upload.identity.name} 原上传` : `上传并加入 ${upload.identity.name}`}
          title={ready ? '加入消息' : unknown ? '核对原上传' : '上传并加入消息'} onClick={() => { void act(upload, unknown) }}>
          {ready ? <SemanticIcon name="action.confirm" size={17} /> : unknown ? <SemanticIcon name="action.refresh" size={17} /> : <SemanticIcon name="action.upload" size={17} />}</button>}
        {busyUpload && <SemanticIcon name="status.loading" size={17} animation="spin" aria-label="上传回执待确认" />}
        {canRemove && <button type="button" className="mobile-icon-button" aria-label={`移除 ${upload.identity.name} 本地引用`} onClick={() => remove(upload)}><SemanticIcon name="action.close" size={15} /></button>}
      </div>
    })}
    {visible.length > 0 && onSendBodyOnly && <button type="button" className="mobile-text-button" disabled={bodyOnlyDisabled} onClick={onSendBodyOnly}>本次仅发送正文</button>}
    {notice && <MobileNotice identity={[session?.agentSessionId,notice]} className="mobile-attachment-notice" role="status">{notice}</MobileNotice>}
  </div>
}
