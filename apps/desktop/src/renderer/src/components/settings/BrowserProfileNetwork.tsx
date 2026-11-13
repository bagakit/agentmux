import { TextInput } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useContext, useEffect, useState } from 'react'
import type { BrowserProfileSummary } from '../../../../shared/contracts'
import { api } from '../../lib/api'
import { SettingsNavigation } from '../SettingsNavigation'

const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')

/**
 * The sign-in for this Profile's proxy. Only the user name is ever read back; the password field
 * starts empty, is sent to Main once on Save and cleared, and Main encrypts it with the keychain.
 */
export function ProfileProxySignIn({ profile }: { profile: BrowserProfileSummary }) {
  const [saved, setSaved] = useState<string | null | undefined>(undefined)
  const [editing, setEditing] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [state, setState] = useState<{ kind: 'idle' | 'saving' } | { kind: 'failed'; message: string }>({ kind: 'idle' })
  useEffect(() => {
    let live = true
    api.browser.readProfileProxySignIn(profile.id).then(result => { if (live) setSaved(result?.username ?? null) }, () => { if (live) setSaved(null) })
    return () => { live = false }
  }, [profile.id])
  const save = async (signIn: { username: string; password: string } | null) => {
    setState({ kind: 'saving' })
    try {
      await api.browser.setProfileProxySignIn(profile.id, signIn)
      setSaved(signIn ? signIn.username.trim() : null); setEditing(false); setPassword(''); setState({ kind: 'idle' })
    } catch (cause) { setPassword(''); setState({ kind: 'failed', message: presentError(cause) }) }
  }
  return (
    <section className="browser-profile-editor__section" aria-label="Proxy sign-in">
      <h4>Proxy sign-in</h4>
      {editing ? <form className="browser-profile-editor__sign-in" onSubmit={event => { event.preventDefault(); void save({ username, password }) }}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(false); setPassword('') } }}>
        <TextInput aria-label="Proxy user name" autoComplete="off" autoFocus value={username} maxLength={256} onChange={event => setUsername(event.target.value)} />
        <TextInput aria-label="Proxy password" type="password" autoComplete="new-password" value={password} maxLength={1024} onChange={event => setPassword(event.target.value)} />
        <button type="button" className="small-button" onClick={() => { setEditing(false); setPassword('') }}>Cancel</button>
        <button type="submit" className="primary-button" disabled={state.kind === 'saving' || !username.trim() || !password}>Save</button>
      </form> : <p className="browser-profile-editor__route">
        <span>{saved === undefined ? 'Reading…' : saved ? `Signs in as ${saved}` : 'No sign-in'}</span>
        <button type="button" className="small-button" disabled={saved === undefined} onClick={() => { setUsername(saved ?? ''); setEditing(true) }}>{saved ? 'Change' : 'Add sign-in'}</button>
        {saved ? <button type="button" className="small-button" disabled={state.kind === 'saving'} onClick={() => void save(null)}>Forget</button> : null}
      </p>}
      <p className={state.kind === 'failed' ? 'browser-profile-editor__error' : 'browser-profile-editor__quiet'} role={state.kind === 'failed' ? 'alert' : undefined}>
        {state.kind === 'failed' ? state.message : 'Used only when this Profile’s own proxy asks. The password is kept in the system keychain and never shown again.'}
      </p>
    </section>
  )
}

/**
 * Where this Profile's route reaches, checked only when the person asks. It runs one request
 * through the Profile's own session to the address chosen in Settings › Browser and reports what
 * that request saw; it is a reading, so a failed check is unknown and changes nothing.
 */
export function ProfileExitCheck({ profile, address }: { profile: BrowserProfileSummary; address: string }) {
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'checking' } | { kind: 'done'; result: Awaited<ReturnType<typeof api.browser.checkProfileExit>> } | { kind: 'failed'; message: string }>({ kind: 'idle' })
  const settings = useContext(SettingsNavigation)
  const route = profile.network?.mode === 'proxy' ? `${profile.network.server.scheme}://${profile.network.server.host}:${profile.network.server.port}`
    : profile.network?.mode === 'direct' ? 'Direct' : 'System settings'
  const check = async () => {
    setState({ kind: 'checking' })
    try { setState({ kind: 'done', result: await api.browser.checkProfileExit(profile.id) }) }
    catch (cause) { setState({ kind: 'failed', message: presentError(cause) }) }
  }
  let host = ''
  try { host = address ? new URL(address).host : '' } catch { host = '' }
  return (
    <section className="browser-profile-editor__section" aria-label="Exit check">
      <h4>Exit check</h4>
      <p className="browser-profile-editor__route">
        <span>{route}</span>
        {state.kind === 'done' && state.result.status === 'reachable'
          ? <span role="status">→ {state.result.ip ?? host} · HTTP {state.result.httpStatus} · {Math.round(state.result.latencyMs)} ms</span>
          : state.kind === 'done' && state.result.status === 'unknown' ? <span role="status" className="browser-profile-editor__route-unknown">→ unknown · {state.result.reason}</span>
          : state.kind === 'failed' ? <span role="alert" className="browser-profile-editor__route-unknown">{state.message}</span> : null}
        {address
          ? <button type="button" className="small-button" disabled={state.kind === 'checking'} onClick={() => void check()}>
            {state.kind === 'checking' ? <ThemeStatusLoadingIcon animation="spin" size={12} /> : null}{state.kind === 'done' ? 'Check again' : 'Check'}</button>
          : <button type="button" className="browser-profile-editor__link" onClick={() => settings?.open('browser')}>Set a check address</button>}
      </p>
    </section>
  )
}
