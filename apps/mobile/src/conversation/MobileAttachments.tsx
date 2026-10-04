import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { File, Image, LoaderCircle, RefreshCw, Upload, X, Check } from 'lucide-react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxAgentSession } from '@agentmux/core'
import { FILE_UPLOAD_MAX_BYTES, parseFileUploadParams, type FileUploadIdentity } from '@agentmux/core/files'
import { pickLocalAttachment, type LocalAttachment } from '../platform/native/device'
import { getDeviceWorkface } from '../recovery/device-workface'
import { fileUploadScopeMatches, uploadFromReceipt, type MobileFileUpload } from './attachments'
import { errorMessage } from './delivery'

export type MobileAttachmentControls = { choose(): Promise<void> }
type Props = {
  client: AgentMuxHostedClient | null; session: AgentMuxAgentSession | null; connected: boolean;
  promptOperationId: string | null; promptConfirmed: boolean;
  controls: Ref<MobileAttachmentControls>; insert(resolve: () => Promise<string | null>, original: MobileFileUpload): Promise<void>;
  pickFile?: () => Promise<LocalAttachment | null>
}
/** A local selection and one original Host receipt, beside the maintained shared Composer. */
export function MobileAttachments({ client, session, connected, promptOperationId, promptConfirmed, controls, insert, pickFile = pickLocalAttachment }: Props) {
  const [uploads, setUploads] = useState<MobileFileUpload[]>(() => (getDeviceWorkface().snapshot().record.fileUploads ?? []).map(item =>
    item.phase === 'sending' ? { ...item, phase: 'unknown', issue: '原上传回执尚未确认；核对同一操作，不会自动重传。' } : item))
  const [notice, setNotice] = useState<string | null>(null), [choosing, setChoosing] = useState(false)
  const bytes = useRef(new Map<string, LocalAttachment>())
  const busy = useRef(new Set<string>())
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
  const retain = (upload: MobileFileUpload, required = false) => {
    if (upload.phase !== 'selected') {
      try { getDeviceWorkface().retainFileUpload(upload) }
      catch (error) {
        if (required) throw new Error(`原上传操作尚未保全；本次没有上传，附件和草稿保留。${errorMessage(error)}`)
        if (mounted.current) setNotice(`附件回执仅在本次运行中保留：${errorMessage(error)}`)
      }
    }
    if (mounted.current) setUploads(items => items.some(item => item.identity.operationId === upload.identity.operationId)
      ? items.map(item => item.identity.operationId === upload.identity.operationId ? upload : item) : [...items, upload])
  }
  const remove = (upload: MobileFileUpload) => {
    try {
      getDeviceWorkface().removeFileUpload(upload.identity.operationId)
      bytes.current.delete(upload.identity.operationId)
      setUploads(items => items.filter(item => item.identity.operationId !== upload.identity.operationId))
    } catch (error) { setNotice(errorMessage(error)) }
  }
  useEffect(() => {
    if (!promptConfirmed || !session) return
    for (const upload of uploads) if (upload.phase === 'inserted' && upload.identity.agentSessionId === session.agentSessionId) remove(upload)
  }, [promptConfirmed, promptOperationId])

  async function choose(): Promise<void> {
    if (choosing) return
    const originalClient = current.current.client, originalSession = current.current.session, originalScope = scope()
    if (!originalClient || !originalSession || !originalScope.runtimeId) { setNotice('尚未确认原会话与 Mac；这次附件没有上传。原消息仍可编辑。'); return }
    setChoosing(true); setNotice(null)
    try {
      const file = await pickFile()
      if (!file) return
      if ([...bytes.current.values()].reduce((total, item) => total + item.size, 0) + file.size > FILE_UPLOAD_MAX_BYTES * 4) {
        throw new Error('待上传附件已占用这台设备的本次选择预算；先上传或移除一个附件，再选择新文件。原草稿保留。')
      }
      const identity: FileUploadIdentity = { hostId: originalSession.hostId, agentSessionId: originalSession.agentSessionId,
        expectedRun: { runId: originalSession.run.runId }, operationId: file.id, name: file.name,
        mimeType: file.mimeType, byteLength: file.size, revision: file.revision }
      parseFileUploadParams({ ...identity, dataBase64: file.dataBase64 })
      bytes.current.set(file.id, file)
      retain({ runtimeId: originalScope.runtimeId, identity, phase: 'selected' })
    } catch (error) { if (mounted.current) setNotice(errorMessage(error)) }
    finally { if (mounted.current) setChoosing(false) }
  }
  useImperativeHandle(controls, () => ({ choose }))

  async function add(upload: MobileFileUpload): Promise<void> {
    if (!upload.path || !fileUploadScopeMatches(upload, scope())) throw new Error('原附件属于另一 Mac、Session 或 Run；回执已保留，当前草稿未改变。')
    await insert(async () => upload.path!, upload)
    retain({ ...upload, phase: 'inserted' })
    bytes.current.delete(upload.identity.operationId)
  }
  async function act(upload: MobileFileUpload, inspectOnly: boolean): Promise<void> {
    const id = upload.identity.operationId
    if (busy.current.has(id)) return
    const originalClient = current.current.client, originalScope = scope(), originalPrompt = current.current.promptOperationId
    busy.current.add(id)
    let requested = false, confirmed: MobileFileUpload | null = null
    try {
      if (!current.current.connected || !originalClient?.forwardRpc) throw new Error('原 Mac 当前未连接；附件和草稿保留，可连接后再试。')
      if (upload.runtimeId !== originalScope.runtimeId || upload.identity.hostId !== originalScope.hostId || upload.identity.agentSessionId !== originalScope.sessionId) throw new Error('当前连接不属于原附件的 Mac 与 Session；本次未上传或重传。')
      if (upload.phase === 'uploaded') { await add(upload); return }
      if (!inspectOnly && !fileUploadScopeMatches(upload, originalScope)) throw new Error('原 Run 已变化；本次未上传，原文件仍保留。')
      const file = bytes.current.get(id)
      if (!inspectOnly && !file) throw new Error('本次设备选择已结束；原上传记录保留，可先核对原操作。')
      retain({ ...upload, phase: 'sending' }, true)
      requested = true
      let inserted = false
      const request = async () => {
        const response = inspectOnly ? await originalClient.forwardRpc!('file.upload.inspect', upload.identity)
          : await originalClient.forwardRpc!('file.upload', { ...upload.identity, dataBase64: file!.dataBase64 })
        confirmed = uploadFromReceipt(upload, response); retain(confirmed)
        return confirmed
      }
      // Capture the maintained editor's bookmark before the asynchronous request. Its
      // transaction mapping keeps later typing without copying or replacing the draft.
      if (fileUploadScopeMatches(upload, originalScope)) {
        await insert(async () => {
          const original = await request()
          if (original.phase !== 'uploaded' || !fileUploadScopeMatches(original, scope()) || originalPrompt !== current.current.promptOperationId) return null
          inserted = true; return original.path!
        }, upload)
      } else await request()
      if (inserted && confirmed) {
        retain({ ...(confirmed as MobileFileUpload), phase: 'inserted' }); bytes.current.delete(id)
      }
    } catch (error) {
      const retained = confirmed as MobileFileUpload | null
      retain(retained?.phase === 'uploaded' ? { ...retained, issue: errorMessage(error) }
        : { ...upload, phase: requested ? 'unknown' : upload.phase, issue: errorMessage(error) })
    } finally { busy.current.delete(id) }
  }
  const visible = uploads.filter(upload => upload.identity.agentSessionId === session?.agentSessionId && upload.phase !== 'inserted')
  return <div className="mobile-attachments" aria-live="polite">
    {choosing && <p className="mobile-attachment-notice"><LoaderCircle size={13} className="mobile-attachment-spin" />读取所选附件…</p>}
    {visible.map(upload => {
      const image = upload.identity.mimeType.startsWith('image/'), file = bytes.current.get(upload.identity.operationId)
      const busy = upload.phase === 'sending', unknown = upload.phase === 'unknown', ready = upload.phase === 'uploaded'
      const canRemove = !busy && !unknown
      return <div className="mobile-attachment" data-phase={upload.phase} key={upload.identity.operationId}>
        {image && file ? <img className="mobile-attachment-preview" alt="" src={`data:${file.mimeType};base64,${file.dataBase64}`} />
          : <span className="mobile-attachment-icon">{image ? <Image size={19} /> : <File size={19} />}</span>}
        <div className="mobile-attachment-copy"><strong title={upload.identity.name}>{upload.identity.name}</strong>
          <small>{upload.identity.byteLength < 1024 ? `${upload.identity.byteLength} B` : `${(upload.identity.byteLength / 1024).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} KB`} · {busy ? '正在核对原 Host…' : unknown ? '回执待核对' : ready ? '已在原 Mac' : '仅在这台设备'}</small>
          {upload.issue && <p role="status">{upload.issue}</p>}</div>
        {!busy && <button type="button" className="mobile-icon-button" aria-label={ready ? `将 ${upload.identity.name} 加入消息` : unknown ? `核对 ${upload.identity.name} 原上传` : `上传并加入 ${upload.identity.name}`}
          title={ready ? '加入消息' : unknown ? '核对原上传' : '上传并加入消息'} onClick={() => { void act(upload, unknown) }}>
          {ready ? <Check size={17} /> : unknown ? <RefreshCw size={17} /> : <Upload size={17} />}</button>}
        {busy && <LoaderCircle size={17} className="mobile-attachment-spin" aria-label="上传回执待确认" />}
        {canRemove && <button type="button" className="mobile-icon-button" aria-label={`移除 ${upload.identity.name} 本地引用`} onClick={() => remove(upload)}><X size={15} /></button>}
      </div>
    })}
    {notice && <p className="mobile-attachment-notice" role="status">{notice}</p>}
  </div>
}
