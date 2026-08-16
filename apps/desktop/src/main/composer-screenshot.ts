import { mkdir, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runProcess } from '@agentmux/core'
import { pastedDirectory } from './pasted-directory.js'

/** System selection UI; only a completed capture becomes a draft reference. Escape leaves no artifact. */
export async function captureComposerScreenshot(home: string): Promise<string | null> {
  if (process.platform !== 'darwin') throw new Error('Screen selection is only available on macOS.')
  const directory = pastedDirectory(home)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `screen-${randomUUID()}.png`)
  const result = await runProcess('/usr/sbin/screencapture', ['-i', '-x', '-t', 'png', path], { timeoutMs: 120_000 })
  let size = 0
  try { size = (await stat(path)).size } catch { /* Escape produces no file. */ }
  if (size > 0 && result.exitCode === 0) return path
  await rm(path, { force: true })
  if (result.exitCode !== 0 && result.stderr.trim()) throw new Error(result.stderr.trim())
  return null
}
