import type { SpaceIconId } from './space-icon-ids.js'
export type { SpaceIconId } from './space-icon-ids.js'
import { createElement, type ComponentProps } from 'react'
import { SemanticIcon, type SemanticIconId } from '../theme/icons.js'
const choiceIcon = (name: SemanticIconId) => (props: Omit<ComponentProps<typeof SemanticIcon>, 'name'>) => createElement(SemanticIcon, { ...props, name })
const spaceIcon = (label: string, semantic: SemanticIconId) => ({ label, semantic, Icon: choiceIcon(semantic) })
export const SPACE_ICON_CATALOG = {
  bot: spaceIcon('Agent', 'space.agent'),
  book: spaceIcon('Book', 'space.book'),
  bookmark: spaceIcon('Bookmark', 'space.bookmark'),
  brain: spaceIcon('Brain', 'space.brain'),
  code: spaceIcon('Code', 'space.code'),
  compass: spaceIcon('Compass', 'space.compass'),
  database: spaceIcon('Database', 'space.database'),
  document: spaceIcon('Document', 'space.document'),
  flask: spaceIcon('Research', 'space.research'),
  folder: spaceIcon('Folder', 'space.folder'),
  gem: spaceIcon('Gem', 'space.gem'),
  layers: spaceIcon('Layers', 'space.layers'),
  library: spaceIcon('Library', 'space.library'),
  lightbulb: spaceIcon('Idea', 'space.idea'),
  notebook: spaceIcon('Notebook', 'space.notebook'),
  package: spaceIcon('Package', 'space.package'),
  puzzle: spaceIcon('Puzzle', 'space.puzzle'),
  rocket: spaceIcon('Rocket', 'space.rocket'),
  shapes: spaceIcon('Shapes', 'space.shapes'),
  terminal: spaceIcon('Terminal', 'space.terminal'),
  wrench: spaceIcon('Tools', 'space.tools')
} as const satisfies Record<SpaceIconId, { label: string; semantic: SemanticIconId; Icon: ReturnType<typeof choiceIcon> }>
