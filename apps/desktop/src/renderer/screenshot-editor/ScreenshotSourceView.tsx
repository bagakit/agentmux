import { useEffect, useRef, useState } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { ScreenshotSourceApi, ScreenshotSourceInput, ScreenshotSourceList } from '../../shared/screenshot-source'

export function ScreenshotSourceView({ input, api }: { input: ScreenshotSourceInput; api: ScreenshotSourceApi }) {
  const [list, setList] = useState<ScreenshotSourceList>({ choices: [], issues: [] }), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [query, setQuery] = useState(''), [app, setApp] = useState<string | null>(null)
  const epoch = useRef(0)
  async function load(appKey: string | null = null) {
    const token = ++epoch.current; setBusy(true); setError(''); setQuery('')
    try { const next = await (appKey ? api.windows(input.requestId, appKey) : api.list(input.requestId)); if (epoch.current === token) { setList(next); setApp(appKey) } }
    catch (cause) { if (epoch.current === token) setError(presentError(cause)) }
    finally { if (epoch.current === token) setBusy(false) }
  }
  async function cancel() { epoch.current++; try { await api.cancel(input.requestId) } catch (cause) { setError(presentError(cause)) } }
  useEffect(() => { void load(); const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); void cancel() } }; window.addEventListener('keydown', key); return () => { epoch.current++; window.removeEventListener('keydown', key) } }, [])
  async function select(key: string) {
    if (input.kind === 'window' && app === null) { await load(key); return }
    try { await api.select(input.requestId, key) } catch (cause) { setError(presentError(cause)) }
  }
  const choices = list.choices.filter(choice => `${choice.label} ${choice.detail}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  return <main className="screenshot-source">
    <header><div><h1>{input.kind === 'display' ? 'Capture a display' : app === null ? 'Choose an application' : 'Capture a window'}</h1><p>Select the exact source for this screenshot.</p></div><button onClick={() => void cancel()}>Cancel</button></header>
    <div className="screenshot-source__search">{app !== null ? <button disabled={busy} onClick={() => void load()}>← Applications</button> : null}<TextInput aria-label="Filter capture sources" placeholder="Filter sources…" value={query} onChange={event => setQuery(event.target.value)} /></div>
    <div className="screenshot-source__choices" aria-busy={busy}>{busy ? <p role="status">Reading available sources…</p> : choices.length ? choices.map(choice => <button key={choice.key} onClick={() => void select(choice.key)}><strong>{choice.label}</strong><span>{choice.detail}</span></button>) : <p role="status">{error ? 'Sources could not be loaded. Retry or cancel.' : 'No matching sources.'}</p>}</div>
    {list.issues.length ? <p className="screenshot-source__issue">Some sources could not be confirmed. Available sources remain usable.</p> : null}
    {error ? <div className="screenshot-source__issue" role="alert">{error}<button onClick={() => void load(app)}>Retry</button></div> : null}
    <footer>{input.kind === 'display' ? 'One image from the selected display.' : 'Window identity is checked again when capturing.'}</footer>
  </main>
}
