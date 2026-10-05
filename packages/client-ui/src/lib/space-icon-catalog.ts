import type { SpaceIconId } from './space-icon-ids.js'
export type { SpaceIconId } from './space-icon-ids.js'
import { createElement, type ComponentProps } from 'react'
import { SemanticIcon, type SemanticIconId } from '../theme/icons.js'
const choiceIcon = (name: SemanticIconId) => (props: Omit<ComponentProps<typeof SemanticIcon>, 'name'>) => createElement(SemanticIcon, { ...props, name })
export const SPACE_ICON_CATALOG = {
  bot: { label: 'Agent', Icon: choiceIcon('space.agent') },
  book: { label: 'Book', Icon: choiceIcon('space.book') },
  bookmark: { label: 'Bookmark', Icon: choiceIcon('space.bookmark') },
  brain: { label: 'Brain', Icon: choiceIcon('space.brain') },
  code: { label: 'Code', Icon: choiceIcon('space.code') },
  compass: { label: 'Compass', Icon: choiceIcon('space.compass') },
  database: { label: 'Database', Icon: choiceIcon('space.database') },
  document: { label: 'Document', Icon: choiceIcon('space.document') },
  flask: { label: 'Research', Icon: choiceIcon('space.research') },
  folder: { label: 'Folder', Icon: choiceIcon('space.folder') },
  gem: { label: 'Gem', Icon: choiceIcon('space.gem') },
  layers: { label: 'Layers', Icon: choiceIcon('space.layers') },
  library: { label: 'Library', Icon: choiceIcon('space.library') },
  lightbulb: { label: 'Idea', Icon: choiceIcon('space.idea') },
  notebook: { label: 'Notebook', Icon: choiceIcon('space.notebook') },
  package: { label: 'Package', Icon: choiceIcon('space.package') },
  puzzle: { label: 'Puzzle', Icon: choiceIcon('space.puzzle') },
  rocket: { label: 'Rocket', Icon: choiceIcon('space.rocket') },
  shapes: { label: 'Shapes', Icon: choiceIcon('space.shapes') },
  terminal: { label: 'Terminal', Icon: choiceIcon('space.terminal') },
  wrench: { label: 'Tools', Icon: choiceIcon('space.tools') }
} as const satisfies Record<SpaceIconId, { label: string; Icon: ReturnType<typeof choiceIcon> }>
