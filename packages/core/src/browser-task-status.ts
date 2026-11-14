/** Shared task execution states; presentation and inspectors consume the same protocol values. */
export const BROWSER_TASK_RUN_STATUSES = ['ready', 'running', 'waiting-human', 'completed', 'interrupted', 'failed', 'stopped'] as const
export type BrowserTaskRunStatus = typeof BROWSER_TASK_RUN_STATUSES[number]
export function isBrowserTaskRunStatus(value: unknown): value is BrowserTaskRunStatus {
  return BROWSER_TASK_RUN_STATUSES.some(status => status === value)
}
