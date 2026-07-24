import { afterEach, describe, expect, it, vi } from 'vitest'
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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

  it('lists one directory level and confines create, rename, and delete mutations', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'agentmux-files-mutate-'))
    temporaryRoots.push(fixture)
    const root = join(fixture, 'workspace')
    const outside = join(fixture, 'outside')
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(outside)
    await writeFile(join(root, 'README.md'), 'readme')
    await writeFile(join(root, 'src', 'index.ts'), 'index')
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

    await expect(files.readDirectory(workspace, '')).resolves.toEqual([
      { name: 'src', path: 'src', isDirectory: true, isSymlink: false },
      { name: 'escape', path: 'escape', isDirectory: false, isSymlink: true },
      { name: 'README.md', path: 'README.md', isDirectory: false, isSymlink: false }
    ])
    await files.create(workspace, { path: 'src/new.ts', kind: 'file' })
    await files.create(workspace, { path: 'src/lib', kind: 'directory' })
    await files.rename(workspace, { path: 'src/new.ts', nextPath: 'src/renamed.ts' })
    await expect(access(join(root, 'src', 'renamed.ts'))).resolves.toBeUndefined()
    await expect(files.create(workspace, { path: 'escape/stolen.txt', kind: 'file' })).rejects.toThrow(
      'Path escapes the workspace root'
    )
    await files.delete(workspace, 'src/lib')
    await expect(access(join(root, 'src', 'lib'))).rejects.toThrow()
    await expect(files.delete(workspace, '')).rejects.toThrow('workspace root cannot be changed')
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

  it('uses directory-scoped argv operations for remote file management', async () => {
    const run = vi.fn<ExecutionHost['run']>(async (command, args) => {
      if (command === 'realpath') {
        return { stdout: `${String(args.at(-1))}\n`, stderr: '', exitCode: 0 }
      }
      if (command === 'find') {
        return { stdout: 'src\0d\0README.md\0f\0link\0l\0', stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
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

    await expect(files.readDirectory(workspace, '')).resolves.toEqual([
      { name: 'src', path: 'src', isDirectory: true, isSymlink: false },
      { name: 'link', path: 'link', isDirectory: false, isSymlink: true },
      { name: 'README.md', path: 'README.md', isDirectory: false, isSymlink: false }
    ])
    await files.create(workspace, { path: 'src/new.ts', kind: 'file' })
    await files.rename(workspace, { path: 'src/new.ts', nextPath: 'src/renamed.ts' })
    await files.delete(workspace, 'src/renamed.ts')

    expect(run).toHaveBeenCalledWith(
      'find',
      expect.arrayContaining(['/srv/project', '-exec', 'sh', '-c']),
      expect.objectContaining({ timeoutMs: 15_000 })
    )
    expect(run).toHaveBeenCalledWith(
      'sh',
      ['-c', 'umask 077; set -C; : > "$1"', 'agentmux-create', '/srv/project/src/new.ts'],
      { timeoutMs: 15_000 }
    )
    expect(run).toHaveBeenCalledWith('rm', ['-rf', '--', '/srv/project/src/renamed.ts'], {
      timeoutMs: 15_000
    })
  })
})
