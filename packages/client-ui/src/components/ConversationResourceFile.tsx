import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSessionHistoryContentPart } from '@agentmux/core'
import { SemanticIcon } from '../theme/icons.js'
import { ContentCopyButton } from './ContentCopyButton.js'
import type { ConversationHistoryResourceReader, ConversationNativeResourceRecord } from './ConversationResourceImage.js'

/** Download only the exact original part. A decoded wrapper's inner URI is never a locator. */
export function ConversationResourceFile({ active = true, part, partIndex, record, readResource, label }: {
  active?: boolean
  part: Extract<AgentSessionHistoryContentPart, { kind: 'resource' }>
  partIndex: number
  record?: ConversationNativeResourceRecord | undefined
  readResource?: ConversationHistoryResourceReader | undefined
  /** Original file label from a decoded wrapper; presentation only. */
  label?: string | undefined
}) {
  const originalLabel = part.resourceType === 'file' ? part.label : label
  const owner = useMemo(() => ({}), [part.reference, part.content?.sha256, partIndex, record?.source.providerId,
    record?.source.nativeSessionId, record?.recordId, record?.turnId, readResource, originalLabel])
  const latest = useRef({ owner, active }); latest.current = { owner, active }
  const mounted = useRef(true), pending = useRef<AbortController | null>(null), objectUrl = useRef<string | null>(null)
  const revokeTask = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [state, setState] = useState<{ owner: object; loading?: boolean; error?: string; label?: string; metadata?: string } | null>(null)
  const current = state?.owner === owner ? state : null
  function releaseUrl() {
    if (revokeTask.current !== null) { clearTimeout(revokeTask.current); revokeTask.current = null }
    if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = null }
  }
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; pending.current?.abort(); pending.current = null; releaseUrl() }
  }, [owner])
  useEffect(() => {
    if (!active) { pending.current?.abort(); pending.current = null; releaseUrl(); setState(value => value?.loading ? { ...value, loading: false } : value) }
  }, [active])
  async function download() {
    if (!active || !mounted.current || latest.current.owner !== owner || !record || !readResource || pending.current) return
    const controller = new AbortController(); pending.current = controller
    setState({ owner, loading: true })
    const isCurrent = () => !controller.signal.aborted && mounted.current && latest.current.active && latest.current.owner === owner
    try {
      const request = { ...record, partIndex, expectedReference: part.reference, representation: 'file' as const }
      const receipt = await readResource(request)
      if (!isCurrent()) return
      if (receipt.source.providerId !== record.source.providerId || receipt.source.nativeSessionId !== record.source.nativeSessionId ||
        receipt.recordId !== record.recordId || receipt.turnId !== record.turnId || receipt.partIndex !== partIndex || receipt.reference !== part.reference) {
        throw new Error('File response belongs to another recorded resource.')
      }
      const { result } = receipt
      if (result.status !== 'file') throw new Error(result.status === 'unavailable' ? result.message : 'This response does not contain the recorded file.')
      const binary = atob(result.dataBase64), bytes = new Uint8Array(binary.length)
      if (binary.length !== result.byteLength || btoa(binary) !== result.dataBase64) throw new Error('The recorded file bytes are invalid.')
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
      releaseUrl()
      objectUrl.current = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }))
      const name = result.label ?? originalLabel
      const link = document.createElement('a')
      link.href = objectUrl.current
      link.download = name?.trim() ? name : 'Attachment (original name unavailable).bin'
      link.hidden = true; document.body.append(link)
      try { link.click() } finally {
        link.remove()
        // Let the browser consume its click before releasing our bytes. This is not a save receipt.
        revokeTask.current = setTimeout(releaseUrl, 0)
      }
      setState({ owner, ...(name === undefined ? {} : { label: name }), metadata: `${result.byteLength.toLocaleString()} bytes · ${result.mimeType}` })
    } catch (failure) {
      if (isCurrent()) { releaseUrl(); setState({ owner, error: failure instanceof Error ? failure.message : 'The recorded file could not be prepared. Retry.' }) }
    } finally { if (pending.current === controller) pending.current = null }
  }
  const name = current?.label ?? originalLabel
  return <div className="conversation-resource-file" aria-busy={Boolean(current?.loading)}>
    <SemanticIcon name="file.generic" size={18} className="conversation-resource-file__icon" aria-hidden="true" />
    <div className="conversation-resource-file__body">
      <span className="conversation-resource-file__name">{name?.trim() ? name : 'Attachment'}</span>
      <span className="conversation-resource-file__metadata">{[name?.trim() ? null : 'Original name unavailable', current?.metadata ?? (name?.trim() ? 'Recorded file' : null)].filter(Boolean).join(' · ')}</span>
      <details className="conversation-resource-file__reference"><summary>Reference</summary>
        <ContentCopyButton text={part.reference} identity={owner} label="Copy file reference" />
      </details>
    </div>
    {record && readResource ? <button type="button" className="conversation-resource-file__download" disabled={!active || current?.loading} onClick={() => { void download() }}>
      <SemanticIcon name={current?.loading ? 'status.loading' : 'action.download'} size={14} aria-hidden="true" />
      {current?.loading ? 'Preparing file…' : current?.error ? 'Retry download' : 'Download file'}
    </button> : null}
    {current?.error || !record || !readResource ? <p className="conversation-resource-file__error" role="alert">{current?.error ?? 'File reading is unavailable here. Its original reference is kept.'}</p> : null}
  </div>
}
