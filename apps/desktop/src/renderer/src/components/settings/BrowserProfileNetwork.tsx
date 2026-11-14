import { SegmentedControl } from '@agentmux/client-ui/components/SegmentedControl'
import { TextInput } from '@agentmux/client-ui/input'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useContext, useEffect, useId, useRef, useState } from 'react'
import type { BrowserProfileEdit, BrowserProfileSummary } from '../../../../shared/contracts'
import { formatBrowserProfileProxyServer, normalizeBrowserProfileNetwork, type BrowserProfileNetwork } from '../../../../shared/browser-profile-network'
import { api } from '../../lib/api'
import { SettingsNavigation } from '../SettingsNavigation'

const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')

type RouteMode = BrowserProfileNetwork['mode']
const ROUTE_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'direct', label: 'Direct' },
  { value: 'proxy', label: 'Proxy' }
] as const

/**
 * How this Profile's pages reach the network. One segmented choice, one Server field that takes a whole
 * pasted line, and the Don't proxy list under More. Apply is the only way to change it: Main applies the
 * route to the Profile's session before saving, so a route that cannot be applied leaves the old one in use.
 */
export function ProfileNetworkRoute({ profile, proxy, openBrowsers, run, baselineRefresh = 0 }: {
  profile: BrowserProfileSummary
  proxy?: import('@agentmux/core/control').BrowserProxyAsset | undefined
  baselineRefresh?: number
  /** How many of this Profile's Browsers are open now; they reconnect through the new route. */
  openBrowsers: number
  run(key: string, action: () => Promise<unknown>): Promise<boolean>
}) {
  const routeHintId = useId()
  const saved = profile.network ?? { mode: 'system' as const }
  const savedServer = saved.mode === 'proxy' ? formatBrowserProfileProxyServer(saved.server) : ''
  const savedBypass = saved.mode === 'proxy' ? (saved.bypass ?? []).join(', ') : ''
  const draftRevision = useRef(profile.revision), dirty = useRef(false)
  useEffect(() => { draftRevision.current = profile.revision }, [baselineRefresh])
  const beginEdit = () => { if (!dirty.current) draftRevision.current = profile.revision; dirty.current = true }
  const [mode, setMode] = useState<RouteMode>(saved.mode)
  const [server, setServer] = useState(savedServer)
  const [bypass, setBypass] = useState(savedBypass)
  const [more, setMore] = useState(savedBypass !== '')
  // The same parser Main uses decides here, so what Apply sends is exactly what Main will accept.
  let draft: NonNullable<BrowserProfileEdit['network']> = { mode: mode === 'proxy' ? 'system' : mode }
  let problem: string | null = null
  try { draft = normalizeBrowserProfileNetwork(mode === 'proxy' ? { mode, server, bypass: bypass.split(/[\s,]+/) } : { mode }) }
  catch (cause) { problem = cause instanceof Error ? cause.message : String(cause) }
  const changed = mode !== saved.mode || (mode === 'proxy' && (server.trim() !== savedServer || bypass.trim() !== savedBypass))
  const reconnect = openBrowsers ? ` · ${openBrowsers} open Browser${openBrowsers > 1 ? 's' : ''} reconnect` : ''
  return (
    <section className="browser-profile-editor__section" aria-label="Network">
      <h4>Network</h4>
      {profile.proxyBinding ? <p className="browser-profile-editor__quiet">Proxy library · {proxy?.label ?? 'Original asset unavailable'}{proxy && proxy.revision !== profile.proxyBinding.revision ? ' · A different asset version is available' : ''}. Editing this route removes that binding.</p> : null}
      <p className="browser-profile-editor__quiet" role="status">{profile.networkApplication?.status === 'applied' ? 'Native route configuration confirmed.' : profile.networkApplication?.status === 'pending' ? 'Native route configuration is pending.' : 'Native route configuration is unconfirmed.'} Exit and protocol checks are separate.</p>
      <SegmentedControl className="browser-profile-editor__route-modes" aria-label="Network route" options={ROUTE_OPTIONS}
        value={mode} onValueChange={next => { beginEdit(); setMode(next) }} />
      {mode === 'proxy' ? <div className="browser-profile-editor__route-fields">
        <TextInput aria-label="Proxy server" placeholder="host:port or socks5://host:port" value={server} spellCheck={false}
          aria-describedby={routeHintId} aria-invalid={problem !== null && server.trim() !== ''} onChange={event => { beginEdit(); setServer(event.target.value) }} />
        {more ? <TextInput aria-label="Don’t proxy" placeholder="*.corp.example, localhost" value={bypass} spellCheck={false} onChange={event => { beginEdit(); setBypass(event.target.value) }} />
          : <button type="button" className="browser-profile-editor__link" onClick={() => setMore(true)}>More</button>}
      </div> : null}
      <p id={routeHintId} className={problem && server.trim() ? 'browser-profile-editor__error' : 'browser-profile-editor__quiet'} role={problem && server.trim() ? 'alert' : undefined}>
        {problem && server.trim() ? problem
          : mode === 'system' ? 'Pages use the proxy settings of this Mac.' : mode === 'direct' ? 'Pages connect without any proxy, even if this Mac has one.'
          : 'Every page of this Profile goes through this server. If it cannot be reached, its pages do not open rather than connecting directly.'}
      </p>
      {changed ? <div className="browser-profile-editor__route-apply">
        <button type="button" className="small-button" onClick={() => { dirty.current = false; draftRevision.current = profile.revision; setMode(saved.mode); setServer(savedServer); setBypass(savedBypass) }}>Revert</button>
        <button type="button" className="primary-button" disabled={problem !== null}
          onClick={() => void run('network', () => api.browser.updateProfile(profile.id, { network: draft.mode === 'system' ? null : draft }, draftRevision.current)).then(ok => { if (ok) dirty.current = false })}>Apply network{reconnect}</button>
      </div> : null}
    </section>
  )
}

/**
 * The sign-in for this Profile's proxy. Only the user name is ever read back; the password field
 * starts empty, is sent to Main once on Save and cleared, and Main encrypts it with the keychain.
 */
export function ProfileProxySignIn({ profile }: { profile: BrowserProfileSummary }) {
  const [saved, setSaved] = useState<string | null | undefined>(undefined)
  const [editing, setEditing] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [state, setState] = useState<{ kind: 'idle' | 'saving' } | { kind: 'failed' | 'partial'; message: string }>({ kind: 'idle' })
  const [readError, setReadError] = useState<string | null>(null)
  const [readAttempt, setReadAttempt] = useState(0)
  const readGeneration = useRef(0)
  useEffect(() => {
    const generation = ++readGeneration.current
    setReadError(null)
    api.browser.readProfileProxySignIn(profile.id).then(result => {
      if (generation === readGeneration.current) setSaved(result?.username ?? null)
    }, cause => {
      if (generation === readGeneration.current) setReadError(presentError(cause))
    })
    return () => { if (generation === readGeneration.current) readGeneration.current += 1 }
  }, [profile.id, readAttempt])
  const save = async (signIn: { username: string; password: string } | null) => {
    // A late observation must not replace the result of the person's newer save.
    readGeneration.current += 1
    setReadError(null)
    setState({ kind: 'saving' })
    try {
      const result = await api.browser.setProfileProxySignIn(profile.id, signIn)
      setSaved(signIn ? signIn.username.trim() : null); setEditing(false); setPassword('')
      setState(result.reconnected ? { kind: 'idle' } : { kind: 'partial', message: `${signIn ? 'Sign-in saved' : 'Sign-in forgotten'}. Open connections could not be updated. Reload this Profile’s pages to use the change.` })
    } catch (cause) { setPassword(''); setState({ kind: 'failed', message: presentError(cause) }) }
  }
  return (
    <section className="browser-profile-editor__section" aria-label="Proxy sign-in">
      <h4>Proxy sign-in</h4>
      {editing ? <form className="browser-profile-editor__sign-in" onSubmit={event => { event.preventDefault(); void save({ username, password }) }}
        onKeyDown={event => { if (event.key === 'Escape' && !isImeOwnedKeyboardEvent(event)) { event.preventDefault(); event.stopPropagation(); setEditing(false); setPassword('') } }}>
        <TextInput aria-label="Proxy user name" placeholder="User name" autoComplete="off" autoFocus value={username} maxLength={256} onChange={event => setUsername(event.target.value)} />
        <TextInput aria-label="Proxy password" placeholder="Password" type="password" autoComplete="new-password" value={password} maxLength={1024} onChange={event => setPassword(event.target.value)} />
        <button type="button" className="small-button" onClick={() => { setEditing(false); setPassword('') }}>Cancel</button>
        <button type="submit" className="primary-button" disabled={state.kind === 'saving' || !username.trim() || !password}>Save</button>
      </form> : <p className="browser-profile-editor__route">
        <span>{saved === undefined ? readError ? 'Sign-in unknown' : 'Reading…' : saved ? `Signs in as ${saved}` : 'No sign-in'}</span>
        <button type="button" className="small-button" disabled={state.kind === 'saving'} onClick={() => { setUsername(saved ?? ''); setEditing(true) }}>{saved ? 'Change' : saved === undefined ? 'Set sign-in' : 'Add sign-in'}</button>
        {saved ? <button type="button" className="small-button" disabled={state.kind === 'saving'} onClick={() => void save(null)}>Forget</button> : null}
      </p>}
      {readError ? <p className="browser-profile-editor__error" role="status">Couldn’t read proxy sign-in. {readError}{' '}
        <button type="button" className="browser-profile-editor__link" onClick={() => setReadAttempt(attempt => attempt + 1)}>Retry</button>
      </p> : null}
      <p className={state.kind === 'failed' ? 'browser-profile-editor__error' : 'browser-profile-editor__quiet'} role={state.kind === 'failed' ? 'alert' : state.kind === 'partial' ? 'status' : undefined}>
        {state.kind === 'failed' || state.kind === 'partial' ? state.message : 'Used only when this Profile’s own proxy asks. The password is kept in the system keychain and never shown again.'}
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
    : profile.network?.mode === 'direct' ? 'Connects directly' : 'Follows the system proxy'
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
