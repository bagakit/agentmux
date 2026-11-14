import { useEffect, useMemo, useRef, useState } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import type { TailcatKeyPreparation as PreparedKey, TailcatKeyRole } from '@agentmux/core'
import { api } from '../../lib/api'
import { copyTextToClipboard } from '../../lib/clipboard-copy'
import { useContentCopyAction } from '@agentmux/client-ui/use-content-copy-action'
import type { HostConfig } from '../../../../shared/contracts'
import { TailcatSetupHelp } from './TailcatSetupHelp'
import { tailcatPreparationFailure } from '../../lib/tailcat-preparation-failure'

/** The original Host owns preparation. This component owns only its explicit action and receipt. */
export function TailcatKeyPreparation({ host, role, keyFile, onPrepared, saveLabel = 'Save hosts', active = true }: {
  host: HostConfig
  role: TailcatKeyRole
  keyFile: string
  onPrepared: (result: PreparedKey, mayFocus: boolean) => boolean
  saveLabel?: string
  active?: boolean
}) {
  const [state, setState] = useState<{ busy?: boolean; result?: PreparedKey; error?: ReturnType<typeof tailcatPreparationFailure>; keptDraft?: boolean }>({})
  const live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const prepare = async () => {
    const apply = onPrepared, originalFocus = document.activeElement
    setState({ busy: true })
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
  const copyIdentity = useMemo(() => ({}), [host.id, result, code])
  const copy = useContentCopyAction(copyIdentity, copyTextToClipboard, active)
  return <div className="host-tailcat-preparation" data-tailcat-prepare={role}>
    <div className="host-tailcat-preparation__action">
      <button type="button" className="small-button" disabled={state.busy === true} onClick={() => void prepare()}>
        {state.busy ? 'Preparing key…' : role === 'server' ? 'Prepare this Mac to receive' : 'Get this Mac’s code'}
      </button>
      <span>Uses your saved key when available.</span>
    </div>
    {state.error ? <div role="alert" className="host-tailcat-preparation__issue"><strong>{state.error.title}</strong><p>{state.error.next}</p>
      <p>Your connection draft is kept.</p>{state.error.code ? <details><summary>Error details</summary><code>{state.error.code}</code></details> : null}</div> : result ? <p role="status" className="host-tailcat-preparation__receipt">
      {result.created ? 'Created' : 'Reusing'} key <code>{result.key}</code>.{state.keptDraft ? ' Your later draft edits were kept.' : role === 'server' ? ` Add the connection code below, then ${saveLabel}.` : ' Copy this code to the other Mac’s allowed clients.'}
    </p> : null}
    {code ? <div className="host-tailcat-address"><label><span>This Mac’s connection code <small>public key</small></span>
      <TextInput aria-label="This Mac’s connection code" value={code} readOnly spellCheck={false} /></label>
      <button type="button" className="small-button" aria-disabled={copy.state === 'copying' || undefined}
        onClick={() => { void copy.copy(code) }}><span role="status">{copy.state === 'copied' ? 'Copied code' : 'Copy code'}</span></button></div> : null}
    {copy.state === 'failed' ? <p role="alert" className="host-check-detail">Copy failed. Select the public code and copy it again.</p> : null}
    <TailcatSetupHelp active={active} host={host} role={role} failure={state.error ? { step: 'prepare-key', code: state.error.code } : undefined} />
  </div>
}
