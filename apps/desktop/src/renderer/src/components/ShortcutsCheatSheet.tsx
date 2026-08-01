import { Command, X } from 'lucide-react'
import { buildCheatSheet } from '../lib/shortcut-cheat-sheet'

// The window's one discoverability surface: a read-only list of every keyboard binding, summoned by a
// keystroke (help.shortcuts) that itself appears on the list. Because the app deliberately strips the
// Electron menu's accelerators (main/application-menu.ts) there is no menu to discover shortcuts from — so
// this panel is the only way a user learns what they can press.
//
// It is a plain conditional overlay, NOT a Radix Dialog: the panel is read-only (no field to focus-trap),
// and this repo's component tests render with renderToStaticMarkup, under which Radix's Portal renders
// nothing at all — a dialog body would be invisible to the only render path the guards have. Every row is
// projected from the registry via buildCheatSheet; this component declares no binding and no key of its own.
export function ShortcutsCheatSheet({
  open,
  onClose,
  isMac
}: {
  open: boolean
  onClose: () => void
  isMac: boolean
}) {
  if (!open) return null
  const groups = buildCheatSheet(isMac)
  return (
    <div className="shortcuts-help__overlay" role="presentation" onClick={onClose}>
      <div
        className="shortcuts-help"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="shortcuts-help__head">
          <span className="shortcuts-help__mark"><Command size={16} /></span>
          <div>
            <h2>Keyboard shortcuts</h2>
            <p>Every shortcut on this build, for {isMac ? 'macOS' : 'this platform'}.</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close keyboard shortcuts"><X size={16} /></button>
        </header>
        <div className="shortcuts-help__groups">
          {groups.map((group) => (
            <section key={group.id} className="shortcuts-help__group" data-group={group.id}>
              <h3>{group.title}</h3>
              <ul>
                {group.rows.map((row) => (
                  <li key={row.id} data-binding-id={row.id}>
                    <span className="shortcuts-help__label">{row.label}</span>
                    <span className="shortcuts-help__chord">
                      {row.keys.map((token, index) => (
                        <kbd key={index}>{token}</kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
