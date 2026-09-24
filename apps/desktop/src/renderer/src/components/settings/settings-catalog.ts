import type { ComponentType } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { AppConfig } from '../../../../shared/contracts'

export const SETTINGS_GROUPS = [
  { id: 'preferences', title: 'Preferences' },
  { id: 'resources', title: 'Resources' }
] as const

export type SettingsPaneProps = {
  config: AppConfig
  onClose: () => void
  active: boolean
  executorId?: string | undefined
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

export type SettingsNavGroup<Module extends SettingsModule = SettingsModule> = {
  id: typeof SETTINGS_GROUPS[number]['id']
  title: string
  items: Module[]
}

/** All navigation surfaces derive from the same compiled contributions. */
export function createSettingsCatalog<const Modules extends readonly SettingsModule[]>(modules: Modules) {
  function visibleSections(query: string): Modules[number][] {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return [...modules]
    return modules.filter((module) =>
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
