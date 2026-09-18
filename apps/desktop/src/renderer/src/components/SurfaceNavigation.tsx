import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Globe2, LayoutDashboard, SquareTerminal, Users } from 'lucide-react'
import { PmoTeamsTopicEntry } from './PmoTeamsTopicEntry'
import type { MainSurface } from '../store'
import { MOTE_TYPE_NAME } from '../../../shared/scratch-topics'

export type SurfaceNavigationPlugin =
  | {
      id: 'survey' | 'space' | 'focus' | 'goals'
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
 * and activation. Mote opens a coordination overlay; surface entries change the main view.
 */
export const SURFACE_NAVIGATION_PLUGINS: readonly SurfaceNavigationPlugin[] = [
  {
    id: 'pmo-teams',
    kind: 'launcher',
    label: MOTE_TYPE_NAME,
    ariaLabel: `Open ${MOTE_TYPE_NAME} coordination surface`,
    title: `${MOTE_TYPE_NAME} — coordinate and clarify work`,
    tooltip: 'Coordinate and clarify work',
    render: () => <PmoTeamsTopicEntry placement="compact" />
  },
  {
    id: 'space',
    kind: 'surface',
    label: 'Space',
    ariaLabel: 'Space: show terminal and file workbench',
    title: 'Space — show terminal and file workbench',
    tooltip: 'Work with agents, terminals, files and browsers',
    icon: SquareTerminal,
    surface: 'workbench'
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
    id: 'goals',
    kind: 'surface',
    label: 'Goals',
    ariaLabel: 'Goals: show goals and progress',
    title: 'Goals — show goals and progress',
    tooltip: 'Organize goals and follow their progress',
    icon: LayoutDashboard,
    surface: 'board'
  },
  {
    id: 'survey',
    kind: 'surface',
    label: 'Survey',
    ariaLabel: 'Survey: browse and verify information',
    title: 'Survey — browse and verify information',
    tooltip: 'Browse and verify information',
    icon: Globe2,
    surface: 'survey'
  }
]
