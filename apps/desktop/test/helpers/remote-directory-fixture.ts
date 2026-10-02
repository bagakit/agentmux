import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceFiles } from '../../src/main/workspace-files'
import { createExecutionHost } from '../../src/main/host-factory'
import type { WorkspaceRecord } from '../../src/shared/contracts'

export async function remoteDirectoryFixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-directory-read-'))
  const bin = join(root, 'bin'), path = join(root, 'project'), trace = join(root, 'ssh.jsonl')
  await mkdir(bin); await mkdir(path)
  await copyFile(join(import.meta.dirname, '../fixtures/delayed-workspace-ssh.mjs'), join(bin, 'ssh'))
  await chmod(join(bin, 'ssh'), 0o755)
  const host = createExecutionHost({ id: 'private-remote', kind: 'ssh', label: 'Private remote', hostname: 'fixture.invalid' })
  const workspace: WorkspaceRecord = { id: 'private-project', hostId: host.id, name: 'Private project', kind: 'folder', path }
  const files = new WorkspaceFiles(() => host)
  return { root, bin, path, trace, host, workspace, files,
    calls: async () => { try { return (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(row => JSON.parse(row) as { directory: boolean; pid: number; at: number }) } catch { return [] } },
    dispose: async () => { await files.dispose(); await host.dispose(); await rm(root, { recursive: true, force: true }) }
  }
}
