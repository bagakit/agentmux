import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { access, chmod, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecutionHost } from '@agentmux/core'
import type { WorkspaceRecord } from '../src/shared/contracts.js'
import { WorkspaceFiles, workspaceFileObserverCount } from '../src/main/workspace-files.js'

const localWorkerRace = vi.hoisted(() => ({
  beforeInput: null as null | (() => Promise<void>)
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (...args: any[]) => {
      const child = (actual.spawn as (...values: any[]) => ReturnType<typeof actual.spawn>)(...args)
      const input = child.stdin
      if (!input) return child
      const originalEnd = input.end.bind(input)
      input.end = ((...values: any[]) => {
        const hook = localWorkerRace.beforeInput
        localWorkerRace.beforeInput = null
        if (!hook) return originalEnd(...values)
        void hook().then(
          () => originalEnd(...values),
          (error) => input.destroy(error instanceof Error ? error : new Error(String(error)))
        )
        return input
      }) as typeof input.end
      return child
    }
  }
})

const temporaryRoots: string[] = []

function revision(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for Workspace file observation')
}

async function localFixture(label: string): Promise<{
  root: string
  workspace: WorkspaceRecord
  host: ExecutionHost
}> {
  const fixture = await mkdtemp(join(tmpdir(), `agentmux-${label}-`))
  temporaryRoots.push(fixture)
  const root = join(fixture, 'workspace')
  await mkdir(root)
  return {
    root,
    workspace: {
      id: `${label}-workspace`,
      name: label,
      hostId: 'local',
      path: root,
      kind: 'folder'
    },
    host: {
      id: 'local',
      kind: 'local',
      label: 'Local',
      run: vi.fn(),
      exposeLoopbackPort: async (port) => port,
      dispose: async () => {}
    }
  }
}

afterEach(async () => {
  localWorkerRace.beforeInput = null
  await Promise.all(temporaryRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })))
})

describe('WorkspaceFiles root confinement', () => {
  it.runIf(process.platform === 'darwin')(
    'pins each local operation before a checked directory is replaced by an escaping symlink',
    async () => {
      const fixture = await mkdtemp(join(tmpdir(), 'agentmux-files-race-'))
      temporaryRoots.push(fixture)
      const root = join(fixture, 'workspace')
      await mkdir(root)
      const workspace: WorkspaceRecord = {
        id: 'workspace-race',
        name: 'workspace-race',
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

      const race = async (label: string) => {
        const requested = join(root, label)
        const held = join(root, `${label}-held`)
        const outside = join(fixture, `${label}-outside`)
        await Promise.all([mkdir(requested), mkdir(outside)])
        localWorkerRace.beforeInput = async () => {
          await rename(requested, held)
          await symlink(outside, requested, 'dir')
        }
        return { requested, held, outside }
      }

      const readRace = await race('read')
      await Promise.all([
        writeFile(join(readRace.requested, 'value.txt'), 'inside'),
        writeFile(join(readRace.outside, 'value.txt'), 'outside-secret')
      ])
      await expect(files.read(workspace, 'read/value.txt')).resolves.toEqual({
        status: 'read',
        document: {
          path: 'read/value.txt',
          content: 'inside',
          revision: revision('inside')
        }
      })
      await expect(readFile(join(readRace.outside, 'value.txt'), 'utf8')).resolves.toBe('outside-secret')

      const listRace = await race('list')
      await Promise.all([
        writeFile(join(listRace.requested, 'inside.txt'), 'inside'),
        writeFile(join(listRace.outside, 'outside.txt'), 'outside')
      ])
      await expect(files.readDirectory(workspace, 'list')).resolves.toEqual([
        { name: 'inside.txt', path: 'list/inside.txt', isDirectory: false, isSymlink: false }
      ])

      const revealRace = await race('reveal')
      await Promise.all([
        writeFile(join(revealRace.requested, 'inside.txt'), 'inside'),
        writeFile(join(revealRace.outside, 'inside.txt'), 'outside')
      ])
      const revealed = await files.localPathForReveal(workspace, 'reveal/inside.txt')
      expect(revealed).toBe(await realpath(join(revealRace.held, 'inside.txt')))

      const createRace = await race('create')
      await files.create(workspace, { path: 'create/new.txt', kind: 'file' })
      await expect(access(join(createRace.held, 'new.txt'))).resolves.toBeUndefined()
      await expect(access(join(createRace.outside, 'new.txt'))).rejects.toThrow()

      const writeRace = await race('write')
      await Promise.all([
        writeFile(join(writeRace.requested, 'value.txt'), 'inside'),
        writeFile(join(writeRace.outside, 'value.txt'), 'outside-secret')
      ])
      await expect(files.write(workspace, {
        path: 'write/value.txt',
        content: 'updated',
        expectedRevision: revision('inside')
      })).resolves.toEqual({ status: 'written', revision: revision('updated') })
      await expect(readFile(join(writeRace.held, 'value.txt'), 'utf8')).resolves.toBe('updated')
      await expect(readFile(join(writeRace.outside, 'value.txt'), 'utf8')).resolves.toBe('outside-secret')

      const renameRace = await race('rename')
      await Promise.all([
        writeFile(join(renameRace.requested, 'before.txt'), 'inside'),
        writeFile(join(renameRace.outside, 'before.txt'), 'outside-secret')
      ])
      await files.rename(workspace, { path: 'rename/before.txt', nextPath: 'rename/after.txt' })
      await expect(readFile(join(renameRace.held, 'after.txt'), 'utf8')).resolves.toBe('inside')
      await expect(readFile(join(renameRace.outside, 'before.txt'), 'utf8')).resolves.toBe('outside-secret')
      await expect(access(join(renameRace.outside, 'after.txt'))).rejects.toThrow()

      const deleteRace = await race('delete')
      await Promise.all([
        writeFile(join(deleteRace.requested, 'victim.txt'), 'inside'),
        writeFile(join(deleteRace.outside, 'victim.txt'), 'outside-secret')
      ])
      await files.delete(workspace, 'delete/victim.txt')
      await expect(access(join(deleteRace.held, 'victim.txt'))).rejects.toThrow()
      await expect(readFile(join(deleteRace.outside, 'victim.txt'), 'utf8')).resolves.toBe('outside-secret')
      expect(localWorkerRace.beforeInput).toBeNull()
    }
  )

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

    await expect(files.localPathForReveal(workspace, 'inside.txt')).resolves.toBe(
      await realpath(join(root, 'inside.txt'))
    )
    await expect(files.read(workspace, 'inside.txt')).resolves.toEqual({
      status: 'read',
      document: { path: 'inside.txt', content: 'inside', revision: revision('inside') }
    })
    await expect(files.write(workspace, {
      path: 'inside.txt',
      content: 'updated',
      expectedRevision: revision('inside')
    })).resolves.toEqual({ status: 'written', revision: revision('updated') })
    await expect(readFile(join(root, 'inside.txt'), 'utf8')).resolves.toBe('updated')
    await expect(files.read(workspace, 'escape/secret.txt')).resolves.toMatchObject({
      status: 'error',
      message: 'Path escapes the workspace root'
    })
    await expect(files.write(workspace, {
      path: 'escape/secret.txt',
      content: 'stolen',
      expectedRevision: revision('secret')
    })).resolves.toMatchObject({ status: 'error', message: 'Path escapes the workspace root' })
    await expect(readFile(join(outside, 'secret.txt'), 'utf8')).resolves.toBe('secret')
  })

  it('returns revisions, serializes competing saves, and rejects stale expected revisions', async () => {
    const { root, workspace, host } = await localFixture('revision')
    const path = join(root, 'document.txt')
    await writeFile(path, 'alpha')
    const files = new WorkspaceFiles(() => host)

    const opened = await files.read(workspace, 'document.txt')
    expect(opened).toEqual({
      status: 'read',
      document: { path: 'document.txt', content: 'alpha', revision: revision('alpha') }
    })
    if (opened.status !== 'read') throw new Error('Fixture file was not read')

    const [first, second] = await Promise.all([
      files.write(workspace, {
        path: 'document.txt',
        content: 'bravo',
        expectedRevision: opened.document.revision
      }),
      files.write(workspace, {
        path: 'document.txt',
        content: 'charlie',
        expectedRevision: opened.document.revision
      })
    ])
    expect(first).toEqual({ status: 'written', revision: revision('bravo') })
    expect(second).toEqual({ status: 'conflict', observedRevision: revision('bravo') })
    await expect(readFile(path, 'utf8')).resolves.toBe('bravo')

    await writeFile(path, 'delta')
    await expect(files.write(workspace, {
      path: 'document.txt',
      content: 'echo',
      expectedRevision: revision('bravo')
    })).resolves.toEqual({ status: 'conflict', observedRevision: revision('delta') })
    await expect(readFile(path, 'utf8')).resolves.toBe('delta')
  })

  it.each(['temporary-write', 'replace'] as const)(
    'keeps original bytes and mode when %s fails',
    async (fault) => {
      const { root, workspace, host } = await localFixture(`atomic-${fault}`)
      const path = join(root, 'document.txt')
      await writeFile(path, 'original bytes')
      await chmod(path, 0o640)
      const files = new WorkspaceFiles(() => host, { localWriteFault: fault })

      await expect(files.write(workspace, {
        path: 'document.txt',
        content: 'replacement bytes',
        expectedRevision: revision('original bytes')
      })).resolves.toMatchObject({ status: 'error' })
      await expect(readFile(path, 'utf8')).resolves.toBe('original bytes')
      expect((await stat(path)).mode & 0o777).toBe(0o640)
      expect((await readdir(root)).filter((name) => name.includes('.agentmux-'))).toEqual([])
    }
  )

  it('atomically replaces a complete file while preserving its mode', async () => {
    const { root, workspace, host } = await localFixture('atomic-success')
    const path = join(root, 'document.txt')
    await writeFile(path, 'original bytes')
    await chmod(path, 0o640)
    const files = new WorkspaceFiles(() => host)

    await expect(files.write(workspace, {
      path: 'document.txt',
      content: 'replacement bytes',
      expectedRevision: revision('original bytes')
    })).resolves.toEqual({ status: 'written', revision: revision('replacement bytes') })
    await expect(readFile(path, 'utf8')).resolves.toBe('replacement bytes')
    expect((await stat(path)).mode & 0o777).toBe(0o640)
  })

  it('publishes only invalidation facts and distinguishes deletion from read failure', async () => {
    const { root, workspace, host } = await localFixture('observation')
    const path = join(root, 'document.txt')
    await writeFile(path, 'alpha')
    const files = new WorkspaceFiles(() => host)
    let invalidations = 0
    const dispose = await files.observe(workspace, 'document.txt', () => {
      invalidations += 1
    })
    expect(workspaceFileObserverCount()).toBe(1)

    await writeFile(path, 'bravo')
    await waitFor(() => invalidations > 0)
    await rm(path)
    await waitFor(() => invalidations > 1)
    await expect(files.read(workspace, 'document.txt')).resolves.toEqual({ status: 'deleted' })

    await mkdir(path)
    await waitFor(() => invalidations > 2)
    await expect(files.read(workspace, 'document.txt')).resolves.toMatchObject({
      status: 'error',
      message: 'Workspace path is not a regular file'
    })

    dispose()
    await waitFor(() => workspaceFileObserverCount() === 0)
    const afterDispose = invalidations
    await rm(path, { recursive: true })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(invalidations).toBe(afterDispose)
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
    await expect(files.rename(workspace, { path: 'src/new.ts', nextPath: 'moved.ts' }))
      .rejects.toThrow('cannot move a path between directories')
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

    await expect(files.localPathForReveal(workspace, 'linked-secret')).rejects.toThrow(
      'Reveal in file manager is available only for local paths'
    )
    await expect(files.read(workspace, 'linked-secret')).resolves.toMatchObject({
      status: 'error',
      message: 'Path escapes the workspace root'
    })
    await expect(files.write(workspace, {
      path: 'linked-secret',
      content: 'stolen',
      expectedRevision: revision('secret')
    })).resolves.toMatchObject({ status: 'error' })
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
