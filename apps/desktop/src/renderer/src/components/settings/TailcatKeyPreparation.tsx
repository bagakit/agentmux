import { useEffect, useRef, useState } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import type { TailcatKeyPreparation as PreparedKey, TailcatKeyRole } from '@agentmux/core'
import { api } from '../../lib/api'
import { copyTextToClipboard } from '../../lib/clipboard-copy'

/** The original Host owns preparation. This component owns only its explicit action and receipt. */
export function TailcatKeyPreparation({ role, keyFile, onPrepared }: {
  role: TailcatKeyRole
  keyFile: string
  onPrepared: (result: PreparedKey, mayFocus: boolean) => boolean
}) {
  const [state, setState] = useState<{ busy?: boolean; result?: PreparedKey; error?: string; keptDraft?: boolean }>({})
  const [copied, setCopied] = useState(false), [copyError, setCopyError] = useState<string>()
  const live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const prepare = async () => {
    const apply = onPrepared, originalFocus = document.activeElement
    setState({ busy: true }); setCopied(false); setCopyError(undefined)
    try {
      const result = await api.hosts.prepareTailcatKey({ role, ...(keyFile ? { key: keyFile } : {}) })
      if (!live.current) return
      const applied = apply(result, document.activeElement === originalFocus || document.activeElement === document.body)
      setState({ result, keptDraft: !applied })
    } catch (error) {
      if (live.current) setState({ error: error instanceof Error ? error.message : 'Tailcat key preparation could not be confirmed. Your connection draft is retained.' })
    }
  }
  const result = state.result
  const code = result?.role === 'client' && result.key === keyFile ? result.publicKey : undefined
  return <div className="host-tailcat-preparation" data-tailcat-prepare={role}>
    <div className="host-tailcat-preparation__action">
      <button type="button" className="small-button" disabled={state.busy === true} onClick={() => void prepare()}>
        {state.busy ? 'Preparing key…' : role === 'server' ? 'Prepare this Mac to receive' : 'Use this Mac’s key'}
      </button>
      <span>{role === 'server' ? 'Then paste the other Mac’s connection code and save.' : 'Share your public connection code with the receiving Mac.'}</span>
    </div>
    {state.error ? <p role="alert" className="host-check-detail">{state.error}</p> : result ? <p role="status" className="host-tailcat-preparation__receipt">
      {result.created ? 'Created' : 'Reusing'} key <code>{result.key}</code>.{state.keptDraft ? ' Your later draft edits were kept.' : role === 'server' ? ' Add the connection code below, then Save hosts.' : ' Copy this code to the other Mac’s allowed clients.'}
    </p> : null}
    {code ? <div className="host-tailcat-address"><label><span>This Mac’s connection code <small>public key</small></span>
      <TextInput aria-label="This Mac’s connection code" value={code} readOnly spellCheck={false} /></label>
      <button type="button" className="small-button" onClick={() => { setCopyError(undefined)
        void copyTextToClipboard(code, () => setCopyError('Copy failed. Select the public code and copy it again.')).then(ok => { if (live.current) setCopied(ok) })
      }}>{copied ? 'Copied code' : 'Copy code'}</button></div> : null}
    {copyError ? <p role="alert" className="host-check-detail">{copyError}</p> : null}
  </div>
}
