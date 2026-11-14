import { applyEdits, format } from 'jsonc-parser'
import { useMemo, useState, type ReactNode } from 'react'
import { useConversationToolLabels } from '../platform.js'
import { ContentCopyButton } from './ContentCopyButton.js'
import { Button } from './Button.js'
import { ConversationProgressiveBody, needsProgressiveText } from './ConversationProgressiveBody.js'
import { MarkdownCodeBlock } from './MarkdownCodeBlock.js'
import { SemanticIcon } from '../theme/icons.js'
import { ConversationRetainedDetails } from './ConversationRetainedDetails.js'

type PayloadProps = {
  text: string
  identity: object
  sourceIdentity: object
  callId?: string
  direction?: 'input' | 'output'
  copyLabel: string
  leading?: ReactNode
}

/** Only whitespace changes for reading. The host's exact payload remains the copy source. */
export function ConversationToolPayload(props: PayloadProps) {
  const reading = useMemo(() => () => [props.text], [props.text, props.sourceIdentity])
  return <ConversationProgressiveBody heavy={needsProgressiveText(props.text)} reading={reading}>
    <ConversationToolPayloadBody {...props} />
  </ConversationProgressiveBody>
}

function ConversationToolPayloadBody({ text, identity, sourceIdentity, callId, copyLabel, direction, leading }: PayloadProps) {
  const labels = useConversationToolLabels()
  const [view, setView] = useState({ text, sourceIdentity, formatted: false })
  if (view.text !== text || view.sourceIdentity !== sourceIdentity) setView({ text, sourceIdentity, formatted: false })
  const formatted = view.text === text && view.sourceIdentity === sourceIdentity && view.formatted
  const validJson = useMemo(() => {
    try {
      // Validate strict JSON without using the parsed values to reconstruct its tokens.
      JSON.parse(text)
      return true
    } catch { return false }
  }, [text])
  const readable = useMemo(() => formatted && validJson ? applyEdits(text, format(text, undefined, { tabSize: 2, insertSpaces: true, eol: '\n' })) : text, [text, formatted, validJson])
  return <>
    <div className="conversation-detail-actions conversation-tool-payload__actions">
      {leading || direction || callId ? <div className="conversation-tool-payload__identity">
        {leading}
        {direction ? <span className="conversation-tool-trace__kind">{labels[direction]}</span> : null}
        {callId ? <ConversationRetainedDetails className="conversation-tool-payload__call" summary={<span title={callId}>Call <code>{callId}</code><SemanticIcon name="navigation.disclosure" size={10} /></span>}>
          {() => <code className="conversation-tool-payload__call-original">{callId}</code>}
        </ConversationRetainedDetails> : null}
      </div> : null}
      <span className="conversation-tool-payload__tools">
      {validJson ? <Button className="conversation-tool-trace__format" aria-label={labels.formatJson} data-conversation-reading-action=""
        aria-pressed={formatted} title={labels.formatJsonHint}
        onClick={() => setView(previous => {
          const current = previous.text === text && previous.sourceIdentity === sourceIdentity
          return { text, sourceIdentity, formatted: !(current && previous.formatted) }
        })}>
        <SemanticIcon name="file.structured-data" size={12} />{labels.formatJson}
      </Button> : null}
      {text.length > 0 ? <ContentCopyButton text={text} identity={identity} label={copyLabel} /> : null}
      </span>
    </div>
    <div className="conversation-tool-payload__code"><MarkdownCodeBlock code={formatted ? readable : text} language={validJson ? 'json' : null} readOnly /></div>
  </>
}
