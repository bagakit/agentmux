import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { mintObjectId } from '@agentmux/core/object-id'
import { pngBytes } from '@agentmux/native-desktop/image'
import type { BrowserPng } from '../shared/contracts'
import type { ScreenshotFileResult } from '../shared/screenshot-output'

export function screenshotFileRevision(bytes: Uint8Array): string {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex')
}

/** A native user choice owns the destination. No Renderer path grants filesystem access. */
export async function exportScreenshotPng(image: BrowserPng, ports: {
  chooseFile(filename: string): Promise<string | null>
  writeFile(path: string, bytes: Uint8Array): Promise<void>
}): Promise<ScreenshotFileResult> {
  const bytes = pngBytes(image)
  const path = await ports.chooseFile('Screenshot.png')
  if (path === null) return { status: 'cancelled' }
  try {
    await ports.writeFile(path, bytes)
    return { status: 'saved', path, revision: screenshotFileRevision(bytes) }
  } catch (error) {
    return { status: 'unknown', message: `PNG save is unconfirmed at ${path}. ${error instanceof Error ? error.message : String(error)} Check that file before another save. Your image is kept.` }
  }
}

/** Publish complete synced bytes. A failed preparation never truncates the chosen file. */
export async function writeScreenshotFile(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${mintObjectId()}.partial`
  let created = false
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    created = true
    try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
    await rename(temporary, path)
    const directory = await open(dirname(path), constants.O_RDONLY)
    try { await directory.sync() } finally { await directory.close() }
  } finally {
    if (created) await unlink(temporary).catch(() => {})
  }
}
