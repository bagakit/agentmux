/** One declaration for the OS registration, shortcut inventory and Capture hint. */
export const SCREENSHOT_SHORTCUT = {
  id: 'capture.screen',
  label: 'Capture a screen region',
  description: 'System-wide on macOS. Focus a local Message Tool first; the capture returns to that draft.',
  chord: { key: '2', primary: true, shift: true, alt: false }
} as const

export const SCREENSHOT_SHORTCUT_ACCELERATOR = [
  'Command', ...(SCREENSHOT_SHORTCUT.chord.shift ? ['Shift'] : []), SCREENSHOT_SHORTCUT.chord.key
].join('+')

export type ScreenshotShortcutStatus = {
  state: 'registered' | 'unavailable' | 'unsupported'
  accelerator: string
  message?: string
}
