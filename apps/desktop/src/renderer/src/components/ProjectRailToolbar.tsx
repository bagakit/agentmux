import { Settings2 } from 'lucide-react'
import type { SettingsSectionId } from './SettingsPanel'

type ProjectRailToolbarProps = {
  collapsed?: boolean
  onOpenSettings: (section: SettingsSectionId) => void
}

// One gear, labelled "Settings". The two buttons this replaced (Settings + Hosts) opened the SAME
// panel; Hosts is a child section of Settings, already reachable from the panel's sidebar nav, so a
// co-equal button was the same door twice. The collapsed rail already showed only one button, the
// Welcome empty state carries a contextual "Configure a host" primary at the moment it's needed, and a
// fast path — if ever wanted — belongs on this gear's context menu, not a second toolbar button.
function SettingsButton({
  onOpenSettings
}: {
  onOpenSettings: (section: SettingsSectionId) => void
}) {
  return (
    <button
      className="icon-button project-rail-toolbar__button"
      type="button"
      aria-label="Settings"
      title="Settings"
      data-settings-section="workspaces"
      onClick={() => onOpenSettings('workspaces')}
    >
      <Settings2 size={13} />
    </button>
  )
}

export function ProjectRailToolbar({
  collapsed = false,
  onOpenSettings
}: ProjectRailToolbarProps) {
  if (collapsed) {
    return (
      <div className="project-rail-corner-toolbar" data-project-rail-corner-toolbar>
        <SettingsButton onOpenSettings={onOpenSettings} />
      </div>
    )
  }

  return (
    <footer className="project-rail-toolbar" role="toolbar" aria-label="Project rail tools">
      <div className="project-rail-toolbar__group">
        <SettingsButton onOpenSettings={onOpenSettings} />
      </div>
    </footer>
  )
}
