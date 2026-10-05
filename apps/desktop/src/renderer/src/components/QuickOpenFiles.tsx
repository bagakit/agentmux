import { TextInput } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FileNameListing } from '@agentmux/core'
import { api } from '../lib/api'
import { useWorkspaceResource } from '../hooks/useWorkspaceResource'
import { fileNavigationSelection, useAppStore } from '../store'
import { FilePathLabel } from './FilePathLabel'
import { isImeCompositionKeyDown } from '../lib/ime-composition-keyboard-event'
import { quickFileQuery, rankQuickFiles } from '../lib/quick-open-files'

const ThemeActionSearchIcon = semanticIconComponent('action.search')


/** A reader in the existing QuickSwitcher. It owns neither file contents nor navigation state. */
export function QuickOpenFiles({ onClose }: { onClose: () => void }) {
  const workspaceId = useAppStore(state => state.activeWorkspaceId)
  const workspace = useWorkspaceResource(workspaceId)
  const tabs = useAppStore(state => state.tabs)
  const [query, setQuery] = useState(''), [activeIndex, setActiveIndex] = useState(0)
  const [listing, setListing] = useState<FileNameListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reading, setReading] = useState(false), [retry, setRetry] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const recent = useMemo(() => Object.values(tabs).reverse()
    .flatMap(tab => Object.values(tab.regions).flatMap(surface => surface.kind === 'file' && surface.workspaceId === workspaceId ? [surface.path] : [])), [tabs, workspaceId])
  useEffect(() => {
    let current = true
    setListing(null); setError(null); setActiveIndex(0)
    if (!workspace) { setReading(false); return }
    setReading(true)
    void api.files.list(workspace.id).then(result => { if (current) setListing(result) },
      failure => { if (current) setError(failure instanceof Error ? failure.message : String(failure)) })
      .finally(() => { if (current) setReading(false) })
    return () => { current = false }
  }, [workspace, retry])
  const parsed = useMemo(() => quickFileQuery(query, [...recent, ...listing?.files ?? []]), [query, listing, recent])
  const results = useMemo(() => rankQuickFiles(listing?.files ?? [], recent, parsed.query), [listing, recent, parsed.query])
  useEffect(() => setActiveIndex(0), [query])
  useEffect(() => { listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }) }, [activeIndex, results])

  function activate(path: string | undefined) {
    if (!path || !workspace) return
    const original = fileNavigationSelection(useAppStore.getState()), resource = workspace
    onClose()
    // The original overlay owner commits uncovered before asking an already-warm File for caret.
    requestAnimationFrame(() => {
      const state = useAppStore.getState(), current = state.config?.workspaces.find(item => item.id === resource.id)
      if (fileNavigationSelection(state) !== original ||
          current?.hostId !== resource.hostId || current.path !== resource.path) return
      void state.openFileAndReveal(path, undefined, parsed.location, resource.id).catch(state.reportError)
    })
  }
  return <div className="quick-file-picker">
    <div className="quick-switch__input"><ThemeActionSearchIcon size={15} /><TextInput autoFocus value={query} placeholder="Find project files…  path:line:column"
      aria-label="Find project files" aria-controls="quick-file-list" onChange={event => setQuery(event.target.value)} onKeyDown={event => {
    if (isImeCompositionKeyDown(event)) return
    if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex(index => Math.min(index + 1, Math.max(0, results.length - 1))) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex(index => Math.max(0, index - 1)) }
    else if (event.key === 'Enter') { event.preventDefault(); activate(results[activeIndex]) }
  }} /></div>
    <div className="quick-file-picker__scope" role="status">
      <span>{workspace?.name ?? 'Select a Workspace'}{reading ? ' · Discovering files…' : listing ? ` · ${listing.files.length.toLocaleString()} files${listing.omitted === 'git-ignored' ? ' · Git ignored omitted' : ''}` : ''}</span>
      {listing && !listing.complete ? <span>Partial listing ({listing.partialReason}). <button onClick={() => setRetry(value => value + 1)}>Refresh</button></span> : null}
      {error ? <span>{error} <button onClick={() => setRetry(value => value + 1)}>Retry</button></span> : null}
    </div>
    <div className="quick-switch__list" id="quick-file-list" role="listbox" ref={listRef}>
      {results.map((path, index) => <button key={path} type="button" role="option" aria-selected={index === activeIndex} data-active={index === activeIndex}
        className="quick-switch__row" onMouseMove={() => setActiveIndex(index)} onClick={() => activate(path)}>
        <span className="quick-switch__labels"><FilePathLabel path={path} /></span>
        {recent.includes(path) ? <span className="quick-file-picker__recent">Open</span> : null}
      </button>)}
      {!results.length ? <div className="quick-switch__empty">{reading ? 'Looking for files. Recently opened files remain available.' : error ? 'Discovery is unavailable. Retry or open an exact path from the Explorer.' : 'No files match this listing.'}</div> : null}
      {results.length === 100 ? <div className="quick-file-picker__scope">Showing the first 100 matches. Refine the path to narrow results.</div> : null}
    </div>
  </div>
}
