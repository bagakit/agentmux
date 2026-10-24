import { applyEdits, format } from 'jsonc-parser'
import { useMemo, useState } from 'react'
import { ContentCopyButton } from './ContentCopyButton.js'
import { ConversationProgressiveBody, needsProgressiveText } from './ConversationProgressiveBody.js'

type PayloadProps = {
  text: string
  identity: object
  sourceIdentity: object
  callId?: string
  copyLabel: string
}

/** Only whitespace changes for reading. The host's exact payload remains the copy source. */
export function ConversationToolPayload(props: PayloadProps) {
  const reading = useMemo(() => () => [props.text], [props.text, props.sourceIdentity])
  return <ConversationProgressiveBody heavy={needsProgressiveText(props.text)} reading={reading}>
    <ConversationToolPayloadBody {...props} />
  </ConversationProgressiveBody>
}

function ConversationToolPayloadBody({ text, identity, sourceIdentity, callId, copyLabel }: PayloadProps) {
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
    <div className="conversation-detail-actions">
      {callId ? <span className="conversation-tool-trace__identity">Call <code>{callId}</code></span> : null}
      {validJson ? <button type="button" className="conversation-tool-trace__format" aria-label="Format JSON"
        aria-pressed={formatted} title="Format JSON for reading; copying keeps the original text"
        onClick={() => setView({ text, sourceIdentity, formatted: !formatted })}>Format JSON</button> : null}
      {text.length > 0 ? <ContentCopyButton text={text} identity={identity} label={copyLabel} /> : null}
    </div>
    <pre>{formatted ? readable : text}</pre>
  </>
}
