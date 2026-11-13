import { useEffect, useRef, useState } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { WINDOW_PREVIEW_LIMIT, type ScreenshotSourceApi, type ScreenshotSourceChoice, type ScreenshotSourceInput, type ScreenshotSourceList, type ScreenshotSourceThumbnail } from '../../shared/screenshot-source'

export function ScreenshotSourceView({ input, api }: { input: ScreenshotSourceInput; api: ScreenshotSourceApi }) {
  const [list, setList] = useState<ScreenshotSourceList>({ choices: [], issues: [] }), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [query, setQuery] = useState(''), [app, setApp] = useState<string | null>(null)
  const epoch = useRef(0), requestedApp = useRef<string | null>(null)
  async function load(appKey: string | null = null) {
    requestedApp.current = appKey
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
  const grid = list.choices.some(choice => choice.preview)
  const choices = list.choices.filter(choice => `${choice.label} ${choice.detail}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  return <main className="screenshot-source">
    <header><div><h1>{input.kind === 'display' ? 'Capture a display' : app === null ? 'Choose an application' : 'Capture a window'}</h1><p>Select the exact source for this screenshot.</p></div><button onClick={() => void cancel()}>Cancel</button></header>
    <div className="screenshot-source__search">{app !== null ? <button disabled={busy} onClick={() => void load()}>← Applications</button> : null}<TextInput aria-label="Filter capture sources" placeholder="Filter sources…" value={query} onChange={event => setQuery(event.target.value)} /></div>
    <div className="screenshot-source__choices" data-layout={grid ? 'grid' : 'list'} aria-busy={busy}>{busy ? <p role="status">Reading available sources…</p> : choices.length ? choices.map(choice =>
      <SourceChoice key={choice.key} choice={choice} grid={grid} thumbnail={() => api.thumbnail(input.requestId, choice.key)} onSelect={() => void select(choice.key)} />) : <p role="status">{error ? 'Sources could not be loaded. Retry or cancel.' : 'No matching sources.'}</p>}</div>
    {grid && list.choices.some(choice => !choice.preview) ? <p className="screenshot-source__note">Previews show the first {WINDOW_PREVIEW_LIMIT} windows.</p> : null}
    {list.issues.length ? <p className="screenshot-source__issue">Some sources could not be confirmed. Available sources remain usable.</p> : null}
    {error ? <div className="screenshot-source__issue" role="alert">{error}<button onClick={() => void load(requestedApp.current)}>Retry</button></div> : null}
    <footer>{input.kind === 'display' ? 'One image from the selected display.' : 'Window identity is checked again when capturing.'}</footer>
  </main>
}

/** One source card. The thumbnail is fetched once, when the card mounts; selection never waits for it. */
function SourceChoice({ choice, grid, thumbnail, onSelect }: { choice: ScreenshotSourceChoice; grid: boolean; thumbnail(): Promise<ScreenshotSourceThumbnail>; onSelect(): void }) {
  const [preview, setPreview] = useState<ScreenshotSourceThumbnail | 'loading'>(choice.preview ? 'loading' : null)
  useEffect(() => {
    if (!choice.preview) return
    let live = true
    thumbnail().then(next => { if (live) setPreview(next) }, () => { if (live) setPreview(null) })
    return () => { live = false }
  }, [choice.key])
  return <button className="screenshot-source__choice" title={`${choice.label} · ${choice.detail}`} onClick={onSelect}>
    {grid ? <span className="screenshot-source__thumbnail" data-state={preview === 'loading' ? 'loading' : preview ? 'ready' : 'unavailable'} aria-hidden>
      {preview && preview !== 'loading' ? <img src={preview.dataUrl} alt="" draggable={false} /> : null}
    </span> : null}
    <strong>{choice.label}</strong><span>{choice.detail}</span>
  </button>
}
