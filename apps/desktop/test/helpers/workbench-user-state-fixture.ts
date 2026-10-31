import { afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchUserStateStore } from '../../src/main/workbench-user-state'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
/** Unrelated IPC fixtures still provide the same explicit application owner. */
export function testWorkbenchUserState() {
  const root = mkdtempSync(join(tmpdir(), 'amux-ipc-user-state-'))
  roots.push(root)
  return new WorkbenchUserStateStore(join(root, 'workbench-user-state.json'))
}
