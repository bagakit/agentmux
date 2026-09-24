import { ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AppConfig } from '../../../../shared/contracts'
import { APP_APPEARANCE_DEFAULT, TERMINAL_FONT_SIZE_DEFAULT } from '../../../../shared/contracts'
import { resolveComposerShortcuts } from '../../../../shared/composer-shortcut-library'
import { NOTIFICATION_TIERS, resolveNotificationModeId, resolveNotificationSound } from '../../../../shared/notification-presentation'
import bannerUrl from '../../../../../resources/settings-banner.png'
import type { settingsNavGroups, SettingsSectionId } from '../SettingsPanel'

function savedSummary(section: SettingsSectionId, config: AppConfig): string {
  switch (section) {
    case 'appearance': {
      const mode = config.appearance.appAppearance ?? APP_APPEARANCE_DEFAULT
      return `${mode[0]!.toUpperCase()}${mode.slice(1)} · ${config.appearance.terminalFontSize ?? TERMINAL_FONT_SIZE_DEFAULT}px`
    }
    case 'notifications': {
      const mode = resolveNotificationModeId(config)
      const tier = NOTIFICATION_TIERS.find((candidate) => candidate.id === mode)!
      return mode === 'off' ? tier.label : `${tier.label} · ${resolveNotificationSound(config) ? 'Sound on' : 'Silent'}`
    }
    case 'browser': return config.browser.agentAutomation === true ? 'Automation on' : 'Automation off'
    case 'general': return config.copyPathsAsAbsolute === true ? 'Absolute paths' : 'Home paths (~)'
    case 'agents': {
      const count = Object.keys(config.executors).length
      return `${count} ${count === 1 ? 'executor' : 'executors'}`
    }
    case 'prompts': {
      const count = resolveComposerShortcuts(config).length
      return `${count} ${count === 1 ? 'prompt' : 'prompts'}`
    }
    case 'workspaces': return `${config.workspaces.length} ${config.workspaces.length === 1 ? 'workspace' : 'workspaces'}`
    case 'hosts': return `${config.hosts.length} ${config.hosts.length === 1 ? 'host' : 'hosts'}`
  }
}

/** Presentation only. The parent passes published configuration and the original section catalog. */
export function SettingsOverviewPane({ config, groups, onOpen }: {
  config: AppConfig
  groups: ReturnType<typeof settingsNavGroups>
  onOpen: (section: SettingsSectionId) => void
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
                <span className="settings-overview__summary">{savedSummary(item.id, config)}</span>
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            })}
          </div>
        </section>)}
      </div>
    </div>
  )
}
