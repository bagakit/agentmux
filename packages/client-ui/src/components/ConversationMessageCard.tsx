import { useEffect, useId, useState, type ReactNode } from 'react'
import type { AgentSessionHistoryCollaboration } from '@agentmux/core'
import { SemanticIcon } from '../theme/icons.js'

type MessageCardSlots = {
  avatar: ReactNode
  badges: ReactNode
  time: ReactNode
  actions: ReactNode
  feedback?: ReactNode
  details: ReactNode
  metadata: ReactNode
}
type MessageCardBody = { renderBody(contentId?: string): ReactNode }

/** Card chrome does not own record identity, body readers, copying or source details. */
function MessageCardFrame({ avatar, heading, badges, time, actions, feedback, details, metadata, children }: MessageCardSlots & { heading: ReactNode; children: ReactNode }) {
  return <>
    <span className="log-turn__node" aria-hidden="true">{avatar}</span>
    <div className="log-turn__head">
      <div className="log-turn__identity"><div className="log-turn__title">{heading}{badges}</div>{time}</div>
      {actions}{details}{feedback}
    </div>
    {metadata}{children}
  </>
}

export function ConversationSpeechCard({ sender, renderBody, ...slots }: MessageCardSlots & MessageCardBody & { sender: ReactNode }) {
  return <MessageCardFrame {...slots} heading={<span className="log-turn__sender">{sender}</span>}>{renderBody()}</MessageCardFrame>
}

/** The owning process step supplies the heading; body actions and provenance keep their original owners. */
export function ConversationProcessCard({ badges, time, actions, feedback, details, metadata, renderBody }: MessageCardSlots & MessageCardBody) {
  return <>
    <div className="log-turn__head"><div className="log-turn__identity">{badges}{time}</div>{actions}{details}{feedback}</div>
    {metadata}{renderBody()}
  </>
}

export function SystemRecordCard({ identity, title, summary, hasContent, renderBody, ...slots }: MessageCardSlots & MessageCardBody & {
  identity: object; title: string; summary: string | undefined; hasContent: boolean
}) {
  const [expanded, setExpanded] = useState<{ identity: object; open: boolean; presented: boolean } | null>(null)
  const open = expanded?.identity === identity && expanded.open
  useEffect(() => { setExpanded(null) }, [identity])
  const contentId = useId()
  return <MessageCardFrame {...slots} heading={<button type="button" className="log-turn__system-toggle"
    aria-label={open ? '收起系统记录' : '展开系统记录'} aria-expanded={open} aria-controls={hasContent ? contentId : undefined}
    disabled={!hasContent} onClick={() => setExpanded({ identity, open: !open, presented: true })}>
    {hasContent ? <SemanticIcon name="navigation.disclosure" size={12} aria-hidden="true" /> : null}
    <span className="log-turn__system-title">{title}</span>
    {summary ? <span className="log-turn__system-summary">{summary}</span> : null}
  </button>}><div id={contentId} className="log-turn__system-body" hidden={!open} inert={!open}>{open || expanded?.identity === identity && expanded.presented ? renderBody() : null}</div></MessageCardFrame>
}

export function SubagentReportCard({ identity, collaboration, located, preview, hasResources, emptyText, renderBody, ...slots }: MessageCardSlots & MessageCardBody & {
  identity: object
  collaboration: Extract<AgentSessionHistoryCollaboration, { kind: 'message' }>
  located: boolean
  preview: string
  hasResources: boolean
  emptyText: boolean
}) {
  const [disclosure, setDisclosure] = useState({ identity, open: located, presented: located })
  const current = disclosure.identity === identity ? disclosure : { identity, open: located, presented: located }
  const open = current.open
  const contentId = useId()
  useEffect(() => { setDisclosure({ identity, open: located, presented: located }) }, [identity])
  useEffect(() => { if (located) setDisclosure({ identity, open: true, presented: true }) }, [located])
  function show(open: boolean) { setDisclosure({ identity, open, presented: true }) }
  return <>
    <div className="log-turn__head log-turn__collaboration-head">
      <button type="button" className="log-turn__collaboration-toggle"
        aria-label={`${open ? '收起' : '展开'} Subagent ${collaboration.sender ?? '路径未记录'}`}
        aria-expanded={open} aria-controls={contentId} onClick={() => show(!open)}>
        <span className="log-turn__collaboration-node"><SemanticIcon name="navigation.disclosure" className="log-turn__collaboration-chevron" size={12} aria-hidden="true" /></span>
        <span className="log-turn__collaboration-label"><SemanticIcon name="object.subagent" size={12} aria-hidden="true" />Subagent</span>
        {slots.time}
        <code className="log-turn__collaboration-path" title={collaboration.sender}>{collaboration.sender ?? '路径未记录'}</code>
        {!open && (preview || hasResources) ? <span className="log-turn__collaboration-preview">
          {preview || '包含按需读取的内容 · 展开查看'}
        </span> : null}
        {slots.badges}
      </button>
      {slots.actions}{slots.details}{slots.feedback}
    </div>
    {slots.metadata}
    <div id={contentId} className="log-turn__collaboration-content" hidden={!open} inert={!open}>
      {current.presented || open ? <>
        <dl className="log-turn__collaboration-participants">
          <div><dt>发送者</dt><dd><code>{collaboration.sender ?? '路径未记录'}</code></dd></div>
          {collaboration.recipient ? <div><dt>接收者</dt><dd><code>{collaboration.recipient}</code></dd></div> : null}
        </dl>
        {emptyText ? <p className="log-turn__collaboration-empty">原生记录未提供可读正文，可在消息详情中查看原始内容。</p> : null}
        {renderBody()}
      </> : null}
    </div>
  </>
}
