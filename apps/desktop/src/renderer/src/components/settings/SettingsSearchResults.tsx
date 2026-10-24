import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { SETTINGS_GROUPS, type SettingsModule, type SettingsSearchTarget } from './settings-catalog'

const ForwardIcon = semanticIconComponent('navigation.forward')

/** Static contribution results; editors and user values are never used to build this view. */
export function SettingsSearchResults<Module extends SettingsModule>({ results, query, onChoose }: {
  results: { module: Module; targets: readonly SettingsSearchTarget[] }[]
  query: string
  onChoose(section: Module['id'], target?: string): void
}) {
  return <div className="settings-content__scroll settings-search-results" aria-label="Settings search results">
    {!results.length ? <p className="settings-nav-empty" role="status">No settings match “{query}”. Try a different word.</p> : null}
    {results.map(({ module, targets }) => {
      const Icon = module.icon
      return <section key={module.id} className="settings-search-results__section">
        <button type="button" className="settings-search-results__section-link" data-settings-search-section={module.id} onClick={() => onChoose(module.id)}>
          <Icon size={16} aria-hidden="true" /><span><small>{SETTINGS_GROUPS.find(group => group.id === module.group)!.title}</small><strong>{module.title}</strong></span><ForwardIcon size={13} aria-hidden="true" />
        </button>
        {targets.length ? <div className="settings-search-results__targets">{targets.map(target => <button type="button" key={target.id}
          className="settings-search-results__target" data-settings-search-result={`${module.id}:${target.id}`} onClick={() => onChoose(module.id, target.id)}>
          <span><strong>{target.title}</strong>{target.description ? <small>{target.description}</small> : null}</span>
          <small>{target.kind === 'action' ? 'Action' : target.kind === 'info' ? 'Guide' : 'Setting'}</small>
        </button>)}</div> : <p className="settings-search-results__description">{module.description}</p>}
      </section>
    })}
  </div>
}
