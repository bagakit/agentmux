/** A focused Composer lease, never a Session inferred from a title or a later active tab. */
export type ScreenshotShortcutTarget = { capture(): Promise<void> }
let selected: ScreenshotShortcutTarget | null = null
let pending: Promise<void> | null = null

export function selectScreenshotTarget(target: ScreenshotShortcutTarget): void { selected = target }
export function releaseScreenshotTarget(target: ScreenshotShortcutTarget): void { if (selected === target) selected = null }

/** Pin synchronously: the original editor captures its bookmark before native selection starts. */
export function runScreenshotShortcut(): Promise<void> {
  if (pending) return pending
  const target = selected
  if (!target) return Promise.reject(new Error('Focus an editable local Message Tool, then use the screenshot shortcut. Your drafts and Capture buttons remain available.'))
  let action: Promise<void>
  try { action = target.capture() } catch (error) { return Promise.reject(error) }
  const operation = Promise.resolve(action).finally(() => { if (pending === operation) pending = null })
  pending = operation
  return operation
}
