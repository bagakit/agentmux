import { DatabaseSync } from 'node:sqlite'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

export type JournalIo = { reads: number; readBytes: number; writes: number; writeBytes: number; syncs: number; dirSyncs: number; failures: number }

/** Private real SQLite IO probe. No fault hooks, config or abstraction enter the product. */
export async function messageJournalIo() {
  const root = await mkdtemp(join(tmpdir(), 'amux-sqlite-probe-'))
  const exec = promisify(execFile)
  const library = join(root, process.platform === 'darwin' ? 'probe.dylib' : 'probe.so')
  const source = fileURLToPath(new URL('./message-journal-vfs.c', import.meta.url))
  let control: DatabaseSync | undefined
  try {
    const args = process.platform === 'darwin'
      ? ['-dynamiclib', '-I', join((await exec('xcrun', ['--show-sdk-path'])).stdout.trim(), 'usr/include')]
      : ['-fPIC', '-shared']
    await exec(process.platform === 'darwin' ? 'clang' : 'cc', [...args, source, '-o', library])
    control = new DatabaseSync(':memory:', { allowExtension: true })
    control.loadExtension(library)
    const db = control
    return {
      target(path: string) { db.prepare('SELECT amux_io_path(?)').get(path) },
      reset() { db.prepare('SELECT amux_io_reset()').get() },
      fault(kind: 'read' | 'write' | 'sync', skip = 0) { db.prepare('SELECT amux_io_fault(?, ?)').get(kind, skip) },
      stats(): JournalIo { return JSON.parse(String(db.prepare('SELECT amux_io_stats() AS value').get()!.value)) as JournalIo },
      async close() {
        db.prepare('SELECT amux_io_restore()').get(); db.close()
        await rm(root, { recursive: true, force: true })
      }
    }
  } catch (error) { control?.close(); await rm(root, { recursive: true, force: true }); throw error }
}
