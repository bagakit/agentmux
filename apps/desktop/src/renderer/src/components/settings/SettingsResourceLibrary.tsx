import { TextInput } from '@agentmux/client-ui/input'
import { Check, Search } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

type ResourceRow = { id: string; name: string; detail: string; mark: ReactNode; status?: ReactNode }

/** A compact selector only. Drafts and resource operations stay in the owning pane. */
export function SettingsResourceLibrary({ label, items, selectedId, onSelect, query, onQuery, focusRequest }: {
  label: string
  items: ResourceRow[]
  selectedId: string | null
  onSelect: (id: string) => void
  query: string
  onQuery: (query: string) => void
  focusRequest: { id: string | null } | null
}) {
  const list = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const [focusedId, setFocusedId] = useState(selectedId)
  useEffect(() => setFocusedId(selectedId), [selectedId])
  useEffect(() => {
    if (!focusRequest) return
    const row = [...(list.current?.querySelectorAll<HTMLButtonElement>('[data-resource-row]') ?? [])]
      .find((element) => element.dataset.resourceRow === focusRequest.id)
    if (row) {
      row.focus()
      row.scrollIntoView?.({ block: 'nearest' })
    } else search.current?.focus()
  }, [focusRequest])
  const tabId = items.some((item) => item.id === focusedId) ? focusedId : items.some((item) => item.id === selectedId) ? selectedId : items[0]?.id
  return (
    <aside className="settings-resource-library">
      <label className="settings-resource-search"><Search size={14} aria-hidden="true" />
        <TextInput ref={search} type="search" aria-label={`Filter ${label.toLowerCase()}`} placeholder={`Find ${label.toLowerCase()}…`} value={query} onChange={(event) => onQuery(event.target.value)} />
      </label>
      <div ref={list} className="settings-resource-library__list" role="listbox" aria-label={label}>
        {items.map((item, index) => <button type="button" key={item.id} role="option" aria-selected={selectedId === item.id}
          tabIndex={tabId === item.id ? 0 : -1} data-resource-row={item.id} title={item.name} className="settings-resource-row"
          onFocus={() => setFocusedId(item.id)} onClick={() => onSelect(item.id)} onKeyDown={(event) => {
            let next: number
            switch (event.key) {
              case 'ArrowDown': next = Math.min(index + 1, items.length - 1); break
              case 'ArrowUp': next = Math.max(index - 1, 0); break
              case 'Home': next = 0; break
              case 'End': next = items.length - 1; break
              default: return
            }
            event.preventDefault()
            const target = items[next]!
            list.current?.querySelectorAll<HTMLButtonElement>('[data-resource-row]')[next]?.focus()
          }}>
          <span className="settings-resource-row__mark">{item.mark}</span>
          <span className="settings-resource-row__text"><strong>{item.name}</strong><small>{item.detail}</small></span>
          <span className="settings-resource-row__status">{item.status}{selectedId === item.id ? <Check size={13} aria-hidden="true" /> : null}</span>
        </button>)}
        {items.length === 0 ? <p className="settings-resource-empty" role="status">{query.trim() ? `No ${label.toLowerCase()} match “${query}”.` : `No ${label.toLowerCase()} yet.`}</p> : null}
      </div>
    </aside>
  )
}
