import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useState } from 'react'
import type { AppConfig } from '../../../../shared/contracts'
import type { SettingsModule, SettingsNavGroup } from './settings-catalog'
import bannerUrl from '../../../../../resources/settings-banner.png'

const ThemeNavigationDisclosureIcon = semanticIconComponent('navigation.disclosure')


/** Presentation only. The parent passes published configuration and the original section catalog. */
export function SettingsOverviewPane<Module extends SettingsModule>({ config, groups, onOpen, active = true }: {
  config: AppConfig
  groups: SettingsNavGroup<Module>[]
  onOpen: (section: Module['id']) => void
  active?: boolean
}) {
  const shortcuts = groups.flatMap(group => group.items)
    .filter(item => item.overviewShortcut !== undefined)
    .sort((left, right) => left.overviewShortcut! - right.overviewShortcut!)
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    if (!active) return
    const onVisibilityChange = () => setDocumentVisible(document.visibilityState !== 'hidden')
    onVisibilityChange()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [active])

  return (
    <div className="settings-content__scroll settings-overview" data-settings-overview data-document-visible={active && documentVisible}>
      <div className="settings-overview__hero">
        <img className="settings-overview__art" src={bannerUrl} alt="" aria-hidden="true" onError={(event) => { event.currentTarget.hidden = true }} />
        <span className="settings-overview__sweep" aria-hidden="true" />
        <div className="settings-overview__identity"><strong>AgentMux</strong><p>Configure your agents, tools<br />and workspace.</p></div>
      </div>
      <section className="settings-overview__shortcuts" aria-label="Quick access">
        {shortcuts.map(item => {
          const Icon = item.icon
          return <button key={item.id} type="button" className="settings-overview__shortcut" data-settings-shortcut={item.id} data-settings-target={item.id} onClick={() => onOpen(item.id)}>
            <Icon size={20} aria-hidden="true" />
        <span><strong>{item.title}</strong><small title={item.savedSummary(config)}>{item.savedSummary(config)}</small></span>
            <ThemeNavigationDisclosureIcon size={14} aria-hidden="true" />
          </button>
        })}
      </section>
      <div className="settings-overview__directory-heading"><h3>All settings</h3></div>
      <div className="settings-overview__groups" data-settings-directory>
          {groups.map((group) => <section key={group.id} data-settings-group={group.id} className="settings-overview__group" data-standalone={'standalone' in group || undefined} aria-label={'standalone' in group ? group.title : undefined} aria-labelledby={'standalone' in group ? undefined : `settings-overview-${group.id}`}>
            {'standalone' in group ? null : <header>
              <h3 id={`settings-overview-${group.id}`}>{group.title}</h3><p>{group.description}</p>
            </header>}
            <div className="settings-overview__entries">
              {group.items.map((item) => {
                const Icon = item.icon
                return <button key={item.id} type="button" className="settings-overview__entry" title={item.description} data-settings-section={item.id} data-settings-target={item.id} onClick={() => onOpen(item.id)}>
                  <Icon size={16} aria-hidden="true" />
                  <span className="settings-overview__entry-label"><strong>{item.title}</strong>{'standalone' in group ? <small>{item.description}</small> : null}</span>
                  <span className="settings-overview__summary">{item.savedSummary(config)}</span>
                  <ThemeNavigationDisclosureIcon size={14} aria-hidden="true" />
                </button>
              })}
            </div>
          </section>)}
      </div>
    </div>
  )
}
