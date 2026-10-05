import { semanticIconComponent } from '@agentmux/client-ui/icons'
import '../../styles/settings-workflows.css'

const ThemeActionOpenExternalIcon = semanticIconComponent('action.open-external')


/** A shortcut to the original content owner, without a second settings or data model. */
export function SettingsManagementPane({ title, description, actionLabel, onOpen }: {
  title: string
  description: string
  actionLabel: string
  onOpen(): void
}) {
  return <div className="settings-pane-stack">
    <section className="settings-group">
      <header><span>{title}</span></header>
      <div className="settings-workflows__inline-action">
        <p className="settings-workflows__note">{description}</p>
        <button type="button" className="small-button" onClick={onOpen}>{actionLabel}<ThemeActionOpenExternalIcon size={14} aria-hidden="true" /></button>
      </div>
    </section>
  </div>
}
