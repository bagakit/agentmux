import { open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { serializeThemeFile, themeDocumentSchema } from '@agentmux/client-ui/theme'
import type { ThemeFileExportResult } from '../shared/contracts.js'

/** The original native save dialog chooses the target; Renderer data never chooses a filesystem path. */
export async function exportThemeFile(document: unknown, ports: {
  chooseFile(filename: string): Promise<string | null>
  writeFile(path: string, text: string): Promise<void>
}): Promise<ThemeFileExportResult> {
  const theme = themeDocumentSchema.parse(document)
  const text = serializeThemeFile(theme)
  const path = await ports.chooseFile(`${theme.id}.agentmux-theme.json`)
  if (path === null) return { status: 'cancelled' }
  await ports.writeFile(path, text)
  return { status: 'saved', path }
}

/** A failed export leaves the destination intact; only a complete synced file replaces it. */
export async function writeThemeFile(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  let created = false
  try {
    const file = await open(temporary, 'wx', 0o600)
    created = true
    try { await file.writeFile(text, 'utf8'); await file.sync() } finally { await file.close() }
    await rename(temporary, path)
  } catch (cause) {
    if (created) await unlink(temporary).catch(() => {})
    throw cause
  }
}
