import type { ToolkitScript, ToolkitSnapshot } from '@agentmux/core/control'
export type { ToolkitScript, ToolkitSnapshot } from '@agentmux/core/control'
export const TOOLKIT_CHANGED_CHANNEL = 'agentmux:toolkit-changed'
export const TOOLKIT_ENDED_CHANNEL = 'agentmux:toolkit-ended'
export interface ToolkitDesktopApi {
  list(): Promise<{ toolId: 'performance'; name: string; readonly: true }[]>
  get(): Promise<ToolkitSnapshot>
  script(): Promise<ToolkitScript>
  run(): Promise<ToolkitSnapshot>
  stop(): Promise<ToolkitSnapshot>
  observe(onSnapshot: (value: ToolkitSnapshot) => void, onEnd?: (reason: string) => void): { dispose(): void }
}
