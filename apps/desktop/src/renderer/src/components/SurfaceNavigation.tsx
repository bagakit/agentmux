import type { ReactNode } from 'react'
import { semanticIconComponent, type SemanticIconComponent } from '@agentmux/client-ui/icons'
import { PmoTeamsTopicEntry } from './PmoTeamsTopicEntry'
import type { MainSurface } from '../store'
import { MOTE_TYPE_NAME } from '../../../shared/scratch-topics'

const ThemeObjectTerminalIcon = semanticIconComponent('object.terminal')
const ThemeObjectTeamIcon = semanticIconComponent('object.team')
const ThemeObjectBoardIcon = semanticIconComponent('object.board')
const ThemeActionSearchIcon = semanticIconComponent('action.search')
const ThemeObjectNoteIcon = semanticIconComponent('object.note')


export type SurfaceNavigationPlugin =
  | {
      id: 'recall' | 'survey' | 'space' | 'focus' | 'goals'
      kind: 'surface'
      navigationContext: 'work' | 'survey'
      label: string
      ariaLabel: string
      title: string
      tooltip: string
      icon: SemanticIconComponent
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
    navigationContext: 'work',
    label: 'Space',
    ariaLabel: 'Space: show terminal and file workbench',
    title: 'Space — show terminal and file workbench',
    tooltip: 'Work with agents, terminals, files and browsers',
    icon: ThemeObjectTerminalIcon,
    surface: 'workbench'
  },
  {
    id: 'focus',
    kind: 'surface',
    navigationContext: 'work',
    label: 'Focus',
    ariaLabel: 'Focus: show execution contexts',
    title: 'Focus — show execution contexts',
    tooltip: 'Show execution contexts',
    icon: ThemeObjectTeamIcon,
    surface: 'agents'
  },
  {
    id: 'goals',
    kind: 'surface',
    navigationContext: 'work',
    label: 'Goals',
    ariaLabel: 'Goals: show goals and progress',
    title: 'Goals — show goals and progress',
    tooltip: 'Organize goals and follow their progress',
    icon: ThemeObjectBoardIcon,
    surface: 'board'
  },
  {
    id: 'survey',
    kind: 'surface',
    navigationContext: 'survey',
    label: 'Survey',
    ariaLabel: 'Survey: browse and explore',
    title: 'Survey — browse and explore',
    tooltip: 'Explore the web and collect early results',
    icon: ThemeActionSearchIcon,
    surface: 'survey'
  },
  {
    id: 'recall', kind: 'surface', navigationContext: 'survey', label: 'Recall',
    ariaLabel: 'Recall: keep and revisit knowledge', title: 'Recall — keep and revisit knowledge',
    tooltip: 'Keep, connect and revisit what you learn', icon: ThemeObjectNoteIcon, surface: 'recall'
  }
]
