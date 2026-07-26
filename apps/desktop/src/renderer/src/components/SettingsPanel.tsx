import { Bell, Bot, Boxes, FolderGit2, Palette, Search, Server, Settings2, X } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState } from 'react'
import type { AgentExecutorConfig, AppConfig, AppearanceConfig, HostConfig, WorkspaceRecord } from '../../../shared/contracts'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { AgentSettingsPane } from './settings/AgentSettingsPane'
import { AppearanceSettingsPane } from './settings/AppearanceSettingsPane'
import { GeneralSettingsPane } from './settings/GeneralSettingsPane'
import { HostSettingsPane } from './settings/HostSettingsPane'
import { NotificationSettingsPane } from './settings/NotificationSettingsPane'
import { WorkspaceSettingsPane } from './settings/WorkspaceSettingsPane'

export type SettingsSectionId = 'general' | 'appearance' | 'notifications' | 'agents' | 'hosts' | 'workspaces'
type SettingsGroupId = 'setup' | 'preferences'

// Grouped navigation, mirroring orca's `group`-tagged sections but at this app's smaller scale
// (two groups, not orca's eight). "Setup" leads because those are the resources you actually
// register and configure; app-level "Preferences" follow. Section order within SECTIONS is the
// display order — keep the actionable panes ahead of read-only General.
const GROUPS: { id: SettingsGroupId; title: string }[] = [
  { id: 'setup', title: 'Setup' },
  { id: 'preferences', title: 'Preferences' }
]

const SECTIONS = [
  { id: 'workspaces' as const, group: 'setup' as const, title: 'Workspaces', description: 'Project folders and registered worktrees', icon: FolderGit2, keywords: 'project folder repo branch worktree create run on agent' },
  { id: 'hosts' as const, group: 'setup' as const, title: 'Hosts', description: 'Local and SSH machines', icon: Server, keywords: 'ssh remote hostname user port key test connection' },
  { id: 'agents' as const, group: 'setup' as const, title: 'Agents', description: 'Executors and Providers', icon: Bot, keywords: 'codex claude traex hermes pi grok gemini antigravity cursor executor command args env installed provider' },
  { id: 'appearance' as const, group: 'preferences' as const, title: 'Appearance', description: 'Interface layers and terminal palette', icon: Palette, keywords: 'theme color palette terminal tui composer input background' },
  { id: 'notifications' as const, group: 'preferences' as const, title: 'Notifications', description: 'Attention alerts and how long they stay', icon: Bell, keywords: 'notification alert attention dwell duration banner needs you done error until dismiss' },
  { id: 'general' as const, group: 'preferences' as const, title: 'General', description: 'Runtime and terminal behavior', icon: Settings2, keywords: 'core runtime terminal tmux ssh' }
]

export function SettingsPanel({ onClose, initialSection = 'workspaces' }: {
  onClose: () => void
  initialSection?: SettingsSectionId
}) {
  const config = useAppStore((state) => state.config)
  const setConfig = useAppStore((state) => state.setConfig)
  const [active, setActive] = useState<SettingsSectionId>(initialSection)
  const [query, setQuery] = useState('')
  const visibleSections = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return normalized ? SECTIONS.filter((section) => `${section.title} ${section.description} ${section.keywords}`.toLowerCase().includes(normalized)) : SECTIONS
  }, [query])

  useEffect(() => {
    if (visibleSections.some((section) => section.id === active)) return
    const first = visibleSections[0]
    if (first) setActive(first.id)
  }, [active, visibleSections])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && event.target instanceof HTMLElement && !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) onClose()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  if (!config) return null
  const section = SECTIONS.find((candidate) => candidate.id === active) ?? SECTIONS[0]!
  const groupTitle = GROUPS.find((group) => group.id === section.group)?.title ?? 'Configuration'

  async function saveExecutors(executors: Record<string, AgentExecutorConfig>): Promise<void> {
    const current = useAppStore.getState().config
    if (!current) return
    setConfig(await api.config.save({ ...current, executors }))
  }

  async function saveAppearance(appearance: AppearanceConfig): Promise<void> {
    const current = useAppStore.getState().config
    if (!current) return
    setConfig(await api.config.save({ ...current, appearance }))
  }

  async function saveNotifications(notifications: NonNullable<AppConfig['notifications']>): Promise<void> {
    const current = useAppStore.getState().config
    if (!current) return
    setConfig(await api.config.save({ ...current, notifications }))
  }

  async function saveHosts(hosts: HostConfig[], workspaces: WorkspaceRecord[]): Promise<void> {
    const current = useAppStore.getState().config
    if (!current) return
    setConfig(await api.config.save({ ...current, hosts, workspaces }))
  }

  return (
    <div className="settings-page">
      <div className="window-drag-region" />
      <aside className="settings-sidebar">
        <header><div><Boxes size={17} /><span><strong>AgentMux</strong><small>Settings</small></span></div><button className="icon-button" onClick={onClose} aria-label="Close settings"><X size={16} /></button></header>
        <label className="settings-search"><Search size={14} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search settings" />{query ? <button onClick={() => setQuery('')}><X size={12} /></button> : null}</label>
        <nav>
          {GROUPS.map((group) => {
            const items = visibleSections.filter((section) => section.group === group.id)
            if (items.length === 0) return null
            return (
              <Fragment key={group.id}>
                <p>{group.title}</p>
                {items.map((item) => {
                  const Icon = item.icon
                  return <button key={item.id} className={active === item.id ? 'selected' : ''} aria-current={active === item.id ? 'page' : undefined} onClick={() => setActive(item.id)}><Icon size={15} /><span><strong>{item.title}</strong><small>{item.description}</small></span></button>
                })}
              </Fragment>
            )
          })}
          {visibleSections.length === 0 ? <span className="settings-nav-empty">No settings match “{query}”.</span> : null}
        </nav>
        <footer><span>Core API</span><code>@agentmux/core</code></footer>
      </aside>
      <main className="settings-content">
        <header><div className="eyebrow">{groupTitle}</div><h2>{section.title}</h2><p>{section.description}</p></header>
        <div className="settings-content__scroll">
          {active === 'general' ? <GeneralSettingsPane /> : null}
          {active === 'appearance' ? <AppearanceSettingsPane appearance={config.appearance} onSave={saveAppearance} /> : null}
          {active === 'notifications' ? <NotificationSettingsPane notifications={config.notifications} onSave={saveNotifications} /> : null}
          {active === 'agents' ? <AgentSettingsPane config={config} onSave={saveExecutors} /> : null}
          {active === 'hosts' ? <HostSettingsPane config={config} onSave={saveHosts} /> : null}
          {active === 'workspaces' ? <WorkspaceSettingsPane config={config} onClose={onClose} /> : null}
        </div>
      </main>
    </div>
  )
}
