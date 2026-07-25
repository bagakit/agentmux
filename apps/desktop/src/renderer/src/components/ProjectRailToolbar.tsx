import { Server, Settings2 } from 'lucide-react'
import type { SettingsSectionId } from './SettingsPanel'

type ProjectRailToolbarProps = {
  collapsed?: boolean
  onOpenSettings: (section: SettingsSectionId) => void
}

function SettingsButton({
  section,
  label,
  onOpenSettings
}: {
  section: 'workspaces' | 'hosts'
  label: string
  onOpenSettings: (section: SettingsSectionId) => void
}) {
  const Icon = section === 'hosts' ? Server : Settings2
  return (
    <button
      className="icon-button project-rail-toolbar__button"
      type="button"
      aria-label={label}
      title={label}
      data-settings-section={section}
      onClick={() => onOpenSettings(section)}
    >
      <Icon size={13} />
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
        <SettingsButton section="workspaces" label="Settings" onOpenSettings={onOpenSettings} />
      </div>
    )
  }

  return (
    <footer className="project-rail-toolbar" role="toolbar" aria-label="Project rail tools">
      <div className="project-rail-toolbar__group">
        <SettingsButton section="workspaces" label="Settings" onOpenSettings={onOpenSettings} />
        <SettingsButton section="hosts" label="Hosts" onOpenSettings={onOpenSettings} />
      </div>
    </footer>
  )
}
