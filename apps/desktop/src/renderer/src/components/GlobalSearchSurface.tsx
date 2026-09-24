import { ArrowUpRight, LoaderCircle, Plus, Search } from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import { browserOpenError } from '../lib/browser-open-feedback'
import { presentError } from '../lib/error-presentation'
import { useAppStore } from '../store'
import { SearchBrowserTools } from './SearchBrowserTools'

export const GlobalSearchSurface = memo(function GlobalSearchSurface({ visible = true }: { visible?: boolean }) {
  const config = useAppStore((state) => state.config)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const layouts = useAppStore((state) => state.layouts)
  const selectWorkspace = useAppStore((state) => state.selectWorkspace)
  const createBrowser = useAppStore((state) => state.createBrowser)
  const workspace = config?.workspaces.find(({ id }) => id === activeWorkspaceId)
  const [query, setQuery] = useState('')
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const surfaceRef = useRef<HTMLElement>(null)
  const queryRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (visible) queryRef.current?.focus()
    else if (surfaceRef.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
  }, [visible])

  async function openBrowser(input = 'about:blank'): Promise<void> {
    if (opening) return
    const layout = workspace ? layouts[workspace.id] : undefined
    if (!workspace || !layout?.activeGroupId) {
      setError(browserOpenError(undefined))
      return
    }
    setOpening(true)
    setError(null)
    try {
      // Main interprets the same input as the Browser address bar. It owns URL/search handling.
      await createBrowser(layout.activeGroupId, undefined, input)
      await selectWorkspace(workspace.id)
    } catch (cause) {
      setError(`Browser could not open: ${presentError(cause)}. Your input is kept; retry here.`)
    } finally {
      setOpening(false)
    }
  }

  return (
    <section ref={surfaceRef} className="global-search-surface" aria-label="Search" hidden={!visible} inert={!visible} aria-hidden={!visible}>
      <div className="global-search-shell">
        <form className="global-search-input" onSubmit={(event) => {
          event.preventDefault()
          if (query.trim()) void openBrowser(query)
        }}>
          <Search size={15} aria-hidden="true" />
          <input
            ref={queryRef}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setError(null) }}
            placeholder="Search or enter a web address"
            aria-label="Search or enter a web address"
          />
          <button type="submit" aria-label="Search or open page" title="Search or open page" disabled={opening || !query.trim()}>
            {opening ? <LoaderCircle className="spin" size={15} /> : <ArrowUpRight size={15} />}
          </button>
        </form>
        <div className="global-search-context">
          <span title={workspace?.path}>
            <small>Workspace</small><strong>{workspace?.name ?? 'Select a workspace in Space'}</strong>
          </span>
          {workspace ? <button className="small-button" type="button" onClick={() => void selectWorkspace(workspace.id)}>Return to Space</button> : null}
          <button className="small-button" type="button" aria-label="New Browser" title={opening ? 'Opening Browser…' : 'New Browser'} disabled={opening} onClick={() => void openBrowser()}>
            {opening ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />} New Browser
          </button>
        </div>
        {error ? <p className="global-search-error" role="alert">{error}</p> : null}
        {workspace ? <SearchBrowserTools workspace={workspace} visible={visible} /> : null}
      </div>
    </section>
  )
})
