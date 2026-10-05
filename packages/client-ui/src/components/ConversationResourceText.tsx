import type { AgentSessionHistoryContentPart } from '@agentmux/core'
import { readSessionHistoryTextResource } from '@agentmux/core/session-history-content'
import { sessionHistoryTextForReading } from '@agentmux/core/session-user-messages'
import { parseAgentMuxMessagePrefix } from '@agentmux/core/agent-message-render'
import { useEffect, useRef, useState } from 'react'
import { SemanticIcon } from '../theme/icons.js'
import { useClientUiPlatform } from '../platform.js'
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
  const platform = useClientUiPlatform(), pending = useRef<AbortController | null>(null), generation = useRef(0)
  const [content, setContent] = useState<AgentSessionHistoryContentPart | null>(null)
  const [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null), [copied, setCopied] = useState(false)
  useEffect(() => {
    setContent(null); setLoading(false); setError(null); setCopied(false)
    return () => { generation.current++; pending.current?.abort(); pending.current = null }
  }, [part.reference, partIndex, record.source.providerId, record.source.nativeSessionId, record.recordId, record.turnId, readResource])
  async function load() {
    pending.current?.abort()
    const controller = new AbortController(); pending.current = controller
    setLoading(true); setError(null)
    try {
      const complete = await readSessionHistoryTextResource(part, partIndex, record, readResource, controller.signal)
      if (!controller.signal.aborted) setContent(complete)
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Complete content could not be read. Retry.') }
    finally { if (!controller.signal.aborted) setLoading(false) }
  }
  async function copy() {
    if (!content) return
    const current = generation.current
    const text = content.kind === 'text' || content.kind === 'reasoning' ? content.text :
      content.kind === 'tool-call' ? content.input : content.kind === 'tool-result' ? content.output : content.reference
    try { const accepted = await platform.copyText(text, failure => {
      if (current === generation.current) setError(failure instanceof Error ? failure.message : 'Copy failed. Retry.')
    }); if (current === generation.current) { setCopied(accepted); if (!accepted) setError('Copy failed. Retry.') } }
    catch (failure) { if (current === generation.current) { setError(failure instanceof Error ? failure.message : 'Copy failed. Retry.'); setCopied(false) } }
  }
  const text = content?.kind === 'text' ? sessionHistoryTextForReading(content) : ''
  const prefix = inputMode && content?.kind === 'text' ? parseAgentMuxMessagePrefix(text) : null
  return <div className="conversation-resource-text">
    <div className="conversation-resource-text__controls">
      {!content ? <button type="button" onClick={() => { void load() }} disabled={loading}>
        {loading ? <SemanticIcon name="status.loading" size={13} aria-hidden="true" /> : <SemanticIcon name="file.text" size={13} aria-hidden="true" />}
        {loading ? 'Reading complete content…' : error ? 'Retry complete content' : 'Read complete content'}
        <span>{Math.ceil((part.content?.byteLength ?? 0) / 1024).toLocaleString()} KiB</span>
      </button> : <button type="button" onClick={() => { void copy() }}><SemanticIcon name="action.copy" size={13} aria-hidden="true" />{copied ? 'Complete content copied' : 'Copy complete content'}</button>}
      {content ? <button type="button" onClick={() => { pending.current?.abort(); setContent(null); setCopied(false) }}>Close content</button> : null}
    </div>
    {error ? <p className="conversation-resource-text__error" role="alert">{error}</p> : null}
    {content?.kind === 'text' ? <div className="log-turn__text">
      {prefix?.sourceLabel ? <span className="log-turn__declared-source">Message header: {prefix.sourceLabel}</span> : null}
      {prefix?.declaredContexts?.map((context, index) => <details key={index} className="log-turn__declared-context"><summary>Declared context</summary><pre>{context.raw}</pre></details>)}
      <AgentMarkdown content={prefix?.body ?? text} inputMode={inputMode} workspaceRoot={workspaceRoot} homeDir={homeDir}
        {...(openWorkspaceFile ? { openWorkspaceFile } : {})} {...(readPastedImage ? { readPastedImage } : {})} {...(openHttpLink ? { openHttpLink } : {})} />
    </div> :
      content?.kind === 'tool-call' || content?.kind === 'tool-result' ? <ConversationToolTrace part={content} workspaceRoot={workspaceRoot} /> :
      content?.kind === 'reasoning' ? <ConversationReasoningTrace part={content} workspaceRoot={workspaceRoot} homeDir={homeDir}
        {...(openWorkspaceFile ? { openWorkspaceFile } : {})} {...(readPastedImage ? { readPastedImage } : {})} {...(openHttpLink ? { openHttpLink } : {})} /> :
      content?.kind === 'resource' ? <div className="log-turn__resource"><span>{content.label ?? content.resourceType}</span><code>{content.reference}</code></div> : null}
  </div>
}
