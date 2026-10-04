import type { ComponentType } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { AppConfig } from '../../../../shared/contracts'
import type { SettingsNavigationRequest } from '../SettingsNavigation'
import type { SettingsPageId } from './settings-modules'

export const SETTINGS_GROUPS = [
  { id: 'preferences', title: 'Preferences', overviewColumn: 'left' },
  { id: 'connections', title: 'Connections', overviewColumn: 'left' },
  { id: 'resources', title: 'Resources', overviewColumn: 'right' },
  { id: 'work', title: 'Work', overviewColumn: 'right' },
  { id: 'mote', title: 'Mote', overviewColumn: 'right' },
  { id: 'toolkit', title: 'Mods', overviewColumn: 'right' }
] as const

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
export type SettingsModule = {
  id: string
  group: typeof SETTINGS_GROUPS[number]['id']
  title: string
  description: string
  keywords: string
  icon: LucideIcon
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
    )
  }

  function navGroups(query: string): SettingsNavGroup<Modules[number]>[] {
    const visible = visibleSections(query)
    return SETTINGS_GROUPS.flatMap((group) => {
      const items = visible.filter((module) => module.group === group.id)
      return items.length === 0 ? [] : [{ ...group, items }]
    })
  }

  return { visibleSections, navGroups }
}
