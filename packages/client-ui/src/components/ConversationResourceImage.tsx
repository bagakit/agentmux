import { useCallback } from 'react'
import type { AgentSessionHistoryContentPart, AgentSessionHistoryResourceRequest } from '@agentmux/core'
import type { SessionHistoryResourceReader } from '@agentmux/core/session-history-content'
import { ConversationImage } from './ConversationImage.js'

export type ConversationHistoryResourceReader = SessionHistoryResourceReader
export type ConversationNativeResourceRecord = Pick<AgentSessionHistoryResourceRequest, 'source' | 'recordId' | 'turnId'>

/** The existing image face reads an exact original resource, not a path supplied by the viewer. */
export function ConversationResourceImage({ part, partIndex, record, readResource }: {
  part: Extract<AgentSessionHistoryContentPart, { kind: 'resource' }>
  partIndex: number
  record: ConversationNativeResourceRecord
  readResource: ConversationHistoryResourceReader
}) {
  const { source, recordId, turnId } = record
  const reference = part.reference
  const readImage = useCallback(async () => {
    const resource = await readResource({ source: { providerId: source.providerId, nativeSessionId: source.nativeSessionId },
      recordId, ...(turnId === undefined ? {} : { turnId }), partIndex, expectedReference: reference })
    if (resource.source.providerId !== source.providerId || resource.source.nativeSessionId !== source.nativeSessionId ||
      resource.recordId !== recordId || resource.turnId !== turnId || resource.partIndex !== partIndex || resource.reference !== reference) {
      throw new Error('Image response belongs to another recorded resource.')
    }
    if (resource.result.status !== 'read') throw new Error(resource.result.status === 'unavailable'
      ? resource.result.message : 'This image response contains text instead of recorded image bytes.')
    return { dataUrl: `data:${resource.result.mimeType};base64,${resource.result.dataBase64}` }
  }, [readResource, source.providerId, source.nativeSessionId, recordId, turnId, partIndex, reference])
  return <div className="log-turn__resource log-turn__resource--image">
    {part.label ? <span>{part.label}</span> : null}
    <ConversationImage text={reference.startsWith('data:') ? 'Recorded inline image' : reference} path={reference} label={part.label ?? 'Recorded image'} readImage={readImage} />
  </div>
}
