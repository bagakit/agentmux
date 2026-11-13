export const SCREENSHOT_COUNTDOWN_CHANNEL = 'screenshot:countdown'
/** Main to the countdown page: seconds left before region selection starts. */
export const SCREENSHOT_COUNTDOWN_TICK = 'screenshot:countdown-tick'
export const SCREENSHOT_DELAYS = [3, 5, 10] as const
export type ScreenshotDelaySeconds = typeof SCREENSHOT_DELAYS[number]
export type ScreenshotCountdownApi = {
  /** Theme and the seconds left now; ticks after this keep it current. */
  load(): Promise<{ theme: import('./theme-bootstrap').ThemeBootstrap; seconds: number }>
  /** Listen for seconds left; returns the unsubscribe. */
  onTick(listener: (seconds: number) => void): () => void
  cancel(): Promise<void>
}
