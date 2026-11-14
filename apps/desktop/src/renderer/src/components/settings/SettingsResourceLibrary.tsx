import { SearchInput } from '@agentmux/client-ui/input'
import { SurfaceState } from '../SurfaceState'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

const ThemeStatusSelectedIcon = semanticIconComponent('status.selected')
const ScrollBackIcon = semanticIconComponent('navigation.back')
const ScrollForwardIcon = semanticIconComponent('navigation.disclosure')


type ResourceRow = { id: string; name: string; detail: string; mark: ReactNode; status?: ReactNode }
const NO_ROWS: ResourceRow[] = []

/** A compact selector only. Drafts and resource operations stay in the owning pane. */
export function SettingsResourceLibrary({ label, items: projection, selectedId, onSelect, query = '', onQuery, focusRequest, layout = 'list', followFocus = false, selection }: {
  label: string
  items: ResourceRow[] | null
  selectedId: string | null
  onSelect: (id: string) => void
  query?: string
  onQuery?: (query: string) => void
  focusRequest: { id: string | null } | null
  layout?: 'list' | 'horizontal'
  /** Arrow keys also select, so the editor follows the row the keyboard is on. Only for editors that keep no unsaved draft. */
  followFocus?: boolean
  /** In explicit selection mode row activation toggles exact IDs and keeps the editor target. */
  selection?: { ids: ReadonlySet<string>; onToggle: (id: string) => void }
}) {
  const items = projection ?? NO_ROWS
  const list = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const [focusedId, setFocusedId] = useState(selectedId)
  const [overflow, setOverflow] = useState({ previous: false, next: false })
  useLayoutEffect(() => {
    const node = list.current
    if (layout !== 'horizontal' || !node) return
    const update = () => {
      const previous = node.scrollLeft > 1
      const next = node.scrollLeft + node.clientWidth < node.scrollWidth - 1
      setOverflow(current => current.previous === previous && current.next === next ? current : { previous, next })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    for (const child of node.children) observer.observe(child)
    node.addEventListener('scroll', update, { passive: true })
    return () => { observer.disconnect(); node.removeEventListener('scroll', update) }
  }, [layout, items])
  const scrollable = layout === 'horizontal' && (overflow.previous || overflow.next)
  const scrollPage = (direction: number) => list.current?.scrollBy({ left: direction * list.current.clientWidth * .75, behavior: 'instant' })
  useEffect(() => setFocusedId(selectedId), [selectedId])
  useEffect(() => {
    if (layout !== 'horizontal') return
    const reveal = () => {
      const row = [...(list.current?.querySelectorAll<HTMLButtonElement>('[data-resource-row]') ?? [])]
        .find((element) => element.dataset.resourceRow === selectedId)
      row?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    }
    reveal()
    const observer = new ResizeObserver(reveal)
    observer.observe(list.current!)
    return () => observer.disconnect()
  }, [layout, selectedId])
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
    <aside className={`settings-resource-library${layout === 'horizontal' ? ' settings-resource-library--horizontal' : ''}`}>
      {onQuery ? <SearchInput className="settings-resource-search" ref={search} aria-label={`Filter ${label.toLowerCase()}`}
        placeholder={`Find ${label.toLowerCase()}…`} clearLabel={`Clear ${label.toLowerCase()} filter`} value={query} onValueChange={onQuery} /> : null}
      <div className="settings-resource-library__viewport">
      {scrollable ? <button type="button" className="icon-button settings-resource-scroll" aria-label={`Previous ${label.toLowerCase()}`} disabled={!overflow.previous} onClick={() => scrollPage(-1)}><ScrollBackIcon size={13} /></button> : null}
      <div ref={list} className="settings-resource-library__list" role="listbox" aria-label={label} aria-multiselectable={selection ? true : undefined} aria-orientation={layout === 'horizontal' ? 'horizontal' : 'vertical'}>
        {items.map((item, index) => <button type="button" key={item.id} role="option" aria-selected={selection ? selection.ids.has(item.id) : selectedId === item.id}
          tabIndex={tabId === item.id ? 0 : -1} data-resource-row={item.id} title={`${item.name}\n${item.detail}`} className="settings-resource-row"
          onFocus={() => { setFocusedId(item.id); if (!selection && followFocus && item.id !== selectedId) onSelect(item.id) }} onClick={() => selection ? selection.onToggle(item.id) : onSelect(item.id)} onKeyDown={(event) => {
            let next: number
            switch (event.key) {
              case 'ArrowRight': if (layout !== 'horizontal') return; next = Math.min(index + 1, items.length - 1); break
              case 'ArrowLeft': if (layout !== 'horizontal') return; next = Math.max(index - 1, 0); break
              case 'ArrowDown': next = Math.min(index + 1, items.length - 1); break
              case 'ArrowUp': next = Math.max(index - 1, 0); break
              case 'Home': next = 0; break
              case 'End': next = items.length - 1; break
              default: return
            }
            event.preventDefault()
            list.current?.querySelectorAll<HTMLButtonElement>('[data-resource-row]')[next]?.focus()
          }}>
          <span className="settings-resource-row__mark">{item.mark}</span>
          <span className="settings-resource-row__text"><strong>{item.name}</strong><small>{item.detail}</small></span>
          <span className="settings-resource-row__status">{item.status}{(selection ? selection.ids.has(item.id) : selectedId === item.id) ? <ThemeStatusSelectedIcon size={13} aria-hidden="true" /> : null}</span>
        </button>)}
      </div>
      {projection?.length === 0 ? <SurfaceState layout="inline" className="settings-resource-empty" role="status"
        title={query.trim() ? `No ${label.toLowerCase()} match “${query}”.` : `No ${label.toLowerCase()} yet.`} /> : null}
      {scrollable ? <button type="button" className="icon-button settings-resource-scroll" aria-label={`More ${label.toLowerCase()}`} disabled={!overflow.next} onClick={() => scrollPage(1)}><ScrollForwardIcon size={13} /></button> : null}
      </div>
    </aside>
  )
}
