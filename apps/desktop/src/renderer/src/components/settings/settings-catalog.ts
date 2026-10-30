import type { ComponentType } from 'react'
import type { IconAnimation, SemanticIconId } from '@agentmux/client-ui/icons'
import type { AppConfig } from '../../../../shared/contracts'
import type { SettingsNavigationRequest } from '../SettingsNavigation'
import type { SettingsPageId } from './settings-modules'
import type { ConnectionApplication } from '@agentmux/core/connections'

export type ChannelEntry = { section: SettingsPageId; adapterId: string; title: string; domains: readonly string[]; icon: ComponentType<{ size?: number | undefined }> }
export type ChannelPresentation = { section: SettingsPageId; title: string; icon: ComponentType<{ size?: number | undefined }> }

export const SETTINGS_GROUPS = [
  { id: 'preferences', icon: 'object.settings-preferences', title: 'Preferences', description: 'Your profile and everyday defaults.' },
  { id: 'agents', icon: 'object.settings-agents', title: 'Agents', description: 'Agent CLIs and session recovery.' },
  { id: 'mote', icon: 'object.mote', title: 'Mote', description: 'Your collaborators and how they grow.' },
  { id: 'work', icon: 'object.settings-work', title: 'Work', description: 'Organize work, focus attention and pursue goals.' },
  { id: 'know', icon: 'object.settings-know', title: 'Know', description: 'Develop topics, explore sources and keep notes.' },
  { id: 'browser-use', icon: 'object.settings-browser-use', title: 'Browser use', description: 'Browsing and Agent interaction.' },
  { id: 'message-tool', icon: 'object.settings-message-tool', title: 'Message Tool', description: 'Input, collaboration and reusable instructions.' },
  { id: 'remote', icon: 'object.settings-remote', title: 'Remote', description: 'Hosts, remote execution, and device access.' },
  { id: 'conversation-channels', icon: 'object.settings-channels', title: 'Conversation Channels', description: 'Conversations in the app and beyond.' },
  { id: 'toolkit', icon: 'object.settings-mods', title: 'Mods', description: 'Tools that extend your workspace.' }
] as const satisfies readonly { id: string; icon: SemanticIconId; title: string; description: string }[]

export type SettingsPaneProps = {
  config: AppConfig
  onClose: () => void
  active: boolean
  onNavigate(section: SettingsPageId): void
  executorId?: string | undefined
  toolId?: string | undefined
  navigationRequest?: SettingsNavigationRequest | undefined
}

/** A source contribution; editors and save semantics stay with their feature. */
export type SettingsSearchTarget = {
  id: string
  title: string
  description?: string
  keywords?: string
  kind?: 'field' | 'action' | 'info'
}

export type SettingsModule = {
  id: string
  group: typeof SETTINGS_GROUPS[number]['id']
  title: string
  description: string
  keywords: string
  searchTargets?: readonly SettingsSearchTarget[]
  icon: ComponentType<{ size?: number | undefined; animation?: IconAnimation | undefined }>
  /** Presentation of this leaf's applications. Never implementation support or native authorization. */
  channel?: { adapterId: string; domains: readonly { domain: string; title: string }[]; icon: ComponentType<{ size?: number | undefined }> }
  /** This module's authored icon supports a finite navigation-selection gesture. */
  selectionAnimation?: boolean
  /** Optional ordered shortcut on Overview; the original editor remains the destination. */
  overviewShortcut?: number
  savedSummary(config: AppConfig): string
  Pane: ComponentType<SettingsPaneProps>
}

export type SettingsNavGroup<Module extends SettingsModule = SettingsModule> =
  typeof SETTINGS_GROUPS[number] & { items: Module[] }

/** All navigation surfaces derive from the same compiled contributions. */
export function createSettingsCatalog<const Modules extends readonly SettingsModule[]>(modules: Modules) {
  const orderedModules = SETTINGS_GROUPS.flatMap((group) =>
    modules.filter((module) => module.group === group.id)
  )

  function visibleSections(query: string): Modules[number][] {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return [...orderedModules]
    return orderedModules.filter((module) =>
      `${module.title} ${module.description} ${module.keywords}`.toLowerCase().includes(normalized)
      || (module as SettingsModule).searchTargets?.some(target => targetText(target).includes(normalized))
    )
  }

  function searchResults(query: string) {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return []
    return visibleSections(query).map(module => ({
      module,
      targets: ((module as SettingsModule).searchTargets ?? []).filter(target =>
        module.title.toLowerCase().includes(normalized) || targetText(target).includes(normalized))
    }))
  }

  function navGroups(query: string): SettingsNavGroup<Modules[number]>[] {
    const visible = visibleSections(query)
    return SETTINGS_GROUPS.flatMap((group) => {
      const items = visible.filter((module) => module.group === group.id)
      return items.length === 0 ? [] : [{ ...group, items }]
    })
  }

  function channelPresentation(application: ConnectionApplication, adapterId?: string): ChannelPresentation | null {
    const matches = orderedModules.flatMap(module => {
      const channel = (module as SettingsModule).channel
      return channel && (adapterId === undefined || channel.adapterId === adapterId)
        ? channel.domains.filter(item => item.domain === application.domain).map(item => ({ section: module.id as SettingsPageId, title: item.title, icon: channel.icon })) : []
    })
    return matches.length === 1 ? matches[0]! : null
  }
  const channelEntries: ChannelEntry[] = orderedModules.flatMap(module => {
    const channel = (module as SettingsModule).channel
    return channel ? [{ section: module.id as SettingsPageId, adapterId: channel.adapterId, title: module.title, domains: channel.domains.map(item => item.domain), icon: channel.icon }] : []
  })
  return { visibleSections, navGroups, searchResults, channelPresentation, channelEntries }
}

function targetText(target: SettingsSearchTarget): string {
  return `${target.title} ${target.description ?? ''} ${target.keywords ?? ''}`.toLowerCase()
}
