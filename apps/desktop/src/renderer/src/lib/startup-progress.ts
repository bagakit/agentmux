export type StartupProgress =
  | { step: 'saved-workspace' | 'runtime' | 'layout' }
  | { step: 'sessions' | 'browsers'; current: number; total: number }

export function startupProgressDetail(progress: StartupProgress): string {
  switch (progress.step) {
    case 'saved-workspace': return 'Reading your saved workspace.'
    case 'runtime': return 'Connecting to the local Runtime and checking available Agents.'
    case 'layout': return 'Restoring tabs, regions and focus.'
    case 'sessions': return `Restoring Agent sessions ${progress.current} of ${progress.total}.`
    case 'browsers': return `Reopening browser panes ${progress.current} of ${progress.total}.`
  }
}

/** A mounted interface is ready even when workspace recovery is still in progress. */
export function beginRendererStartup<T>(
  initialize: () => Promise<T>,
  announceReady?: () => Promise<unknown>,
  reportError?: (error: unknown) => void
): Promise<T> {
  if (announceReady) void announceReady().catch((error) => reportError?.(error))
  return initialize()
}
