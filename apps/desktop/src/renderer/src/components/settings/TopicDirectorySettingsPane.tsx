import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { SCRATCH_WORKSPACE_ID } from '../../../../shared/scratch-topics'
import { openTopicDirectory } from '../../lib/topic-directory-navigation'
import { useAppStore } from '../../store'
import type { SettingsPaneProps } from './settings-catalog'
import { TOPIC_DIRECTORY_INITIAL_VIEW_DEFAULT, TOPIC_DIRECTORY_INITIAL_VIEW_IDS, type TopicDirectoryInitialView } from '../../../../shared/contracts'
import { api } from '../../lib/api'
import { requestPmoTeamsTopicFloatingOpen } from '../../lib/pmo-teams-topic-floating'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraft } from './use-setting-draft'
import topicArt from '../../assets/settings/topic-atlas.png'
import promotionArt from '../../assets/settings/promotion-identity.png'
import './settings-concept-intro.css'
import '../../styles/settings-workflows.css'
import './settings-topic.css'

const OpenIcon = semanticIconComponent('action.open-external')

function TopicInitialViewSettings({ config }: Pick<SettingsPaneProps, 'config'>) {
  const saved = config.topicDirectoryInitialView ?? TOPIC_DIRECTORY_INITIAL_VIEW_DEFAULT
  const draft = useSettingDraft<TopicDirectoryInitialView>(saved), save = useSettingsSave()
  async function commit(): Promise<void> {
    const submitted = draft.beginSave()
    submitted.finish(await save.run(async () => {
      await api.config.save({ ...config, topicDirectoryInitialView: submitted.value },
        { ...config, topicDirectoryInitialView: submitted.expected })
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
    <SettingsSaveBar save={save} dirty={draft.dirty} label="Save Topic default" onSave={() => void commit()} />
  </section>
}

/** Global initial-view preference only; content and promotion keep their original owners. */
export function TopicDirectorySettingsPane({ config, onClose, promotion = false }: Pick<SettingsPaneProps, 'config' | 'onClose'> & { promotion?: boolean }) {
  const workspace = config.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID)
  return <div className="settings-pane-stack">
    <section className="settings-concept-intro" aria-label={promotion ? 'Promotion' : 'Topic'}>
      <div className="settings-concept-intro__copy">
        <h3 className="settings-concept-intro__title">{promotion ? '让重要的方向，成为长期伙伴。' : '围绕一个主题，积累知识。'}</h3>
        <p className="settings-concept-intro__description">{promotion
          ? '从已有 Topic 出发，保留其中的讨论、知识与 Agent，逐步建立 Mote 的人格与分工。'
          : '把相关讨论、资料和发现放在同一个 Topic 中，让每次探索都有可继续的上下文。'}</p>
      </div>
      <div className="settings-concept-intro__art" aria-hidden="true"><img src={promotion ? promotionArt : topicArt} alt="" loading="lazy" decoding="async" draggable={false} /></div>
    </section>
    {!promotion ? <TopicInitialViewSettings config={config} /> : null}
    <section className="settings-group" data-settings-field="topic-directory">
      <header><span>{promotion ? '从 Topic 晋升' : 'Topic 目录'}</span></header>
      <p className="settings-workflows__note">{promotion
        ? '打开 Topic 目录，在要延续的 Topic 菜单中选择「晋升为 Mote」，查看说明后确认。'
        : '在目录中管理分类与 Topic，继续讨论、整理知识，或打开相关文件。'}</p>
      {workspace ? <button type="button" className="small-button" data-open-topic-directory onClick={() => {
        onClose()
        void openTopicDirectory(workspace).catch(useAppStore.getState().reportError)
      }}>打开 Topic 目录<OpenIcon size={14} aria-hidden="true" /></button> : <>
        <p className="settings-workflows__note" role="status">Topic 目录尚未就绪。可以回到 Space 查看原工作面。</p>
        <button type="button" className="small-button" onClick={() => { onClose(); useAppStore.getState().setMainSurface('workbench') }}>打开 Space<OpenIcon size={14} aria-hidden="true" /></button>
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
        <button type="button" className="small-button" data-open-mote-club onClick={() => { onClose(); requestPmoTeamsTopicFloatingOpen() }}>Open Mote Club<OpenIcon size={14} aria-hidden="true" /></button>
      </div>
    </section> : null}
  </div>
}
