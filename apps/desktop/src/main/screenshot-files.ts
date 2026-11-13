import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dialog, nativeImage, type BrowserWindow } from 'electron'
import { mintObjectId } from '@agentmux/core/object-id'
import { pngBytes, pngFromBytes } from '@agentmux/native-desktop/image'
import type { BrowserPng } from '../shared/contracts'
import type { ScreenshotFileResult } from '../shared/screenshot-output'

/** What one processed PNG save needs besides pixels. */
export type ScreenshotSaveRequest = {
  /** Epoch milliseconds of the capture; names the file in local time. */
  capturedAt: number
  /** Device pixels per logical point. Set only for "Save PNG at 1×"; 1 or less keeps the pixels. */
  logicalScale?: number
}
type ExportPorts = {
  chooseFile(filename: string): Promise<string | null>
  writeFile(path: string, bytes: Uint8Array): Promise<void>
  resize(bytes: Uint8Array, size: { width: number; height: number }): Uint8Array
}

export function screenshotFileRevision(bytes: Uint8Array): string {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex')
}

/** `Screenshot 2026-01-02 at 03.04.05.png`, the capture's local time in the macOS screenshot style. */
export function screenshotFileName(capturedAt: number): string {
  const time = new Date(capturedAt), two = (value: number) => String(value).padStart(2, '0')
  return `Screenshot ${time.getFullYear()}-${two(time.getMonth() + 1)}-${two(time.getDate())} at ${two(time.getHours())}.${two(time.getMinutes())}.${two(time.getSeconds())}.png`
}

/** A native user choice owns the destination. No Renderer path grants filesystem access. */
export async function exportScreenshotPng(image: BrowserPng, request: ScreenshotSaveRequest, ports: ExportPorts): Promise<ScreenshotFileResult> {
  if (!Number.isFinite(request.capturedAt)) throw new Error('The capture time of this image is invalid. Your image is kept.')
  const scale = request.logicalScale
  if (scale !== undefined && !(Number.isFinite(scale) && scale > 0)) throw new Error('The display scale of this image is invalid. Your image is kept.')
  const bytes = scale !== undefined && scale > 1
    ? pngBytes(pngFromBytes(ports.resize(pngBytes(image), { width: Math.max(1, Math.round(image.width / scale)), height: Math.max(1, Math.round(image.height / scale)) })))
    : pngBytes(image)
  const path = await ports.chooseFile(screenshotFileName(request.capturedAt))
  if (path === null) return { status: 'cancelled' }
  try {
    await ports.writeFile(path, bytes)
    return { status: 'saved', path, revision: screenshotFileRevision(bytes) }
  } catch (error) {
    return { status: 'unknown', message: `PNG save is unconfirmed at ${path}. ${error instanceof Error ? error.message : String(error)} Check that file before another save. Your image is kept.` }
  }
}

/** Every processed PNG save in Desktop: one native save sheet on the image's own window, then an atomic write. */
export function saveScreenshotPng(image: BrowserPng, parent: BrowserWindow, request: ScreenshotSaveRequest): Promise<ScreenshotFileResult> {
  return exportScreenshotPng(image, request, {
    chooseFile: async filename => {
      if (parent.isDestroyed()) throw new Error('The original image window closed. Your image is kept.')
      // The native sheet confirms replacing an existing file; macOS always does, other platforms need the flag.
      const choice = await dialog.showSaveDialog(parent, { title: request.logicalScale ? 'Save PNG at 1×' : 'Save PNG', defaultPath: filename,
        filters: [{ name: 'PNG image', extensions: ['png'] }], properties: ['showOverwriteConfirmation', 'createDirectory'] })
      return choice.canceled ? null : choice.filePath ?? null
    },
    writeFile: writeScreenshotFile,
    resize: (bytes, size) => nativeImage.createFromBuffer(Buffer.from(bytes)).resize({ ...size, quality: 'best' }).toPNG()
  })
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
