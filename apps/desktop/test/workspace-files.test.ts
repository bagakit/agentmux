import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecutionHost } from '@agentmux/core'
import type { WorkspaceRecord } from '../src/shared/contracts.js'
import { WorkspaceFiles } from '../src/main/workspace-files.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })))
})

describe('WorkspaceFiles root confinement', () => {
  it('reads and writes normal local files but rejects a symlink escape', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'agentmux-files-test-'))
    temporaryRoots.push(fixture)
    const root = join(fixture, 'workspace')
    const outside = join(fixture, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await writeFile(join(root, 'inside.txt'), 'inside')
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(outside, join(root, 'escape'), 'dir')
    const workspace: WorkspaceRecord = {
      id: 'workspace',
      name: 'workspace',
      hostId: 'local',
      path: root,
      kind: 'folder'
    }
    const localHost: ExecutionHost = {
      id: 'local',
      kind: 'local',
      label: 'Local',
      run: vi.fn(),
      exposeLoopbackPort: async (port) => port,
      dispose: async () => {}
    }
    const files = new WorkspaceFiles(() => localHost)

    await expect(files.read(workspace, 'inside.txt')).resolves.toEqual({ path: 'inside.txt', content: 'inside' })
    await files.write(workspace, { path: 'inside.txt', content: 'updated' })
    await expect(readFile(join(root, 'inside.txt'), 'utf8')).resolves.toBe('updated')
    await expect(files.read(workspace, 'escape/secret.txt')).rejects.toThrow('Path escapes the workspace root')
    await expect(files.write(workspace, { path: 'escape/secret.txt', content: 'stolen' })).rejects.toThrow(
      'Path escapes the workspace root'
    )
    await expect(readFile(join(outside, 'secret.txt'), 'utf8')).resolves.toBe('secret')
  })

  it('rejects a remote symlink target resolved outside the workspace before cat or tee', async () => {
    const run = vi.fn<ExecutionHost['run']>(async (command, args) => {
      if (command !== 'realpath') throw new Error(`Unexpected command: ${command}`)
      const path = args.at(-1)
      return {
        stdout: path === '/srv/project' ? '/srv/project\n' : '/etc/passwd\n',
        stderr: '',
        exitCode: 0
      }
    })
    const remoteHost: ExecutionHost = {
      id: 'remote',
      kind: 'ssh',
      label: 'Remote',
      run,
      exposeLoopbackPort: async (port) => port,
      dispose: async () => {}
    }
    const workspace: WorkspaceRecord = {
      id: 'remote-workspace',
      name: 'project',
      hostId: 'remote',
      path: '/srv/project',
      kind: 'folder'
    }
    const files = new WorkspaceFiles(() => remoteHost)

    await expect(files.read(workspace, 'linked-secret')).rejects.toThrow('Path escapes the workspace root')
    await expect(files.write(workspace, { path: 'linked-secret', content: 'stolen' })).rejects.toThrow(
      'Path escapes the workspace root'
    )
    expect(run.mock.calls.every(([command]) => command === 'realpath')).toBe(true)
  })
})
