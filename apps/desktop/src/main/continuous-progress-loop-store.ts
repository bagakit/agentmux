import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { durableWriteFile } from '@agentmux/core'
import type { ContinuousProgressLoop } from '@agentmux/core'

import { validateContinuousProgressTaskSource } from './continuous-progress-task-source.js'

const FILE = 'continuous-progress-loops.json'

/** Durable main-process storage for loop configuration; renderer never owns scheduler truth. */
export class ContinuousProgressLoopStore {
  private writes: Promise<void> = Promise.resolve()
  constructor(private readonly path: string) {}
  static forUserData(userDataPath: string): ContinuousProgressLoopStore {
    return new ContinuousProgressLoopStore(join(userDataPath, FILE))
  }
  async load(): Promise<ContinuousProgressLoop[]> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      if (!Array.isArray(raw)) throw new Error('Continuous progress loop store must contain an array.')
      for (const item of raw) {
        if (!item || typeof item !== 'object' || !['loopId', 'hostId', 'agentSessionId', 'providerId', 'workspacePath', 'prompt'].every(key => typeof item[key] === 'string' && item[key].trim()) ||
            !Number.isFinite(item.intervalMs) || item.intervalMs <= 0 || !Number.isFinite(item.nextCheckAt) ||
            !['active', 'paused', 'stopped'].includes(item.status)) throw new Error('Continuous progress configuration is unconfirmed. Its stored records are kept; review the loop configuration.')
        if (item.taskSource !== undefined) validateContinuousProgressTaskSource(item.taskSource)
      }
      return raw as ContinuousProgressLoop[]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
  async save(loops: readonly ContinuousProgressLoop[]): Promise<void> {
    const content = `${JSON.stringify(loops, null, 2)}\n`
    const write = this.writes.then(() => durableWriteFile(this.path, content))
    this.writes = write.catch(() => {})
    await write
  }
}
