import type { ChannelTranscriptQuote } from '@agentmux/core'
import { useState } from 'react'
import { ConversationProtocolCard } from './ConversationAmuxProtocol.js'

/** Reading only. Quoted actors and content never acquire actions or sender authority. */
export function ConversationChannelQuote({ quote, raw }: { quote: ChannelTranscriptQuote; raw: string }) {
  const [open, setOpen] = useState(false)
  return <ConversationProtocolCard title="Quoted channel history" tag="amux:quote" kind="channel-quote" raw={raw}>
    <p className="conversation-protocol__description">Earlier messages for context. The current request follows separately.</p>
    <details onToggle={event => setOpen(event.currentTarget.open)} data-channel-quote={quote.coverage}>
      <summary>{quote.records.length} earlier messages · {quote.coverage === 'complete' ? 'Observed interval complete' : 'History has gaps'}</summary>
      {open ? <>
        <dl className="conversation-protocol__attributes">
          <div><dt>Conversation</dt><dd>{quote.application.domain} · {quote.externalConversationId}</dd></div>
          <div><dt>From</dt><dd>{quote.range.from ? `${quote.range.from.inclusive ? 'Including' : 'After'} ${quote.range.from.messageId}` : 'Original boundary unknown'}</dd></div>
          <div><dt>Before</dt><dd>{quote.range.throughMessageId}</dd></div>
          <div><dt>Baseline</dt><dd>{quote.range.origin === 'first-observed' ? 'First observed position; earlier history is outside this interval' : 'Original admitted input'}</dd></div>
        </dl>
        {quote.gaps.length ? <p role="status">History gaps: {quote.gaps.map(gap => gap.reason).join(', ')}. Missing content remains unknown.</p> : null}
        <ol className="conversation-channel-quote__records">{quote.records.map(record => <li key={record.messageId}>
          <p>{record.author.kind === 'unknown' ? 'Unknown author' : `${record.author.kind === 'bot' ? 'Bot · ' : ''}${record.author.profile?.profile?.name ?? record.author.actor.userId}`}
            {' · '}<code>{record.messageId}</code>{' · '}{record.contentType}</p>
          <pre className="conversation-protocol__body">{record.content}</pre>
          {record.replyToMessageId ? <p>Reply to <code>{record.replyToMessageId}</code></p> : null}
          {record.threadId ? <p>Thread <code>{record.threadId}</code></p> : null}
          {record.resources?.length ? <ul>{record.resources.map(resource => <li key={resource.resourceId}>
            {resource.kind}{' · '}{resource.name ?? resource.resourceId}{resource.sizeBytes === undefined ? null : ` · ${resource.sizeBytes} bytes`}
            <details data-quote-resource={resource.resourceId}><summary>Resource details</summary><pre className="conversation-protocol__body">{JSON.stringify(resource)}</pre></details>
          </li>)}</ul> : null}
        </li>)}</ol>
      </> : null}
    </details>
  </ConversationProtocolCard>
}
