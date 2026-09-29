import { Search, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { buildCheatSheet, type CheatSheetRow } from '../../lib/shortcut-cheat-sheet'
import { bindingById, type ShortcutBinding } from '../../lib/shortcut-registry'
import { isMacPlatform } from '../../lib/host-platform'
import '../../styles/settings-keyboard-shortcuts.css'

function scopeDescription(binding: ShortcutBinding): string {
  switch (binding.scope) {
    case 'window': return binding.gate === 'not-in-editable' ? 'Window · outside text inputs and terminals' : 'Window · available while typing'
    case 'terminal': return 'Terminal · when a terminal has focus'
    case 'editor': return 'Editor · when an editor has focus'
    case 'launcher': return 'Start page · in the prompt input'
  }
}

function searchableChord(row: CheatSheetRow): string {
  return row.keys.map(token => token === '⌘' ? '⌘ cmd command' : token === '⌥' ? '⌥ alt option' : token === '⇧' ? '⇧ shift' : token).join(' ')
}

export function KeyboardShortcutsPane() {
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)
  const isMac = isMacPlatform()
  const groups = useMemo(() => buildCheatSheet(isMac), [isMac])
  const terms = query.trim().toLowerCase().split(/[+\s]+/).filter(Boolean)
  const visible = groups.map(group => ({ ...group, rows: group.rows.filter(row => {
    const text = `${row.label} ${searchableChord(row)} ${group.title}`.toLowerCase()
    return terms.every(term => text.includes(term))
  }) })).filter(group => group.rows.length > 0)
  const count = visible.reduce((total, group) => total + group.rows.length, 0)
  function clearSearch(): void { setQuery(''); search.current?.focus() }

  return <div className="keyboard-shortcuts" data-keyboard-shortcuts>
    <div className="keyboard-shortcuts__intro"><p>Shortcuts for {isMac ? 'macOS' : 'this platform'}. These bindings are read-only.</p></div>
    <div className="keyboard-shortcuts__tools">
      <label className="keyboard-shortcuts__search"><Search size={14} aria-hidden="true" /><input ref={search} aria-label="Find a command or shortcut" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a command or shortcut" />{query ? <button type="button" aria-label="Clear shortcut search" onClick={clearSearch}><X size={13} /></button> : null}</label>
      <span className="keyboard-shortcuts__count" role="status">{count} {count === 1 ? 'binding' : 'bindings'}</span>
    </div>
    {count === 0 ? <div className="keyboard-shortcuts__empty"><p>No shortcuts match “{query}”.</p><button type="button" className="small-button" onClick={clearSearch}>Clear search</button></div> : null}
    {visible.map(group => <section key={group.id} className="keyboard-shortcuts__group" data-shortcut-group={group.id}>
      <header><h3>{group.title}</h3><p>{scopeDescription(bindingById(group.rows[0]!.id)!)}</p></header>
      <ul>{group.rows.map(row => <li key={row.id} data-binding-id={row.id}>
        <span className="keyboard-shortcuts__label">{row.label}</span><span className="keyboard-shortcuts__chord">{row.keys.map((token, index) => <kbd key={index}>{token}</kbd>)}</span>
      </li>)}</ul>
    </section>)}
  </div>
}
