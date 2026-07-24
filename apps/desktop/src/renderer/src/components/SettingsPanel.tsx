import { Bot, Boxes, FolderGit2, Search, Server, Settings2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { AgentConfig, HostConfig, WorkspaceRecord } from '../../../shared/contracts'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { AgentSettingsPane } from './settings/AgentSettingsPane'
import { GeneralSettingsPane } from './settings/GeneralSettingsPane'
import { HostSettingsPane } from './settings/HostSettingsPane'
import { WorkspaceSettingsPane } from './settings/WorkspaceSettingsPane'

export type SettingsSectionId = 'general' | 'agents' | 'hosts' | 'workspaces'

const SECTIONS = [
  { id: 'general' as const, title: 'General', description: 'Runtime and terminal behavior', icon: Settings2, keywords: 'core runtime terminal tmux ssh' },
  { id: 'agents' as const, title: 'Agents', description: 'Detection and commands', icon: Bot, keywords: 'codex claude traex hermes pi command args env installed provider' },
  { id: 'hosts' as const, title: 'Hosts', description: 'Local and SSH machines', icon: Server, keywords: 'ssh remote hostname user port key test connection' },
  { id: 'workspaces' as const, title: 'Workspaces', description: 'Project folders and registered worktrees', icon: FolderGit2, keywords: 'project folder repo branch worktree create run on agent' }
]

export function SettingsPanel({ onClose, initialSection = 'general' }: {
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

  async function saveAgents(agents: Record<string, AgentConfig>): Promise<void> {
    const current = useAppStore.getState().config
    if (!current) return
    setConfig(await api.config.save({ ...current, agents }))
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
          <p>Configuration</p>
          {visibleSections.map((item) => {
            const Icon = item.icon
            return <button key={item.id} className={active === item.id ? 'selected' : ''} aria-current={active === item.id ? 'page' : undefined} onClick={() => setActive(item.id)}><Icon size={15} /><span><strong>{item.title}</strong><small>{item.description}</small></span></button>
          })}
          {visibleSections.length === 0 ? <span className="settings-nav-empty">No settings match “{query}”.</span> : null}
        </nav>
        <footer><span>Core API</span><code>@agentmux/core</code></footer>
      </aside>
      <main className="settings-content">
        <header><div className="eyebrow">Configuration</div><h2>{section.title}</h2><p>{section.description}</p></header>
        <div className="settings-content__scroll">
          {active === 'general' ? <GeneralSettingsPane /> : null}
          {active === 'agents' ? <AgentSettingsPane config={config} onSave={saveAgents} /> : null}
          {active === 'hosts' ? <HostSettingsPane config={config} onSave={saveHosts} /> : null}
          {active === 'workspaces' ? <WorkspaceSettingsPane config={config} onClose={onClose} /> : null}
        </div>
      </main>
    </div>
  )
}
