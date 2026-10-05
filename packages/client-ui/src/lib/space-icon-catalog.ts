import {
  Bot, BookOpen, Bookmark, Brain, Code, Compass, Database, FileText, FlaskConical,
  Folder, Gem, Layers, Library, Lightbulb, NotebookText, Package, Puzzle,
  Rocket, Shapes, SquareTerminal, Wrench
} from 'lucide-react'
import type { SpaceIconId } from './space-icon-ids.js'
export type { SpaceIconId } from './space-icon-ids.js'
export const SPACE_ICON_CATALOG = {
  bot: { label: 'Agent', Icon: Bot },
  book: { label: 'Book', Icon: BookOpen },
  bookmark: { label: 'Bookmark', Icon: Bookmark },
  brain: { label: 'Brain', Icon: Brain },
  code: { label: 'Code', Icon: Code },
  compass: { label: 'Compass', Icon: Compass },
  database: { label: 'Database', Icon: Database },
  document: { label: 'Document', Icon: FileText },
  flask: { label: 'Research', Icon: FlaskConical },
  folder: { label: 'Folder', Icon: Folder },
  gem: { label: 'Gem', Icon: Gem },
  layers: { label: 'Layers', Icon: Layers },
  library: { label: 'Library', Icon: Library },
  lightbulb: { label: 'Idea', Icon: Lightbulb },
  notebook: { label: 'Notebook', Icon: NotebookText },
  package: { label: 'Package', Icon: Package },
  puzzle: { label: 'Puzzle', Icon: Puzzle },
  rocket: { label: 'Rocket', Icon: Rocket },
  shapes: { label: 'Shapes', Icon: Shapes },
  terminal: { label: 'Terminal', Icon: SquareTerminal },
  wrench: { label: 'Tools', Icon: Wrench }
} as const satisfies Record<SpaceIconId, { label: string; Icon: typeof Bot }>
