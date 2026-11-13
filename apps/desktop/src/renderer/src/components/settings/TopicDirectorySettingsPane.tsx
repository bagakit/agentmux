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

/** Global initial-view preference only; content and promotion keep their original owners. */
export function TopicDirectorySettingsPane({ config, onClose, promotion = false }: Pick<SettingsPaneProps, 'config' | 'onClose'> & { promotion?: boolean }) {
  const workspace = config.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID)
  return <div className="settings-pane-stack">
    <section className="settings-concept-intro" aria-label={promotion ? 'Promotion' : 'Topic'}>
      <div className="settings-concept-intro__copy">
        <h3 className="settings-concept-intro__title">{promotion ? 'Let important work become a lasting collaborator.' : 'Build knowledge around a Topic.'}</h3>
        <p className="settings-concept-intro__description">{promotion
          ? 'Start with a Topic. Keep its discussions, knowledge and Agents while developing a shared Mote identity and roles.'
          : 'Bring related discussions, sources and discoveries into one Topic, with context you can return to.'}</p>
      </div>
      <div className="settings-concept-intro__art" aria-hidden="true"><img src={promotion ? promotionArt : topicArt} alt="" loading="lazy" decoding="async" draggable={false} /></div>
    </section>
    {!promotion ? <TopicInitialViewSettings config={config} /> : null}
    <section className="settings-group" data-settings-field="topic-directory">
      <header><span>{promotion ? 'Promote from a Topic' : 'Topic directory'}</span></header>
      <p className="settings-workflows__note">{promotion
        ? 'Open the Topic directory, choose Promote to Mote from the Topic menu, then review and confirm.'
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
      <header><span>Configure each Mote</span><small>Per Mote</small></header>
      <p className="settings-workflows__note">Promotion keeps the same Topic, Agents, conversations and knowledge. Choose that Mote in Club to edit its own settings.</p>
      <dl>
        <div><dt>Profile</dt><dd>Name, role, appearance, personality and connected application.</dd></div>
        <div><dt>Quick mode</dt><dd>Main Agent, Executor for new chats and when to reconnect.</dd></div>
      </dl>
      <div className="settings-workflows__inline-action">
        <p className="settings-workflows__note">Settings apply to the selected Mote.</p>
        <button type="button" className="small-button" data-open-mote-club onClick={() => { onClose(); requestPmoTeamsTopicFloatingOpen() }}>Open Mote Club</button>
      </div>
    </section> : null}
  </div>
}
