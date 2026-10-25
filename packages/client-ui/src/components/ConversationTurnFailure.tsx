import type { AgentFailure } from '@agentmux/core'
import { formatAmuxObjectLink } from '@agentmux/core/sharing'
import type { ReactNode } from 'react'
import type { ConversationRecord } from '../lib/conversation-records.js'
import { conversationMessageSourceKey } from '../lib/conversation-message-location.js'
import { SemanticIcon } from '../theme/icons.js'
import { ConversationRetainedDetails } from './ConversationRetainedDetails.js'
import { useObjectLinkRenderer } from '../platform.js'

/** Historical outcome only. Recovery prose grants no retry or model-change authority. */
export function ConversationTurnFailure({ failure, record, children }: {
  failure: AgentFailure; record: ConversationRecord; children(): ReactNode
}) {
  const source = record.source
  const renderObjectLink = useObjectLinkRenderer()
  const target = { kind: 'agent' as const, agentSessionId: record.agentSessionId }, uri = formatAmuxObjectLink(target)
  return <section className="conversation-turn-failure" aria-label="请求失败" data-turn-failure-record-id={record.rawId}
    data-conversation-layout-key={record.presentationKey ?? record.id} data-message-source-key={conversationMessageSourceKey(record.agentSessionId, source)}>
    <div className="conversation-turn-failure__heading"><SemanticIcon name="status.warning" size={15} /><strong>请求失败</strong>
      <span>{source.kind === 'native' ? source.providerId : '捕获记录'}</span></div>
    <p className="conversation-turn-failure__cause">{failure.message}</p>
    <p className="conversation-turn-failure__recovery">{failure.recovery}</p>
    <div className="conversation-turn-failure__scope"><span>原轮 <code title={failure.nativeTurnId}>{failure.nativeTurnId}</code></span>
      {renderObjectLink?.({ uri, target, label: '原 Agent' }) ?? <code>{uri}</code>}</div>
    <ConversationRetainedDetails className="conversation-turn-failure__details" summary="错误详情">
      {() => <>
        <dl>
          <div><dt>原生错误码</dt><dd><code>{failure.nativeCode ?? '未记录'}</code></dd></div>
          <div><dt>AgentMux 分类</dt><dd><code>{failure.code}</code></dd></div>
          {failure.httpStatusCode === undefined ? null : <div><dt>HTTP 状态</dt><dd>{failure.httpStatusCode}</dd></div>}
          <div><dt>原生轮次</dt><dd><code>{failure.nativeTurnId}</code></dd></div>
          <div><dt>来源 Host</dt><dd><code>{record.sourceHostId ?? '未确认'}</code></dd></div>
          <div><dt>Agent Session</dt><dd><code>{record.agentSessionId}</code></dd></div>
          {source.kind === 'native' ? <div><dt>原生会话</dt><dd><code>{source.nativeSessionId}</code></dd></div> : null}
          <div><dt>来源记录</dt><dd><code>{record.rawId}</code></dd></div>
        </dl>
        <ConversationRetainedDetails className="conversation-turn-failure__original" summary="原始记录">{children}</ConversationRetainedDetails>
      </>}
    </ConversationRetainedDetails>
  </section>
}
