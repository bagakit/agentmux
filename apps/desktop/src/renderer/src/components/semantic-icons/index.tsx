import { createContext, useContext } from 'react'
import type { ComponentType, ReactNode } from 'react'
import type { LucideProps } from 'lucide-react'
import { Activity, Ban, Blocks, Bot, CheckCircle2, ChevronRight, Circle, CircleDot, CircleX, Command, GitBranch, Hammer, Layers3, ListOrdered, MessageSquareText, PanelTop, PauseCircle, Radio, ShieldAlert, SlidersHorizontal, Sparkles, Terminal, UserRound, Workflow } from 'lucide-react'
import type { WorkflowAgentStatus } from '../workflow/types'

/** Product-level icon vocabulary. Components ask for meaning, never for a library glyph. */
export type SemanticIconName =
  | 'workflow'
  | 'context'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'paused'
  | 'queued'
  | 'scale'
  | 'dock'
  | 'branch'
  | 'terminal'
  | 'disclosure'
  | 'user-message'
  | 'assistant-message'
  | 'tool-call'
  | 'permission'
  | 'neutral'
  | 'running'
  | 'working'
  | 'message-queue'
  | 'skill'
  | 'component'
  | 'subcommand'
  | 'message-tools'

const icons = {
  workflow: Workflow,
  context: MessageSquareText,
  completed: CheckCircle2,
  failed: CircleX,
  killed: Ban,
  paused: PauseCircle,
  queued: Circle,
  scale: Layers3,
  dock: PanelTop,
  branch: GitBranch,
  terminal: Terminal,
  disclosure: ChevronRight,
  'user-message': UserRound,
  'assistant-message': Bot,
  'tool-call': Hammer,
  permission: ShieldAlert,
  neutral: CircleDot,
  running: Radio,
  working: Activity,
  'message-queue': ListOrdered,
  skill: Sparkles,
  component: Blocks,
  subcommand: Command,
  'message-tools': SlidersHorizontal
} as const

export type SemanticIconRenderer = ComponentType<LucideProps>
export type SemanticIconTheme = Readonly<Partial<Record<SemanticIconName, SemanticIconRenderer>>>
export const SEMANTIC_ICON_NAMES = Object.freeze(Object.keys(icons) as SemanticIconName[])
export const defaultSemanticIconTheme: SemanticIconTheme = Object.freeze(icons)
const SemanticIconThemeContext = createContext<SemanticIconTheme>(defaultSemanticIconTheme)

export function createSemanticIconTheme(overrides: SemanticIconTheme = {}): SemanticIconTheme {
  return Object.freeze({ ...defaultSemanticIconTheme, ...overrides })
}

export function SemanticIconProvider({ theme, children }: { theme: SemanticIconTheme; children: ReactNode }) {
  return <SemanticIconThemeContext.Provider value={theme}>{children}</SemanticIconThemeContext.Provider>
}

export function SemanticIcon({ name, size = 14, className, ...props }: { name: SemanticIconName; size?: number; className?: string } & Omit<LucideProps, 'size'>) {
  const theme = useContext(SemanticIconThemeContext)
  const Icon = (theme[name] ?? defaultSemanticIconTheme[name]) as SemanticIconRenderer
  return <Icon size={size} className={className ? `semantic-icon ${className}` : 'semantic-icon'} aria-hidden="true" {...props} />
}

export function WorkflowSemanticIcon({ status, size = 12, className }: { status: WorkflowAgentStatus; size?: number; className?: string }) {
  const name: SemanticIconName = status === 'running' ? 'workflow' : status
  const resolvedClassName = [className, status === 'running' ? 'wf-spin' : null].filter(Boolean).join(' ')
  return <SemanticIcon name={name} size={size} {...(resolvedClassName ? { className: resolvedClassName } : {})} />
}
