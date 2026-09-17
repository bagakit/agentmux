import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultAgentMuxRuntimeDirectory } from './runtime-paths.js'

/** On-disk bytes in the selected Runtime directory, independent of retained Run inventory. */
export interface RuntimeStorageUsage {
  readonly path: string
  readonly bytes: number
}

async function directoryBytes(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true })
  let total = 0
  for (const entry of entries) {
    const child = join(path, entry.name)
    // Do not follow links into another Runtime or unrelated storage.
    if (entry.isDirectory()) total += await directoryBytes(child)
    else if (entry.isFile()) total += (await stat(child)).size
  }
  return total
}

/** Read only this Runtime's directory; never discover or remove sibling directories. */
export async function runtimeStorageUsage(
  runtimeDirectory = defaultAgentMuxRuntimeDirectory()
): Promise<RuntimeStorageUsage> {
  return { path: runtimeDirectory, bytes: await directoryBytes(runtimeDirectory) }
}
