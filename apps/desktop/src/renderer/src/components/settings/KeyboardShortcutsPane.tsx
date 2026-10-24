import { TextInput } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useMemo, useRef, useState } from 'react'
import { buildCheatSheet, type CheatSheetRow, type CheatSheetGroupId } from '../../lib/shortcut-cheat-sheet'
import { bindingById, type ShortcutBinding } from '../../lib/shortcut-registry'
import { isMacPlatform } from '../../lib/host-platform'
import { api } from '../../lib/api'
import { SCREENSHOT_SHORTCUT, type ScreenshotShortcutStatus } from '../../../../shared/screenshot-shortcut'
import '../../styles/settings-keyboard-shortcuts.css'

const ThemeActionSearchIcon = semanticIconComponent('action.search')
const ThemeActionClearIcon = semanticIconComponent('action.clear')


function scopeDescription(binding: ShortcutBinding): string {
  switch (binding.scope) {
    case 'system': return 'System-wide · also available while another app has focus'
    case 'window': return binding.gate === 'not-in-editable' ? 'Window · outside text inputs and terminals' : 'Window · available while typing'
    case 'terminal': return 'Terminal · when a terminal has focus'
    case 'editor': return 'Editor · when an editor has focus'
    case 'launcher': return 'Start page · in the prompt input'
    case 'message-tool': return 'Message Tool · in the message editor or its suggestion list'
  }
}

function searchableChord(row: CheatSheetRow): string {
  return row.keys.map(token => token === '⌘' ? '⌘ cmd command' : token === '⌥' ? '⌥ alt option' : token === '⇧' ? '⇧ shift' : token).join(' ')
}

export function KeyboardShortcutsPane({ group: groupId }: { group?: CheatSheetGroupId } = {}) {
  const [query, setQuery] = useState('')
  const [selectedGroup, setSelectedGroup] = useState<CheatSheetGroupId | null>(null)
  const search = useRef<HTMLInputElement>(null)
  const isMac = isMacPlatform()
  const [captureStatus, setCaptureStatus] = useState<ScreenshotShortcutStatus | null>(null)
  useEffect(() => {
    let current = true
    if (isMac) void api.ui.screenshotShortcutStatus().then(status => { if (current) setCaptureStatus(status) }, error => {
      if (current) setCaptureStatus({ state: 'unavailable', accelerator: '', message: `Shortcut registration could not be observed: ${String(error)}. The Capture button remains available.` })
    })
    return () => { current = false }
  }, [isMac])
  const groups = useMemo(() => buildCheatSheet(isMac).filter(group => !groupId || group.id === groupId), [isMac, groupId])
  const terms = query.trim().toLowerCase().split(/[+\s]+/).filter(Boolean)
  const visible = groups.filter(group => groupId || !selectedGroup || group.id === selectedGroup).map(group => ({ ...group, rows: group.rows.filter(row => {
    const text = `${row.label} ${row.description ?? ''} ${searchableChord(row)} ${group.title}`.toLowerCase()
    return terms.every(term => text.includes(term))
  }) })).filter(group => group.rows.length > 0)
  const count = visible.reduce((total, group) => total + group.rows.length, 0)
  function clearSearch(): void { setQuery(''); search.current?.focus() }

  return <div className="keyboard-shortcuts" data-keyboard-shortcuts>
    <div className="keyboard-shortcuts__intro"><p>Shortcuts for {isMac ? 'macOS' : 'this platform'}. These bindings are read-only.</p></div>
    <div className="keyboard-shortcuts__tools">
      <label className="keyboard-shortcuts__search"><ThemeActionSearchIcon size={14} aria-hidden="true" /><TextInput ref={search} aria-label="Find a command or shortcut" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a command or shortcut" />{query ? <button type="button" aria-label="Clear shortcut search" onClick={clearSearch}><ThemeActionClearIcon size={13} /></button> : null}</label>
      <span className="keyboard-shortcuts__count" role="status">{count} {count === 1 ? 'binding' : 'bindings'}</span>
    </div>
    {!groupId ? <div className="keyboard-shortcuts__contexts" aria-label="Shortcut context">
      <button type="button" aria-pressed={selectedGroup === null} onClick={() => setSelectedGroup(null)}>All contexts</button>
      {groups.map(group => <button key={group.id} type="button" aria-pressed={selectedGroup === group.id} onClick={() => setSelectedGroup(group.id)}>{group.title}</button>)}
    </div> : null}
    {count === 0 ? <div className="keyboard-shortcuts__empty"><p>No shortcuts match “{query}”.</p><button type="button" className="small-button" onClick={clearSearch}>Clear search</button></div> : null}
    {visible.map(group => <section key={group.id} className="keyboard-shortcuts__group" data-shortcut-group={group.id}>
      {!groupId ? <header><h3>{group.title}</h3><p>{scopeDescription(bindingById(group.rows[0]!.id)!)}</p></header> : null}
      <ul>{group.rows.map(row => <li key={row.id} data-binding-id={row.id} data-tab-selection={row.id.startsWith('workbench.select-tab.') || undefined}>
        <span className="keyboard-shortcuts__label">{row.label}{row.description ? <small>{row.description}</small> : null}{row.id === SCREENSHOT_SHORTCUT.id ? <small role="status">{captureStatus?.state === 'registered' ? 'Registered with macOS' : captureStatus?.message ?? 'Checking system shortcut registration…'}</small> : null}</span><span className="keyboard-shortcuts__chord">{row.keys.map((token, index) => <kbd key={index}>{token}</kbd>)}</span>
      </li>)}</ul>
    </section>)}
  </div>
}
