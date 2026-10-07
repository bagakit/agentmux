import { applyEdits, format } from 'jsonc-parser'
import { useMemo, useState } from 'react'
import { ContentCopyButton } from './ContentCopyButton.js'

/** Only whitespace changes for reading. The host's exact payload remains the copy source. */
export function ConversationToolPayload({ text, identity, sourceIdentity, callId, copyLabel }: {
  text: string
  identity: object
  sourceIdentity: object
  callId?: string
  copyLabel: string
}) {
  const [view, setView] = useState({ text, sourceIdentity, formatted: false })
  if (view.text !== text || view.sourceIdentity !== sourceIdentity) setView({ text, sourceIdentity, formatted: false })
  const formatted = view.text === text && view.sourceIdentity === sourceIdentity && view.formatted
  const readable = useMemo(() => {
    try {
      // Validate strict JSON without using the parsed values to reconstruct its tokens.
      JSON.parse(text)
      return applyEdits(text, format(text, undefined, { tabSize: 2, insertSpaces: true, eol: '\n' }))
    } catch { return null }
  }, [text])
  return <>
    <div className="conversation-detail-actions">
      {callId ? <span className="conversation-tool-trace__identity">Call <code>{callId}</code></span> : null}
      {readable !== null ? <button type="button" className="conversation-tool-trace__format" aria-label="Format JSON"
        aria-pressed={formatted} title="Format JSON for reading; copying keeps the original text"
        onClick={() => setView({ text, sourceIdentity, formatted: !formatted })}>Format JSON</button> : null}
      {text.length > 0 ? <ContentCopyButton text={text} identity={identity} label={copyLabel} /> : null}
    </div>
    <pre>{formatted ? readable : text}</pre>
  </>
}
