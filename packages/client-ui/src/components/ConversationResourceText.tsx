import type { AgentSessionHistoryContentPart } from '@agentmux/core'
import { readSessionHistoryTextResource } from '@agentmux/core/session-history-content'
import { sessionHistoryTextForReading } from '@agentmux/core/session-user-messages'
import { parseAgentMuxMessagePrefix } from '@agentmux/core/agent-message-render'
import { useEffect, useMemo, useRef, useState } from 'react'
import { SemanticIcon } from '../theme/icons.js'
import { ContentCopyButton } from './ContentCopyButton.js'
import { AgentMarkdown, type LinkClickModifiers, type OpenWorkspaceFile } from './AgentMarkdown.js'
import type { ReadPastedImage } from './ConversationImage.js'
import { ConversationToolTrace } from './ConversationToolTrace.js'
import { ConversationReasoningTrace } from './ConversationReasoningTrace.js'
import type { ConversationHistoryResourceReader, ConversationNativeResourceRecord } from './ConversationResourceImage.js'

export function ConversationResourceText({ part, partIndex, record, readResource, workspaceRoot = '', homeDir = '', inputMode = false,
  openWorkspaceFile, readPastedImage, openHttpLink }: {
  part: Extract<AgentSessionHistoryContentPart, { kind: 'resource' }>; partIndex: number
  record: ConversationNativeResourceRecord; readResource: ConversationHistoryResourceReader
  workspaceRoot?: string; homeDir?: string; inputMode?: boolean
  openWorkspaceFile?: OpenWorkspaceFile; readPastedImage?: ReadPastedImage; openHttpLink?: (url: string, event: LinkClickModifiers) => void
}) {
  const pending = useRef<AbortController | null>(null), mounted = useRef(true)
  const owner = useMemo(() => ({}), [part.reference, part.content?.sha256, partIndex, record.source.providerId, record.source.nativeSessionId, record.recordId, record.turnId, readResource])
  const latestOwner = useRef(owner); latestOwner.current = owner
  const [loaded, setLoaded] = useState<{ owner: object; value: AgentSessionHistoryContentPart } | null>(null)
  const content = loaded?.owner === owner ? loaded.value : null
  const [reading, setReading] = useState<{ owner: object; loading: boolean; error: string | null } | null>(null)
  const loading = reading?.owner === owner && reading.loading
  const error = reading?.owner === owner ? reading.error : null
  useEffect(() => {
    mounted.current = true; setLoaded(null); setReading(null)
    return () => { mounted.current = false; pending.current?.abort(); pending.current = null }
  }, [owner])
  async function load() {
    if (!mounted.current || latestOwner.current !== owner) return
    pending.current?.abort()
    const controller = new AbortController(); pending.current = controller
    setReading({ owner, loading: true, error: null })
    try {
      const complete = await readSessionHistoryTextResource(part, partIndex, record, readResource, controller.signal)
      if (!controller.signal.aborted && latestOwner.current === owner) { setLoaded({ owner, value: complete }); setReading({ owner, loading: false, error: null }) }
    } catch (failure) { if (!controller.signal.aborted && latestOwner.current === owner) setReading({ owner, loading: false, error: failure instanceof Error ? failure.message : 'Complete content could not be read. Retry.' }) }
  }
  const copyableText = content?.kind === 'text' ? content.text : content?.kind === 'resource' ? content.reference : null
  const text = content?.kind === 'text' ? sessionHistoryTextForReading(content) : ''
  const prefix = inputMode && content?.kind === 'text' ? parseAgentMuxMessagePrefix(text) : null
  return <div className="conversation-resource-text">
    <div className="conversation-resource-text__controls">
      {!content ? <button type="button" onClick={() => { void load() }} disabled={loading}>
        {loading ? <SemanticIcon name="status.loading" size={13} aria-hidden="true" /> : <SemanticIcon name="file.text" size={13} aria-hidden="true" />}
        {loading ? 'Reading complete content…' : error ? 'Retry complete content' : 'Read complete content'}
        <span>{Math.ceil((part.content?.byteLength ?? 0) / 1024).toLocaleString()} KiB</span>
      </button> : copyableText ? <ContentCopyButton text={copyableText} identity={owner} label="Copy complete content" /> : null}
      {content ? <button type="button" onClick={() => { if (!mounted.current || latestOwner.current !== owner) return; pending.current?.abort(); setLoaded(null) }}>Close content</button> : null}
    </div>
    {error ? <p className="conversation-resource-text__error" role="alert">{error}</p> : null}
    {content?.kind === 'text' ? <div className="log-turn__text">
      {prefix?.sourceLabel ? <span className="log-turn__declared-source">Message header: {prefix.sourceLabel}</span> : null}
      {prefix?.declaredContexts?.map((context, index) => <details key={index} className="log-turn__declared-context"><summary>Declared context</summary><pre>{context.raw}</pre></details>)}
      <AgentMarkdown content={prefix?.body ?? text} inputMode={inputMode} workspaceRoot={workspaceRoot} homeDir={homeDir}
        {...(openWorkspaceFile ? { openWorkspaceFile } : {})} {...(readPastedImage ? { readPastedImage } : {})} {...(openHttpLink ? { openHttpLink } : {})} />
    </div> :
      content?.kind === 'tool-call' || content?.kind === 'tool-result' ? <ConversationToolTrace copyIdentity={owner} part={content} workspaceRoot={workspaceRoot} /> :
      content?.kind === 'reasoning' ? <ConversationReasoningTrace copyIdentity={owner} part={content} workspaceRoot={workspaceRoot} homeDir={homeDir}
        {...(openWorkspaceFile ? { openWorkspaceFile } : {})} {...(readPastedImage ? { readPastedImage } : {})} {...(openHttpLink ? { openHttpLink } : {})} /> :
      content?.kind === 'resource' ? <div className="log-turn__resource"><span>{content.label ?? content.resourceType}</span><code>{content.reference}</code></div> : null}
  </div>
}
