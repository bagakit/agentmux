import { ArrowUpRight, FolderOpen, Layers3, Search, Users } from 'lucide-react'
import { PROJECT_RAIL_DENSITY_DEFAULT, PROJECT_RAIL_DENSITY_IDS, type ProjectRailDensity } from '../../../../shared/contracts'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraft } from './use-setting-draft'
import '../../styles/settings-workflows.css'

const DENSITY_LABELS = { default: 'Comfortable', compact: 'Compact', dense: 'Dense' } as const
export const projectRailDensityLabel = (value: ProjectRailDensity | undefined): string => DENSITY_LABELS[value ?? PROJECT_RAIL_DENSITY_DEFAULT]

export function SpaceSettingsPane({ density, onSave, onMotes, onTopics, onProjects, onSurvey }: {
  density: ProjectRailDensity | undefined
  onSave(value: ProjectRailDensity, expected: ProjectRailDensity): Promise<void>
  onMotes(): void; onTopics(): void; onProjects(): void; onSurvey(): void
}) {
  const saved = density ?? PROJECT_RAIL_DENSITY_DEFAULT
  const draft = useSettingDraft(saved), saveState = useSettingsSave()
  async function save(): Promise<void> {
    const submitted = draft.beginSave()
    submitted.finish(await saveState.run(() => onSave(submitted.value, submitted.expected)))
  }
  const destinations = [
    { id: 'motes', label: 'Mote Club', description: 'Manage collaborators; choose a Mote to edit its profile, role and SOUL.', icon: Users, open: onMotes },
    { id: 'topics', label: 'Topics in Space', description: 'Open your workspace to manage topics and their content.', icon: Layers3, open: onTopics },
    { id: 'projects', label: 'Projects in Environments', description: 'Manage registered folders and worktrees on each Host.', icon: FolderOpen, open: onProjects },
    { id: 'survey', label: 'Survey', description: 'Open the research workspace to manage notebooks and explorations.', icon: Search, open: onSurvey }
  ]
  return <div className="settings-pane-stack">
    <section className="settings-group">
      <header><span>Project rail</span><small>Saved: {projectRailDensityLabel(saved)}</small></header>
      <fieldset className="settings-workflows__density"><legend>Project rail density</legend>
        {PROJECT_RAIL_DENSITY_IDS.map(value => <label key={value} data-selected={draft.value === value}>
          <span className="settings-workflows__rail-preview" data-density={value} aria-hidden="true">
            {[0, 1, 2].map(row => <span key={row}><i /><b /></span>)}
          </span>
          <span className="settings-workflows__choice"><input type="radio" name="space-rail-density" value={value} checked={draft.value === value} onChange={() => draft.setValue(value)} />{projectRailDensityLabel(value)}</span>
        </label>)}
      </fieldset>
      <p className="settings-workflows__note">Fits more projects into the sidebar. Your projects, topics and layouts stay in place.</p>
    </section>
    <section className="settings-group">
      <header><span>Manage your work</span><small>Object settings</small></header>
      <div className="settings-workflows__destinations">{destinations.map(({ id, label, description, icon: Icon, open }) =>
        <button key={id} type="button" data-workflows-manage={id} onClick={open}>
          <Icon size={17} aria-hidden="true" /><span><strong>{label}</strong><small>{description}</small></span><ArrowUpRight size={14} aria-hidden="true" />
        </button>)}</div>
    </section>
    <SettingsSaveBar save={saveState} dirty={draft.dirty} onSave={() => void save()} />
  </div>
}
