import type { ToolkitDescriptor, ToolkitRunInput, ToolkitActionInput, ToolkitScript, ToolkitSnapshot,
  ToolkitToolDefinition, ToolkitToolFields } from '@agentmux/core/control'
export type { ToolkitScript, ToolkitSnapshot, ToolkitMetricsSnapshot, ToolkitScriptSnapshot,
  ToolkitToolDefinition, ToolkitToolFields, ToolkitRunInput, ToolkitActionInput } from '@agentmux/core/control'
export const TOOLKIT_CHANGED_CHANNEL = 'agentmux:toolkit-changed'
export const TOOLKIT_ENDED_CHANNEL = 'agentmux:toolkit-ended'
export interface ToolkitDesktopApi {
  list(): Promise<ToolkitDescriptor[]>
  get(toolId: string): Promise<ToolkitSnapshot>
  script(toolId: string): Promise<ToolkitScript>
  add(toolId: string, value: ToolkitToolFields): Promise<{ definition: ToolkitToolDefinition; changed: boolean }>
  update(toolId: string, changes: Partial<ToolkitToolFields>, expected?: Partial<ToolkitToolFields>): Promise<{ definition: ToolkitToolDefinition; changed: boolean }>
  remove(toolId: string, expected?: ToolkitToolFields): Promise<{ toolId: string; removed: true }>
  run(toolId: string, input?: ToolkitRunInput): Promise<ToolkitSnapshot>
  action(toolId: string, actionId: string, input: ToolkitActionInput): Promise<ToolkitSnapshot>
  stop(toolId: string, executionId?: string | null): Promise<ToolkitSnapshot>
  observe(toolId: string, onSnapshot: (value: ToolkitSnapshot) => void, onEnd?: (reason: string) => void): { dispose(): void }
}
