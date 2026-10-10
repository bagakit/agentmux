import { useCallback, useMemo } from 'react'
import type { AgentSessionUserMessage } from '@agentmux/core'
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'
import { ConversationImage } from '@agentmux/client-ui/components/ConversationImage'
import { ConversationResourceImage, type ConversationHistoryResourceReader } from '@agentmux/client-ui/components/ConversationResourceImage'
import { parseAgentMarkdown } from '@agentmux/client-ui/agent-markdown'
import { markdownImageReferences } from '@agentmux/client-ui/conversation-image-references'
import type { AgentSessionControl } from '../../../shared/contracts'
import { api } from '../lib/api'

type Reading = { text: string; truncated: boolean }
type ImagePart = Extract<AgentSessionUserMessage['contentParts'][number], { kind: 'resource' }>
type NativeSource = Extract<AgentSessionUserMessage['source'], { kind: 'native' }>
type MediaProps = { active: boolean; control?: AgentSessionControl | undefined; sourceKey?: string | undefined; input?: AgentSessionUserMessage | undefined }
const readPastedImage = (path: string) => api.ui.readPastedImage(path)

/** The original record and canonical control own native bytes; display names never select a file. */
function NativeReadingImage({ active, control, sourceKey, source, turnId, part, partIndex }: {
  active: boolean; control: AgentSessionControl; sourceKey: string | undefined; source: NativeSource; turnId: string | undefined; part: ImagePart; partIndex: number
}) {
  const readResource = useCallback<ConversationHistoryResourceReader>(input => api.sessions.historyResource({ hostId: control.hostId, agentSessionId: control.agentSessionId }, input),
    [control.hostId, control.agentSessionId, control.run.runId, sourceKey])
  return <ConversationResourceImage active={active} interactive={false} part={part} partIndex={partIndex}
    record={{ source: { providerId: source.providerId, nativeSessionId: source.nativeSessionId }, recordId: source.recordId, ...(turnId === undefined ? {} : { turnId }) }} readResource={readResource} />
}

function RecordedImage({ active, control, sourceKey, input, part, partIndex }: MediaProps & { input: AgentSessionUserMessage; part: ImagePart; partIndex: number }) {
  return control && input.source.kind === 'native'
    ? <NativeReadingImage active={active} control={control} sourceKey={sourceKey} source={input.source} turnId={input.turnId} part={part} partIndex={partIndex} />
    : <span className="focus-context-hover__coverage" title={part.reference}>{part.label ?? 'Recorded image'} · Original image source unavailable</span>
}

/** Original text remains complete; the explicit image ports do not enable navigation or execution. */
export function AgentReadingBody({ reading, active, control, sourceKey, input }: MediaProps & { reading: Reading }) {
  const literal = reading.truncated || reading.text.length > 8000
  const literalImages = useMemo(() => literal ? markdownImageReferences(reading.text, undefined, false, () => false) : [], [literal, reading.text])
  return <div className="focus-context-hover__prose" data-reading-format={reading.truncated ? 'excerpt' : literal ? 'plain' : 'markdown'}>
    {literal ? <><p>{reading.text}</p>{literalImages.map(reference => <ConversationImage key={reference.path} active={active} interactive={false}
      text={reference.text} path={reference.path} readImage={readPastedImage} />)}</>
      : <AgentMarkdown content={reading.text} readOnly readOnlyImages readPastedImage={readPastedImage} visible={active} />}
    {input?.contentParts.map((part, partIndex) => part.kind === 'resource' && part.resourceType === 'image'
      ? <RecordedImage key={partIndex} active={active} control={control} sourceKey={sourceKey} input={input} part={part} partIndex={partIndex} /> : null)}
  </div>
}

/** A single original thumbnail supports recall without making every input a full rich body. */
export function AgentReadingThumbnail({ reading, active, control, sourceKey, input }: MediaProps & { reading: Reading }) {
  const first = useMemo(() => markdownImageReferences(reading.text, reading.text.length <= 8000 ? parseAgentMarkdown(reading.text) : undefined, false, () => false, { readOnlyImages: true })[0], [reading.text])
  const index = input?.contentParts.findIndex(part => part.kind === 'resource' && part.resourceType === 'image') ?? -1
  const part = input?.contentParts[index]
  if (input && part?.kind === 'resource') return <span className="agent-input-recall__thumbnail"><RecordedImage active={active} control={control} sourceKey={sourceKey} input={input} part={part} partIndex={index} /></span>
  return first ? <span className="agent-input-recall__thumbnail"><ConversationImage active={active} interactive={false}
    text={first.text} path={first.path} readImage={readPastedImage} /></span> : null
}
