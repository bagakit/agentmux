import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { PROJECT_RAIL_DENSITY_DEFAULT, PROJECT_RAIL_DENSITY_IDS, type ProjectRailDensity } from '../../../../shared/contracts'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraftRecord } from './use-setting-draft'
import { SpaceIntroduction } from './SettingsConceptIntro'
import '../../styles/settings-workflows.css'
import '../../styles/settings-workview-layout.css'

const ThemeObjectTopicIcon = semanticIconComponent('object.topic')
const ThemeObjectFolderOpenIcon = semanticIconComponent('object.folder-open')
const ThemeActionOpenExternalIcon = semanticIconComponent('action.open-external')


const DENSITY_LABELS = { default: 'Comfortable', compact: 'Compact', dense: 'Dense' } as const
export const projectRailDensityLabel = (value: ProjectRailDensity | undefined): string => DENSITY_LABELS[value ?? PROJECT_RAIL_DENSITY_DEFAULT]

export type SpacePreferences = { projectRailDensity: ProjectRailDensity; gitHistoryShowTime: boolean }

export function SpaceSettingsPane({ density, showHistoryTime, onSave, onTopics, onProjects }: {
  density: ProjectRailDensity | undefined
  showHistoryTime: boolean | undefined
  onSave(value: SpacePreferences, expected: SpacePreferences): Promise<void>
  onTopics(): void; onProjects(): void
}) {
  const saved = density ?? PROJECT_RAIL_DENSITY_DEFAULT
  const draft = useSettingDraftRecord({ projectRailDensity: saved, gitHistoryShowTime: showHistoryTime !== false }), saveState = useSettingsSave()
  async function save(): Promise<void> {
    const submitted = draft.beginSave()
    submitted.finish(await saveState.run(() => onSave(submitted.value, submitted.expected)))
  }
  const destinations = [
    { id: 'topics', label: 'Topics in Space', description: 'Open your workspace to manage topics and their content.', icon: ThemeObjectTopicIcon, open: onTopics },
    { id: 'projects', label: 'Projects in Hosts', description: 'Manage registered folders and worktrees on each Host.', icon: ThemeObjectFolderOpenIcon, open: onProjects },
  ]
  return <div className="settings-pane-stack settings-space">
    <SpaceIntroduction />
    <section className="settings-group" data-settings-field="project-rail">
      <header><span>Project rail</span><small>Saved: {projectRailDensityLabel(saved)}</small></header>
      <fieldset className="settings-workflows__density"><legend>Project rail density</legend>
        {PROJECT_RAIL_DENSITY_IDS.map(value => <label key={value} data-selected={draft.value.projectRailDensity === value}>
          <span className="settings-workflows__rail-preview" data-density={value} aria-hidden="true">
            {['Workspace', 'Research', 'Tools'].map(name => <span key={name}><ThemeObjectFolderOpenIcon size={11} /><span>{name}</span></span>)}
          </span>
          <span className="settings-workflows__choice"><input type="radio" name="space-rail-density" value={value} checked={draft.value.projectRailDensity === value} onChange={() => draft.setField('projectRailDensity', value)} />{projectRailDensityLabel(value)}</span>
        </label>)}
      </fieldset>
      <p className="settings-workflows__note">Fits more projects into the sidebar. Your projects, topics and layouts stay in place.</p>
    </section>
    <section className="settings-group" data-settings-field="git-history-time">
      <header><span>Git History</span><small>Saved: {showHistoryTime !== false ? 'Time shown' : 'Time hidden'}</small></header>
      <label className="browser-automation-toggle">
        <input type="checkbox" aria-label="Show commit time" checked={draft.value.gitHistoryShowTime} onChange={event => draft.setField('gitHistoryShowTime', event.target.checked)} />
        <span><strong>Show commit time</strong><small>Show recorded author time beside each commit in the history tree.</small></span>
      </label>
      <div className="settings-space__commit" aria-label="Git History display preview"><span>Example commit</span><div><code>a1b2c3d</code><strong>Refine project navigation</strong>{draft.value.gitHistoryShowTime && <time>{[10, 42].map(value => String(value).padStart(2, '0')).join(':')}</time>}</div></div>
    </section>
    <section className="settings-group">
      <header><span>Manage your work</span><small>Object settings</small></header>
      <div className="settings-workflows__destinations">{destinations.map(({ id, label, description, icon: Icon, open }) =>
        <button key={id} type="button" data-workflows-manage={id} onClick={open}>
          <Icon size={17} aria-hidden="true" /><span><strong>{label}</strong><small>{description}</small></span><ThemeActionOpenExternalIcon size={14} aria-hidden="true" />
        </button>)}</div>
    </section>
    <SettingsSaveBar save={saveState} dirty={draft.dirty} onSave={() => void save()} />
  </div>
}
