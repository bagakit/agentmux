import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { SCRATCH_WORKSPACE_ID } from '../../../../shared/scratch-topics'
import { openTopicDirectory } from '../../lib/topic-directory-navigation'
import { useAppStore } from '../../store'
import type { SettingsPaneProps } from './settings-catalog'
import topicArt from '../../assets/settings/topic-atlas.png'
import promotionArt from '../../assets/settings/promotion-identity.png'
import './settings-concept-intro.css'
import '../../styles/settings-workflows.css'

const OpenIcon = semanticIconComponent('action.open-external')

/** Discovery only; content and promotion stay on the original Topic workface. */
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
    <section className="settings-group">
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
  </div>
}
