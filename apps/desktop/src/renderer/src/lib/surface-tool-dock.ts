export const TOOL_DOCK_DEFAULT_WIDTH = 300
export const TOOL_DOCK_MIN_WIDTH = 236
export const TOOL_DOCK_MAX_WIDTH = 440

export type WorkspaceTool =
  | 'files-branches'
  | 'browser-favorites'
  | 'terminal-shortcuts'

export type BoardTool = 'branch-lanes' | 'inbox'

export type LauncherView = 'picker' | 'agent'

export function clampToolDockWidth(width: number): number {
  return Math.min(TOOL_DOCK_MAX_WIDTH, Math.max(TOOL_DOCK_MIN_WIDTH, width))
}
