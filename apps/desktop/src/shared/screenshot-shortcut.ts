/** One declaration for the OS registration, shortcut inventory and Capture hint. */
export const SCREENSHOT_SHORTCUT = {
  id: 'capture.screen',
  label: 'Capture a screen region including AgentMux',
  description: 'System-wide on macOS. Includes AgentMux; copies to the clipboard and also attaches when a local message input is focused.',
  background: 'included',
  chord: { key: '2', primary: true, shift: true, alt: false }
} as const

export const SCREENSHOT_SHORTCUT_ALTERNATE = {
  ...SCREENSHOT_SHORTCUT,
  id: 'capture.screen.exclude-host',
  label: 'Capture a screen region without AgentMux',
  description: 'System-wide on macOS. Hides AgentMux from the frozen image; copies to the clipboard and also attaches when a local message input is focused.',
  background: 'excluded',
  chord: { ...SCREENSHOT_SHORTCUT.chord, alt: true }
} as const

export const SCREENSHOT_SHORTCUTS = [SCREENSHOT_SHORTCUT, SCREENSHOT_SHORTCUT_ALTERNATE] as const

export function screenshotShortcutAccelerator(chord: (typeof SCREENSHOT_SHORTCUTS)[number]['chord']): string {
  return ['Command', ...(chord.alt ? ['Alt'] : []), ...(chord.shift ? ['Shift'] : []), chord.key].join('+')
}

export const SCREENSHOT_SHORTCUT_ACCELERATOR = screenshotShortcutAccelerator(SCREENSHOT_SHORTCUT.chord)

export type ScreenshotShortcutStatus = {
  state: 'registered' | 'unavailable' | 'unsupported'
  accelerator: string
  message?: string
}

/** The default binding keeps its direct status fields; the alternate reports its own OS registration. */
export type ScreenshotShortcutStatuses = ScreenshotShortcutStatus & { alternate: ScreenshotShortcutStatus }
