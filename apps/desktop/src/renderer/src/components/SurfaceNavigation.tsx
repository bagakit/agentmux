import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Globe2, LayoutDashboard, SquareTerminal, Users } from 'lucide-react'
import { PmoTeamsTopicEntry } from './PmoTeamsTopicEntry'
import type { MainSurface } from '../store'

export type SurfaceNavigationPlugin =
  | {
      id: 'survey' | 'workspaces' | 'focus' | 'work'
      kind: 'surface'
      label: string
      ariaLabel: string
      title: string
      tooltip: string
      icon: LucideIcon
      surface: MainSurface
    }
  | {
      id: 'pmo-teams'
      kind: 'launcher'
      label: string
      ariaLabel: string
      title: string
      tooltip: string
      render: () => ReactNode
    }

/**
 * The footer is intentionally driven by one ordered plugin list. The container owns
 * geometry, selected state and responsive collapse; plugins only describe identity
 * and activation. A new entry must not add a second footer slot or positioning rule.
 */
export const SURFACE_NAVIGATION_PLUGINS: readonly SurfaceNavigationPlugin[] = [
  {
    id: 'survey',
    kind: 'surface',
    label: 'Survey',
    ariaLabel: 'Survey: browse and verify information',
    title: 'Survey — browse and verify information',
    tooltip: 'Browse and verify information',
    icon: Globe2,
    surface: 'survey'
  },
  {
    id: 'workspaces',
    kind: 'surface',
    label: 'Workspaces',
    ariaLabel: 'Workspaces: show terminal and file workbench',
    title: 'Workspaces — show terminal and file workbench',
    tooltip: 'Show terminal and file workbench',
    icon: SquareTerminal,
    surface: 'workbench'
  },
  {
    id: 'pmo-teams',
    kind: 'launcher',
    label: 'PMO Teams',
    ariaLabel: 'Open PMO Teams coordination surface',
    title: 'PMO Teams — coordinate and clarify work',
    tooltip: 'Coordinate and clarify work',
    render: () => <PmoTeamsTopicEntry placement="compact" />
  },
  {
    id: 'focus',
    kind: 'surface',
    label: 'Focus',
    ariaLabel: 'Focus: show execution contexts',
    title: 'Focus — show execution contexts',
    tooltip: 'Show execution contexts',
    icon: Users,
    surface: 'agents'
  },
  {
    id: 'work',
    kind: 'surface',
    label: 'Work',
    ariaLabel: 'Work: show requests and ideas',
    title: 'Work — show requests and ideas',
    tooltip: 'Show requests and ideas',
    icon: LayoutDashboard,
    surface: 'board'
  }
]
