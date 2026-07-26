import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { durableWriteFile } from '@agentmux/core'
import { parseStoredGeometry, type WindowGeometry } from './window-geometry.js'

/**
 * Durable store for the window's last size/position/maximized state, kept in Electron userData beside
 * the config so a restart reopens the window where the user left it instead of at the fixed literal.
 *
 * This is main-owned presentation state, deliberately separate from the renderer's localStorage
 * layout record: the window is created before any renderer exists, so its geometry cannot come from
 * the renderer's persistence.
 */
export class WindowGeometryStore {
  private saveTail: Promise<void> = Promise.resolve()

  constructor(private readonly path = join(app.getPath('userData'), 'window-geometry.json')) {}

  /** A missing or corrupt record reads back as null so the caller falls back to the default size. */
  async load(): Promise<WindowGeometry | null> {
    try {
      return parseStoredGeometry(JSON.parse(await readFile(this.path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      // A truncated or unparseable file is treated the same as no record: better a default window
      // than a startup crash over a presentation nicety.
      return null
    }
  }

  /**
   * Serialize writes through a tail so overlapping saves (a resize immediately followed by a close)
   * cannot interleave and leave a half-written file. Durable temp-then-rename mirrors ConfigStore.
   */
  async save(geometry: WindowGeometry): Promise<void> {
    const operation = this.saveTail.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      await durableWriteFile(this.path, `${JSON.stringify(geometry, null, 2)}\n`)
    })
    this.saveTail = operation.then(() => {}, () => {})
    await operation
  }
}
