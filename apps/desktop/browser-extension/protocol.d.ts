export const EXTERNAL_BROWSER_PROTOCOL: 1
export const MAX_BRIDGE_BYTES: number
export const BROWSER_OPERATION_FEEDBACK_WORLD_NAME: string
export function buildOwnedFeedbackClearScript(operationId: string): string
export const EXTERNAL_CDP_METHODS: readonly string[]
export function isShareUrl(value: unknown): boolean
export function isTabScopedCommand(method: unknown, params?: Record<string, unknown>): boolean
export const EXTERNAL_AUTO_ATTACH: {
  autoAttach: true; waitForDebuggerOnStart: false; flatten: true
  filter: ({ type: 'iframe'; exclude: false } | { exclude: true })[]
}
