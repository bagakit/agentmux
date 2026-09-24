import { ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AppConfig } from '../../../../shared/contracts'
import type { SettingsModule, SettingsNavGroup } from './settings-catalog'
import bannerUrl from '../../../../../resources/settings-banner.png'

/** Presentation only. The parent passes published configuration and the original section catalog. */
export function SettingsOverviewPane<Module extends SettingsModule>({ config, groups, onOpen }: {
  config: AppConfig
  groups: SettingsNavGroup<Module>[]
  onOpen: (section: Module['id']) => void
}) {
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const onVisibilityChange = () => setDocumentVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [])

  return (
    <div className="settings-content__scroll settings-overview" data-settings-overview data-document-visible={documentVisible}>
      <div className="settings-overview__hero">
        <img className="settings-overview__art" src={bannerUrl} alt="" aria-hidden="true" onError={(event) => { event.currentTarget.hidden = true }} />
        <span className="settings-overview__sweep" aria-hidden="true" />
        <div className="settings-overview__identity"><strong>AgentMux</strong><p>Your agent workspace.</p></div>
      </div>
      <div className="settings-overview__groups">
        {groups.map((group) => <section key={group.id} className="settings-overview__group" aria-labelledby={`settings-overview-${group.id}`}>
          <header><h3 id={`settings-overview-${group.id}`}>{group.title}</h3><small>Saved configuration</small></header>
          <div className="settings-overview__entries">
            {group.items.map((item) => {
              const Icon = item.icon
              return <button key={item.id} type="button" className="settings-overview__entry" title={item.description} data-settings-section={item.id} data-settings-target={item.id} onClick={() => onOpen(item.id)}>
                <Icon size={16} aria-hidden="true" />
                <span className="settings-overview__entry-label"><strong>{item.title}</strong></span>
                <span className="settings-overview__summary">{item.savedSummary(config)}</span>
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            })}
          </div>
        </section>)}
      </div>
    </div>
  )
}
