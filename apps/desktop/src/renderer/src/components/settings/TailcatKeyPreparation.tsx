import { useEffect, useRef, useState } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import type { TailcatKeyPreparation as PreparedKey, TailcatKeyRole } from '@agentmux/core'
import { api } from '../../lib/api'
import { copyTextToClipboard } from '../../lib/clipboard-copy'
import type { HostConfig } from '../../../../shared/contracts'
import { TailcatSetupHelp } from './TailcatSetupHelp'
import { tailcatPreparationFailure } from '../../lib/tailcat-preparation-failure'

/** The original Host owns preparation. This component owns only its explicit action and receipt. */
export function TailcatKeyPreparation({ host, role, keyFile, onPrepared }: {
  host: HostConfig
  role: TailcatKeyRole
  keyFile: string
  onPrepared: (result: PreparedKey, mayFocus: boolean) => boolean
}) {
  const [state, setState] = useState<{ busy?: boolean; result?: PreparedKey; error?: ReturnType<typeof tailcatPreparationFailure>; keptDraft?: boolean }>({})
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
      if (live.current) setState({ error: tailcatPreparationFailure(error) })
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
    {state.error ? <div role="alert" className="host-check-detail"><strong>{state.error.title}</strong><p>{state.error.next}</p>
      <p>Your connection draft is kept.{state.error.code ? <> <code>{state.error.code}</code></> : null}</p></div> : result ? <p role="status" className="host-tailcat-preparation__receipt">
      {result.created ? 'Created' : 'Reusing'} key <code>{result.key}</code>.{state.keptDraft ? ' Your later draft edits were kept.' : role === 'server' ? ' Add the connection code below, then Save hosts.' : ' Copy this code to the other Mac’s allowed clients.'}
    </p> : null}
    {code ? <div className="host-tailcat-address"><label><span>This Mac’s connection code <small>public key</small></span>
      <TextInput aria-label="This Mac’s connection code" value={code} readOnly spellCheck={false} /></label>
      <button type="button" className="small-button" onClick={() => { setCopyError(undefined)
        void copyTextToClipboard(code, () => setCopyError('Copy failed. Select the public code and copy it again.')).then(ok => { if (live.current) setCopied(ok) })
      }}>{copied ? 'Copied code' : 'Copy code'}</button></div> : null}
    {copyError ? <p role="alert" className="host-check-detail">{copyError}</p> : null}
    <TailcatSetupHelp host={host} role={role} failure={state.error ? { step: 'prepare-key', code: state.error.code } : undefined} />
  </div>
}
