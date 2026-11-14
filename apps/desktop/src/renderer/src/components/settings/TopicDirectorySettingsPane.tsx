import { Switch } from '@agentmux/client-ui/input'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { openTopicDirectory } from '../../lib/topic-directory-navigation'
import { useAppStore } from '../../store'
import type { SettingsPaneProps } from './settings-catalog'
import { TOPIC_DIRECTORY_INITIAL_VIEW_DEFAULT, TOPIC_DIRECTORY_INITIAL_VIEW_IDS, type TopicDirectoryInitialView } from '../../../../shared/contracts'
import { requestPmoTeamsTopicFloatingOpen } from '../../lib/pmo-teams-topic-floating'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraft } from './use-setting-draft'
import topicArt from '@agentmux/client-ui/brand/illustrations/concepts/topic-atlas.png'
import promotionArt from '@agentmux/client-ui/brand/illustrations/concepts/promotion-identity.png'
import './settings-concept-intro.css'
import '../../styles/settings-workflows.css'
import './settings-topic.css'
import { saveConfigSlice } from './save-config-slice'

function TopicInitialViewSettings({ config }: Pick<SettingsPaneProps, 'config'>) {
  const saved = config.topicDirectoryInitialView ?? TOPIC_DIRECTORY_INITIAL_VIEW_DEFAULT
  const draft = useSettingDraft<TopicDirectoryInitialView>(saved), save = useSettingsSave()
  async function commit(): Promise<void> {
    const submitted = draft.beginSave()
    submitted.finish(await save.run(async () => {
      await saveConfigSlice((current, value: TopicDirectoryInitialView) => ({ ...current, topicDirectoryInitialView: value }), submitted.value, submitted.expected)
    }))
  }
  return <section className="settings-group settings-topic-default" data-settings-field="topic-directory-initial-view">
    <header><span>Initial directory view</span><small>Saved: {saved === 'knowledge' ? 'Knowledge' : 'Topics'}</small></header>
    <fieldset className="settings-topic-default__choices" aria-label="Initial Topic directory view">
      {TOPIC_DIRECTORY_INITIAL_VIEW_IDS.map(value => <label key={value} data-selected={draft.value === value}>
        <input type="radio" name="topic-directory-initial-view" value={value} checked={draft.value === value} onChange={() => draft.setValue(value)} />
        <span><strong>{value === 'topics' ? 'Topics' : 'Knowledge'}</strong><small>{value === 'topics' ? 'Browse categories and discussions' : 'Search and read saved knowledge'}</small></span>
      </label>)}
    </fieldset>
    <p className="settings-workflows__note">Applies when a new Topic directory panel opens. Your current view, selection and reading position stay as you left them.</p>
    <SettingsSaveBar save={save} dirty={draft.dirty} resolution={draft} label="Save Topic default" onSave={() => void commit()} />
  </section>
}

function PromotionSettings({ config }: Pick<SettingsPaneProps, 'config'>) {
  const saved = config.promotion?.enabled ?? true
  const draft = useSettingDraft(saved), save = useSettingsSave()
  async function commit(): Promise<void> {
    const submitted = draft.beginSave()
    submitted.finish(await save.run(async () => {
      await saveConfigSlice((current, enabled: boolean) => ({ ...current, promotion: { ...current.promotion, enabled } }), submitted.value, submitted.expected)
    }))
  }
  return <section className="settings-group settings-promotion-policy" data-settings-field="promotion.enabled">
    <header><span>Promotion</span><small>Saved: {saved ? 'Allowed' : 'Off'}</small></header>
    <label className="settings-promotion-policy__toggle">
      <span><strong>Allow promotion</strong><small>Allow new Clubs and Agent membership through the original Promotion actions.</small></span>
      <Switch aria-label="Allow promotion" checked={draft.value} onChange={event => draft.setValue(event.target.checked)} />
    </label>
    <p className="settings-workflows__note">Turning this off prevents new promotions. Existing Clubs and unfinished operations remain available, and Agents keep working.</p>
    <SettingsSaveBar save={save} dirty={draft.dirty} resolution={draft} label="Save Promotion settings" onSave={() => void commit()} />
  </section>
}

/** Each preference saves through the original ConfigOwner; per-Mote files remain in Club. */
export function TopicDirectorySettingsPane({ config, onClose, promotion = false }: Pick<SettingsPaneProps, 'config' | 'onClose'> & { promotion?: boolean }) {
  const workspace = config.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID)
  return <div className="settings-pane-stack">
    <section className="settings-concept-intro" aria-label={promotion ? 'Promotion' : 'Topic'}>
      <div className="settings-concept-intro__copy">
        <h3 className="settings-concept-intro__title">{promotion ? 'Let important work become a lasting collaborator.' : 'Build knowledge around a Topic.'}</h3>
        <p className="settings-concept-intro__description">{promotion
          ? 'A Mote Club holds a team identity and main conversation. A Mote Thread carries an Agent’s work within that Club.'
          : 'Bring related discussions, sources and discoveries into one Topic, with context you can return to.'}</p>
      </div>
      <div className="settings-concept-intro__art" aria-hidden="true"><img src={promotion ? promotionArt : topicArt} alt="" loading="lazy" decoding="async" draggable={false} /></div>
    </section>
    {promotion ? <PromotionSettings config={config} /> : <TopicInitialViewSettings config={config} />}
    {promotion ? <section className="settings-group" data-settings-field="agent-promotion">
      <header><span>Agent → Mote Thread</span></header>
      <p className="settings-workflows__note">Choose an existing Club for a new Agent to take over the original work as a Thread; creating a new Club is a separate team-level choice.</p>
    </section> : null}
    <section className="settings-group" data-settings-field="topic-directory">
      <header><span>{promotion ? 'Topic → Mote Club' : 'Topic directory'}</span></header>
      <p className="settings-workflows__note">{promotion
        ? 'Choose “Promote to Mote Club…” from the Topic menu. The same Agents, conversations and knowledge continue in the Club.'
        : 'Manage categories and Topics, continue discussions, organize knowledge or open related files.'}</p>
      {workspace ? <button type="button" className="small-button" data-open-topic-directory onClick={() => {
        onClose()
        void openTopicDirectory(workspace).catch(useAppStore.getState().reportError)
      }}>Open Topic directory</button> : <>
        <p className="settings-workflows__note" role="status">The Topic directory is not ready. Your existing work is available in Space.</p>
        <button type="button" className="small-button" onClick={() => { onClose(); useAppStore.getState().setMainSurface('workbench') }}>Open Space</button>
      </>}
    </section>
    {promotion ? <section className="settings-group settings-topic-configuration" data-settings-field="mote-configuration">
      <header><span>Each Club’s settings</span><small>Per Club</small></header>
      <p className="settings-workflows__note">Choose the original Club in Clubs to edit its own profile and cooperation settings.</p>
      <dl>
        <div><dt>Profile</dt><dd>Name, role, appearance, personality and connected application.</dd></div>
        <div><dt>Quick mode</dt><dd>Main Agent, Executor for new chats and automatic maintenance.</dd></div>
      </dl>
      <div className="settings-workflows__inline-action">
        <p className="settings-workflows__note">Settings apply to the selected Club.</p>
        <button type="button" className="small-button" data-open-mote-club onClick={() => { onClose(); requestPmoTeamsTopicFloatingOpen() }}>Open Clubs</button>
      </div>
    </section> : null}
    {promotion ? <section className="settings-group" data-settings-field="agent-transfer">
      <header><span>Continue work through Takeover</span></header>
      <p className="settings-workflows__note">Promotion (Project → Club), Handson (Club → Project) and transfers between Projects or Clubs use the same Takeover at the new location. A new Agent continues the work; the original location, membership and Main remain.</p>
    </section> : null}
  </div>
}
