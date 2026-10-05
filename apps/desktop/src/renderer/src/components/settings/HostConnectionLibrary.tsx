import { TextInput } from '@agentmux/client-ui/input'
import { Check, ChevronRight, FolderOpen, Search, SlidersHorizontal } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export type HostConnectionPanel = 'connection' | 'projects'
type HostRow = { id: string; name: string; detail: string; mark: ReactNode; status: ReactNode; projectCount: number }

/** Disclosure navigation only; the original Host pane owns every draft and operation. */
export function HostConnectionLibrary({ items, selectedId, panel, onSelect, query, onQuery, focusRequest }: {
  items: HostRow[]
  selectedId: string | null
  panel: HostConnectionPanel
  onSelect: (id: string, panel: HostConnectionPanel) => void
  query: string
  onQuery: (query: string) => void
  focusRequest: { id: string | null } | null
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => selectedId ? { [selectedId]: true } : {})
  const list = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const consumedFocus = useRef(focusRequest)

  useEffect(() => {
    if (selectedId) setExpanded((current) => current[selectedId] ? current : { ...current, [selectedId]: true })
  }, [selectedId])
  useLayoutEffect(() => {
    if (!focusRequest || consumedFocus.current === focusRequest) return
    const branch = [...(list.current?.querySelectorAll<HTMLDetailsElement>('[data-host-disclosure]') ?? [])]
      .find((node) => node.dataset.hostDisclosure === focusRequest.id)
    if (branch && !branch.open) {
      setExpanded((current) => ({ ...current, [branch.dataset.hostDisclosure!]: true }))
      return
    }
    const target = branch ? [...branch.querySelectorAll<HTMLButtonElement>('[data-host-panel]')]
      .find((node) => node.dataset.hostPanel === panel) : search.current
    target?.focus()
    target?.scrollIntoView?.({ block: 'nearest' })
    consumedFocus.current = focusRequest
  }, [focusRequest, expanded, panel])

  return <aside className="settings-resource-library settings-host-library">
    <label className="settings-resource-search"><Search size={14} aria-hidden="true" />
      <TextInput ref={search} type="search" aria-label="Filter hosts" placeholder="Find an environment…" value={query} onChange={(event) => onQuery(event.target.value)} />
    </label>
    <div ref={list} className="settings-resource-library__list" aria-label="Environments">
      {items.map((item) => <details key={item.id} className="settings-host-branch" data-host-disclosure={item.id}
        data-current-host={selectedId === item.id} open={expanded[item.id] ?? false} onToggle={(event) => {
          const open = event.currentTarget.open
          setExpanded((current) => current[item.id] === open ? current : { ...current, [item.id]: open })
        }}>
        <summary className="settings-host-branch__summary" title={`${item.name} · ${item.id}`}>
          <ChevronRight size={12} className="settings-host-branch__chevron" aria-hidden="true" />
          <span className="settings-resource-row__mark">{item.mark}</span>
          <span className="settings-resource-row__text"><strong>{item.name}</strong><small>{item.detail}</small></span>
          <span className="settings-resource-row__status">{item.status}</span>
        </summary>
        <div className="settings-host-branch__pages">
          {(['connection', 'projects'] as const).map((page) => {
            const selected = selectedId === item.id && panel === page
            return <button type="button" key={page} data-host-panel={page}
              {...(page === 'connection' ? { 'data-resource-row': item.id } : {})}
              aria-current={selected ? 'page' : undefined} className="settings-host-page" onClick={() => onSelect(item.id, page)}>
              {page === 'connection' ? <SlidersHorizontal size={13} aria-hidden="true" /> : <FolderOpen size={13} aria-hidden="true" />}
              <span>{page === 'connection' ? 'Connection' : 'Projects'}</span>
              {page === 'projects' ? <small>{item.projectCount}</small> : null}
              {selected ? <Check size={12} aria-hidden="true" /> : null}
            </button>
          })}
        </div>
      </details>)}
      {items.length === 0 ? <p className="settings-resource-empty" role="status">{query.trim() ? `No environments match “${query}”.` : 'No environments yet.'}</p> : null}
    </div>
  </aside>
}
