import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { durableWriteFile } from '@agentmux/core'
import type { ContinuousProgressLoop } from '@agentmux/core'

const FILE = 'continuous-progress-loops.json'

/** Durable main-process storage for loop configuration; renderer never owns scheduler truth. */
export class ContinuousProgressLoopStore {
  constructor(private readonly path: string) {}
  static forUserData(userDataPath: string): ContinuousProgressLoopStore {
    return new ContinuousProgressLoopStore(join(userDataPath, FILE))
  }
  async load(): Promise<ContinuousProgressLoop[]> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      if (!Array.isArray(raw)) return []
      return raw.filter((item): item is ContinuousProgressLoop => Boolean(item && typeof item === 'object' && typeof (item as any).loopId === 'string' && typeof (item as any).agentSessionId === 'string'))
    } catch { return [] }
  }
  async save(loops: readonly ContinuousProgressLoop[]): Promise<void> {
    await durableWriteFile(this.path, `${JSON.stringify(loops, null, 2)}\n`)
  }
}
