import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { access, chmod, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ExecutionHost } from '@agentmux/core'
import type { WorkspaceRecord } from '../src/shared/contracts.js'
import { WorkspaceFiles, workspaceFileObserverCount } from '../src/main/workspace-files.js'

const localWorkerRace = vi.hoisted(() => ({
  beforeInput: null as null | (() => Promise<void>),
  beforeObserverInput: null as null | (() => Promise<void>),
  beforeObserverKill: null as null | (() => Promise<void>),
  // Every observer child this suite spawns, oldest first. The only way a test can kill a worker the
  // way the OS does — the failure the respawn exists for — is to hold its real pid.
  observerPids: [] as number[]
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (...args: any[]) => {
      const child = (actual.spawn as (...values: any[]) => ReturnType<typeof actual.spawn>)(...args)
      if (args[0] !== process.execPath) return child
      const request = JSON.parse(args[1]?.[3] ?? 'null') as { action?: string } | null
      const input = child.stdin
      if (!input) return child
      const originalEnd = input.end.bind(input)
      input.end = ((...values: any[]) => {
        const observerHook = request?.action === 'observe' ? localWorkerRace.beforeObserverInput : null
        const hook = observerHook ?? localWorkerRace.beforeInput
        if (observerHook) localWorkerRace.beforeObserverInput = null
        else localWorkerRace.beforeInput = null
        if (!hook) return originalEnd(...values)
        void hook().then(
          () => originalEnd(...values),
          (error) => input.destroy(error instanceof Error ? error : new Error(String(error)))
        )
        return input
      }) as typeof input.end
      if (request?.action === 'observe') {
        if (typeof child.pid === 'number') localWorkerRace.observerPids.push(child.pid)
        const originalKill = child.kill.bind(child)
        child.kill = ((signal?: NodeJS.Signals | number) => {
          const hook = localWorkerRace.beforeObserverKill
          localWorkerRace.beforeObserverKill = null
          if (!hook) return originalKill(signal)
          void hook().then(
            () => originalKill(signal),
            () => originalKill(signal)
          )
          return true
        }) as typeof child.kill
      }
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
  localWorkerRace.beforeObserverInput = null
  localWorkerRace.beforeObserverKill = null
  localWorkerRace.observerPids.length = 0
  await Promise.all(temporaryRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })))
})

describe('WorkspaceFiles root confinement', () => {
  // Every local operation must pin the directory it already checked before the worker acts on it, so a
  // directory swapped for an escaping symlink inside that window cannot redirect the operation outside
  // the Workspace. One test per operation, deliberately: each scenario spawns its own worker, so
  // running all seven under a single `it` stacked ~2.7s against the default 5s budget — and when it
  // lost that race it named none of the operations. Split, each reports itself and finishes with room.
  const raceIt = it.runIf(process.platform === 'darwin')

  // Arms the swap and hands back the paths it will move. `worker-input` fires it in the window before
  // the local worker reads its request; `move-commit` fires it in the move helper's commit window,
  // which is the only point at which a rename can still be redirected.
  async function raceFixture(
    label: string,
    at: 'worker-input' | 'move-commit' = 'worker-input'
  ): Promise<{
    workspace: WorkspaceRecord
    files: WorkspaceFiles
    requested: string
    held: string
    outside: string
  }> {
    const { root, workspace, host } = await localFixture(`files-race-${label}`)
    const requested = join(root, label)
    const held = join(root, `${label}-held`)
    // A sibling of the Workspace root, so reaching it is unambiguously an escape.
    const outside = join(dirname(root), `${label}-outside`)
    await Promise.all([mkdir(requested), mkdir(outside)])
    const swap = async () => {
      await rename(requested, held)
      await symlink(outside, requested, 'dir')
    }
    if (at === 'worker-input') localWorkerRace.beforeInput = swap
    return {
      workspace,
      files: at === 'move-commit'
        ? new WorkspaceFiles(() => host, { beforeLocalMoveCommit: swap })
        : new WorkspaceFiles(() => host),
      requested,
      held,
      outside
    }
  }

  // Each of these ends by asserting the hook was consumed: the mock clears it on use, so a null hook is
  // what proves the swap actually landed inside the window and the test was not vacuously green.
  raceIt('pins a read to the directory it already checked', async () => {
    const race = await raceFixture('read')
    await Promise.all([
      writeFile(join(race.requested, 'value.txt'), 'inside'),
      writeFile(join(race.outside, 'value.txt'), 'outside-secret')
    ])
    await expect(race.files.read(race.workspace, 'read/value.txt')).resolves.toEqual({
      status: 'read',
      document: {
        path: 'read/value.txt',
        content: 'inside',
        revision: revision('inside')
      }
    })
    await expect(readFile(join(race.outside, 'value.txt'), 'utf8')).resolves.toBe('outside-secret')
    expect(localWorkerRace.beforeInput).toBeNull()
  })

  raceIt('pins a directory listing to the directory it already checked', async () => {
    const race = await raceFixture('list')
    await Promise.all([
      writeFile(join(race.requested, 'inside.txt'), 'inside'),
      writeFile(join(race.outside, 'outside.txt'), 'outside')
    ])
    await expect(race.files.readDirectory(race.workspace, 'list')).resolves.toEqual([
      { name: 'inside.txt', path: 'list/inside.txt', isDirectory: false, isSymlink: false }
    ])
    expect(localWorkerRace.beforeInput).toBeNull()
  })

  raceIt('pins a reveal to the directory it already checked', async () => {
    const race = await raceFixture('reveal')
    await Promise.all([
      writeFile(join(race.requested, 'inside.txt'), 'inside'),
      writeFile(join(race.outside, 'inside.txt'), 'outside')
    ])
    const revealed = await race.files.localPathForReveal(race.workspace, 'reveal/inside.txt')
    expect(revealed).toBe(await realpath(join(race.held, 'inside.txt')))
    expect(localWorkerRace.beforeInput).toBeNull()
  })

  raceIt('pins a create to the directory it already checked', async () => {
    const race = await raceFixture('create')
    await race.files.create(race.workspace, { path: 'create/new.txt', kind: 'file' })
    await expect(access(join(race.held, 'new.txt'))).resolves.toBeUndefined()
    await expect(access(join(race.outside, 'new.txt'))).rejects.toThrow()
    expect(localWorkerRace.beforeInput).toBeNull()
  })

  raceIt('pins a write to the directory it already checked', async () => {
    const race = await raceFixture('write')
    await Promise.all([
      writeFile(join(race.requested, 'value.txt'), 'inside'),
      writeFile(join(race.outside, 'value.txt'), 'outside-secret')
    ])
    await expect(race.files.write(race.workspace, {
      path: 'write/value.txt',
      content: 'updated',
      expectedRevision: revision('inside')
    })).resolves.toEqual({ status: 'written', revision: revision('updated') })
    await expect(readFile(join(race.held, 'value.txt'), 'utf8')).resolves.toBe('updated')
    await expect(readFile(join(race.outside, 'value.txt'), 'utf8')).resolves.toBe('outside-secret')
    expect(localWorkerRace.beforeInput).toBeNull()
  })

  // The move helper cannot pin its parent the way a single-path operation can, so it fails closed
  // instead. The escape verdict itself is the proof the swap landed: without it the move succeeds.
  raceIt('refuses a move whose parent is replaced at commit, leaving both trees untouched', async () => {
    const race = await raceFixture('rename', 'move-commit')
    await Promise.all([
      writeFile(join(race.requested, 'before.txt'), 'inside'),
      writeFile(join(race.outside, 'before.txt'), 'outside-secret')
    ])
    await expect(race.files.move(race.workspace, race.workspace, {
      source: { workspaceId: race.workspace.id, path: 'rename/before.txt' },
      destination: { workspaceId: race.workspace.id, path: 'rename/after.txt' }
    })).resolves.toMatchObject({
      status: 'error',
      code: 'WORKSPACE_PATH_ESCAPE',
      finalLocation: 'source'
    })
    await expect(readFile(join(race.held, 'before.txt'), 'utf8')).resolves.toBe('inside')
    await expect(access(join(race.held, 'after.txt'))).rejects.toThrow()
    await expect(readFile(join(race.outside, 'before.txt'), 'utf8')).resolves.toBe('outside-secret')
    await expect(access(join(race.outside, 'after.txt'))).rejects.toThrow()
  })

  raceIt('pins a delete to the directory it already checked', async () => {
    const race = await raceFixture('delete')
    await Promise.all([
      writeFile(join(race.requested, 'victim.txt'), 'inside'),
      writeFile(join(race.outside, 'victim.txt'), 'outside-secret')
    ])
    await race.files.delete(race.workspace, 'delete/victim.txt')
    await expect(access(join(race.held, 'victim.txt'))).rejects.toThrow()
    await expect(readFile(join(race.outside, 'victim.txt'), 'utf8')).resolves.toBe('outside-secret')
    expect(localWorkerRace.beforeInput).toBeNull()
  })

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

  it('reports a local directory as a directory rather than a read error', async () => {
    const { root, workspace, host } = await localFixture('local-directory-read')
    await mkdir(join(root, 'docs'))
    await writeFile(join(root, 'docs', 'design.md'), 'body')
    const files = new WorkspaceFiles(() => host)

    // Anchor: a real file under it still reads, so the directory answer is a classification of the
    // target, not a blanket failure of the subtree.
    await expect(files.read(workspace, 'docs/design.md')).resolves.toEqual({
      status: 'read',
      document: { path: 'docs/design.md', content: 'body', revision: revision('body') }
    })
    await expect(files.read(workspace, 'docs')).resolves.toEqual({ status: 'directory' })
  })

  it('reports a remote directory as a directory without parsing cat stderr', async () => {
    const run = vi.fn<ExecutionHost['run']>(async (command, args) => {
      if (command === 'realpath') {
        return { stdout: `${String(args.at(-1))}\n`, stderr: '', exitCode: 0 }
      }
      if (command === 'sh') {
        const target = args.at(-1)
        // The classify-or-stream probe exits 3 for a directory and streams bytes otherwise.
        return target === '/srv/project/docs'
          ? { stdout: '', stderr: '', exitCode: 3 }
          : { stdout: 'body', stderr: '', exitCode: 0 }
      }
      throw new Error(`Unexpected command: ${command}`)
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

    await expect(files.read(workspace, 'docs/design.md')).resolves.toEqual({
      status: 'read',
      document: { path: 'docs/design.md', content: 'body', revision: revision('body') }
    })
    await expect(files.read(workspace, 'docs')).resolves.toEqual({ status: 'directory' })
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
    await expect(files.read(workspace, 'document.txt')).resolves.toEqual({ status: 'directory' })

    await dispose()
    expect(workspaceFileObserverCount()).toBe(0)
    const afterDispose = invalidations
    await rm(path, { recursive: true })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(invalidations).toBe(afterDispose)
  })

  it('keeps reporting changes after its worker dies mid-observation, and says the gap happened', async () => {
    // `observe` promises "you hear about every change until you dispose". The worker underneath cannot
    // promise that: it watches the PARENT DIRECTORY, so it dies when that directory is renamed or
    // deleted and when the OS runs out of watch descriptors — and a death AFTER it reports OBSERVING
    // used to vanish without a trace, because `ready` had already resolved and there was nothing left
    // to reject. The editor then sat on the content it last read, forever, looking exactly like a file
    // nobody was touching.
    //
    // So this kills the established child for real (SIGKILL, so it cannot run its own shutdown) and
    // then writes to the file. Two facts have to hold, and neither one did before:
    //   - the death itself reaches the listener, because the file may have changed while nothing was
    //     watching and only a re-read can close that gap;
    //   - a change made AFTERWARDS still arrives, which is only true if a live worker replaced the
    //     dead one.
    // A test that only asserted the second could pass on a lucky race; the observer count pins that a
    // replacement really exists rather than the old child somehow surviving.
    const { root, workspace, host } = await localFixture('observer-death')
    const path = join(root, 'document.txt')
    await writeFile(path, 'alpha')
    const files = new WorkspaceFiles(() => host)
    let invalidations = 0
    const dispose = await files.observe(workspace, 'document.txt', () => {
      invalidations += 1
    })
    expect(workspaceFileObserverCount()).toBe(1)

    // `workspaceFileObserverCount` is module-global, so a failed assertion partway through would leak
    // a live worker into every later test and report itself as three unrelated failures. Disposal
    // therefore happens whatever the outcome, and the assertions live inside.
    try {
      // The observer children are recorded by the spawn mock, so this is the real pid of the real
      // worker — killable exactly the way the OS kills it.
      const pids = [...localWorkerRace.observerPids]
      expect(pids).toHaveLength(1)
      process.kill(pids[0]!, 'SIGKILL')

      // The death is a change report in its own right: the file went unwatched, so the caller has to
      // re-read to find out what it missed.
      await waitFor(() => invalidations > 0)
      // And the observation is live again, not merely reported dead. A new pid is the proof — the count
      // alone would also read 1 if the dead child had somehow stayed registered.
      await waitFor(() => (
        workspaceFileObserverCount() === 1 &&
        localWorkerRace.observerPids.length === 2 &&
        localWorkerRace.observerPids[1] !== pids[0]
      ))

      const afterRespawn = invalidations
      await writeFile(path, 'bravo')
      await waitFor(() => invalidations > afterRespawn)
    } finally {
      await dispose()
      await files.dispose()
    }
    expect(workspaceFileObserverCount()).toBe(0)
  })

  it('stops observing when the directory is gone for good, and lets a later reopen start clean', async () => {
    // The other half of a worker death: the respawn cannot even start, because the watched directory
    // really is gone. There is nothing to keep alive, so the observation ends — but the cached entry
    // has to go with it. `WorkspaceFiles` hands the entry under this key to every later `observe` of
    // the same file, so a kept entry means the next editor that opens it attaches to a subscription
    // nobody is serving, and never hears about a change again.
    //
    // Measured on this fixture: deleting the directory alone does NOT kill the worker (a Darwin watch
    // descriptor outlives the directory it was opened on), so both halves are needed to reach this
    // path — the directory gone AND the child dead.
    const { root, workspace, host } = await localFixture('observer-lost')
    await mkdir(join(root, 'sub'))
    const path = join(root, 'sub', 'document.txt')
    await writeFile(path, 'alpha')
    const files = new WorkspaceFiles(() => host)
    let invalidations = 0
    const dispose = await files.observe(workspace, 'sub/document.txt', () => {
      invalidations += 1
    })
    expect(workspaceFileObserverCount()).toBe(1)

    try {
      const [pid] = localWorkerRace.observerPids
      await rm(join(root, 'sub'), { recursive: true })
      process.kill(pid!, 'SIGKILL')

      // The listener still hears one report — the file went unwatched, and only a re-read can say
      // what happened to it. That read is what reports the deletion.
      await waitFor(() => invalidations > 0)
      // No worker is left running, and no respawn is looping trying to reach a directory that is gone.
      await waitFor(() => workspaceFileObserverCount() === 0)
      const attempts = localWorkerRace.observerPids.length
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(localWorkerRace.observerPids).toHaveLength(attempts)

      // Reopening the same file gets a NEW worker, which only happens if the dead entry was dropped.
      await mkdir(join(root, 'sub'))
      await writeFile(path, 'bravo')
      let reopened = 0
      const disposeReopened = await files.observe(workspace, 'sub/document.txt', () => {
        reopened += 1
      })
      try {
        expect(localWorkerRace.observerPids.length).toBeGreaterThan(attempts)
        await writeFile(path, 'charlie')
        await waitFor(() => reopened > 0)
      } finally {
        await disposeReopened()
      }
    } finally {
      await dispose()
      await files.dispose()
    }
    expect(workspaceFileObserverCount()).toBe(0)
  })

  it('does not finish WorkspaceFiles disposal before observer children close', async () => {
    const { root, workspace, host } = await localFixture('observation-disposal')
    await writeFile(join(root, 'document.txt'), 'alpha')
    const files = new WorkspaceFiles(() => host)
    const disposeObservation = await files.observe(workspace, 'document.txt', () => {})
    expect(workspaceFileObserverCount()).toBe(1)

    await files.dispose()

    expect(workspaceFileObserverCount()).toBe(0)
    await disposeObservation()
  })

  it('closes a pending observer start before disposal and rejects its registration', async () => {
    const { root, workspace, host } = await localFixture('pending-observation-disposal')
    await writeFile(join(root, 'document.txt'), 'alpha')
    const files = new WorkspaceFiles(() => host)
    let inputReached!: () => void
    let releaseInput!: () => void
    const reached = new Promise<void>((resolve) => { inputReached = resolve })
    const release = new Promise<void>((resolve) => { releaseInput = resolve })
    localWorkerRace.beforeObserverInput = async () => {
      inputReached()
      await release
    }

    const observation = files.observe(workspace, 'document.txt', () => {})
    await reached
    const disposal = files.dispose()
    releaseInput()

    await expect(observation).rejects.toThrow('WorkspaceFiles is disposed')
    await disposal
    expect(workspaceFileObserverCount()).toBe(0)
  })

  it('waits for a last-listener shutdown already in progress', async () => {
    const { root, workspace, host } = await localFixture('concurrent-observation-disposal')
    await writeFile(join(root, 'document.txt'), 'alpha')
    const files = new WorkspaceFiles(() => host)
    const disposeObservation = await files.observe(workspace, 'document.txt', () => {})
    let killReached!: () => void
    let releaseKill!: () => void
    const reached = new Promise<void>((resolve) => { killReached = resolve })
    const release = new Promise<void>((resolve) => { releaseKill = resolve })
    localWorkerRace.beforeObserverKill = async () => {
      killReached()
      await release
    }

    const listenerDisposal = disposeObservation()
    await reached
    let filesDisposed = false
    const filesDisposal = files.dispose().then(() => { filesDisposed = true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(filesDisposed).toBe(false)

    releaseKill()
    await Promise.all([listenerDisposal, filesDisposal])
    expect(workspaceFileObserverCount()).toBe(0)
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
    await expect(files.move(workspace, workspace, {
      source: { workspaceId: workspace.id, path: 'src/new.ts' },
      destination: { workspaceId: workspace.id, path: 'moved.ts' }
    })).resolves.toEqual({ status: 'moved' })
    await expect(files.move(workspace, workspace, {
      source: { workspaceId: workspace.id, path: 'moved.ts' },
      destination: { workspaceId: workspace.id, path: 'src/renamed.ts' }
    })).resolves.toEqual({ status: 'moved' })
    await expect(access(join(root, 'src', 'renamed.ts'))).resolves.toBeUndefined()
    await expect(files.create(workspace, { path: 'escape/stolen.txt', kind: 'file' })).rejects.toThrow(
      'Path escapes the workspace root'
    )
    await files.delete(workspace, 'src/lib')
    await expect(access(join(root, 'src', 'lib'))).rejects.toThrow()
    await expect(files.delete(workspace, '')).rejects.toThrow('workspace root cannot be changed')
  })

  it('moves files and directories across parents without clobbering or self-containment', async () => {
    const { root, workspace, host } = await localFixture('move')
    await Promise.all([
      mkdir(join(root, 'source')),
      mkdir(join(root, 'destination'))
    ])
    await writeFile(join(root, 'source', 'file.txt'), 'file bytes')
    const files = new WorkspaceFiles(() => host)

    await expect(files.move(workspace, workspace, {
      source: { workspaceId: workspace.id, path: 'source/file.txt' },
      destination: { workspaceId: workspace.id, path: 'destination/file.txt' }
    })).resolves.toEqual({ status: 'moved' })
    await expect(access(join(root, 'source', 'file.txt'))).rejects.toThrow()
    await expect(readFile(join(root, 'destination', 'file.txt'), 'utf8')).resolves.toBe('file bytes')

    await mkdir(join(root, 'source', 'tree'))
    await writeFile(join(root, 'source', 'tree', 'child.txt'), 'source child')
    await mkdir(join(root, 'destination', 'tree'))
    await writeFile(join(root, 'destination', 'tree', 'sentinel.txt'), 'destination child')
    await expect(files.move(workspace, workspace, {
      source: { workspaceId: workspace.id, path: 'source/tree' },
      destination: { workspaceId: workspace.id, path: 'destination/tree' }
    })).resolves.toMatchObject({
      status: 'error',
      code: 'WORKSPACE_MOVE_DESTINATION_EXISTS',
      finalLocation: 'source'
    })
    await expect(readFile(join(root, 'source', 'tree', 'child.txt'), 'utf8')).resolves.toBe('source child')
    await expect(readFile(join(root, 'destination', 'tree', 'sentinel.txt'), 'utf8')).resolves.toBe('destination child')

    await expect(files.move(workspace, workspace, {
      source: { workspaceId: workspace.id, path: 'source/tree' },
      destination: { workspaceId: workspace.id, path: 'source/tree/nested' }
    })).resolves.toMatchObject({
      status: 'error',
      code: 'WORKSPACE_MOVE_INTO_SELF',
      finalLocation: 'source'
    })
    await expect(readFile(join(root, 'source', 'tree', 'child.txt'), 'utf8')).resolves.toBe('source child')
  })

  it('atomically refuses a destination created after validation and derives final location', async () => {
    const { root, workspace, host } = await localFixture('move-fault')
    await Promise.all([
      mkdir(join(root, 'source')),
      mkdir(join(root, 'destination'))
    ])
    await writeFile(join(root, 'source', 'racing.txt'), 'source bytes')
    const racingMove = new WorkspaceFiles(() => host, {
      beforeLocalMoveCommit: async () => {
        await writeFile(join(root, 'destination', 'racing.txt'), 'competing bytes')
      }
    })
    await expect(racingMove.move(workspace, workspace, {
      source: { workspaceId: workspace.id, path: 'source/racing.txt' },
      destination: { workspaceId: workspace.id, path: 'destination/racing.txt' }
    })).resolves.toMatchObject({
      status: 'error',
      code: 'WORKSPACE_MOVE_DESTINATION_EXISTS',
      finalLocation: 'source'
    })
    await expect(readFile(join(root, 'source', 'racing.txt'), 'utf8')).resolves.toBe('source bytes')
    await expect(readFile(join(root, 'destination', 'racing.txt'), 'utf8')).resolves.toBe('competing bytes')

    const relocatedParent = join(root, '..', 'relocated-destination')
    await Promise.all([
      mkdir(join(root, 'relocating-destination')),
      writeFile(join(root, 'source', 'relocated-parent.txt'), 'confined source bytes')
    ])
    const relocatingParentMove = new WorkspaceFiles(() => host, {
      beforeLocalMoveCommit: async () => {
        await rename(join(root, 'relocating-destination'), relocatedParent)
      }
    })
    await expect(relocatingParentMove.move(workspace, workspace, {
      source: { workspaceId: workspace.id, path: 'source/relocated-parent.txt' },
      destination: { workspaceId: workspace.id, path: 'relocating-destination/relocated-parent.txt' }
    })).resolves.toMatchObject({
      status: 'error',
      code: 'WORKSPACE_MOVE_PATH_NOT_FOUND',
      finalLocation: 'source'
    })
    await expect(readFile(join(root, 'source', 'relocated-parent.txt'), 'utf8')).resolves.toBe(
      'confined source bytes'
    )
    await expect(access(join(relocatedParent, 'relocated-parent.txt'))).rejects.toThrow()

    await writeFile(join(root, 'source', 'missing-helper.txt'), 'source survives')
    const missingHelperMove = new WorkspaceFiles(() => host, {
      localMoveHelperPath: join(root, 'missing-workspace-move-helper')
    })
    await expect(missingHelperMove.move(workspace, workspace, {
      source: { workspaceId: workspace.id, path: 'source/missing-helper.txt' },
      destination: { workspaceId: workspace.id, path: 'destination/missing-helper.txt' }
    })).resolves.toMatchObject({
      status: 'error',
      code: 'WORKSPACE_MOVE_HELPER_UNAVAILABLE',
      finalLocation: 'source'
    })
    await expect(readFile(join(root, 'source', 'missing-helper.txt'), 'utf8')).resolves.toBe('source survives')
    await expect(access(join(root, 'destination', 'missing-helper.txt'))).rejects.toThrow()

    await writeFile(join(root, 'source', 'before.txt'), 'before')
    const beforeMove = new WorkspaceFiles(() => host, {
      beforeLocalMoveCommit: async () => {
        throw new Error('injected before move failure')
      }
    })
    await expect(beforeMove.move(workspace, workspace, {
      source: { workspaceId: workspace.id, path: 'source/before.txt' },
      destination: { workspaceId: workspace.id, path: 'destination/before.txt' }
    })).resolves.toMatchObject({
      status: 'error',
      code: 'WORKSPACE_MOVE_COMMIT_HOOK_FAILED',
      finalLocation: 'source'
    })
    await expect(readFile(join(root, 'source', 'before.txt'), 'utf8')).resolves.toBe('before')
    await expect(access(join(root, 'destination', 'before.txt'))).rejects.toThrow()

    await writeFile(join(root, 'source', 'after.txt'), 'after')
    const afterMove = new WorkspaceFiles(() => host, {
      afterLocalMoveCommit: async () => {
        throw new Error('injected move receipt failure')
      }
    })
    await expect(afterMove.move(workspace, workspace, {
      source: { workspaceId: workspace.id, path: 'source/after.txt' },
      destination: { workspaceId: workspace.id, path: 'destination/after.txt' }
    })).resolves.toMatchObject({
      status: 'error',
      code: 'WORKSPACE_MOVE_RESULT_UNKNOWN',
      finalLocation: 'unknown'
    })
    await expect(access(join(root, 'source', 'after.txt'))).rejects.toThrow()
    await expect(readFile(join(root, 'destination', 'after.txt'), 'utf8')).resolves.toBe('after')

    await writeFile(join(root, 'source', 'ambiguous.txt'), 'original bytes')
    const ambiguousMove = new WorkspaceFiles(() => host, {
      afterLocalMoveCommit: async () => {
        await writeFile(join(root, 'source', 'ambiguous.txt'), 'replacement bytes')
        throw new Error('injected ambiguous move receipt failure')
      }
    })
    await expect(ambiguousMove.move(workspace, workspace, {
      source: { workspaceId: workspace.id, path: 'source/ambiguous.txt' },
      destination: { workspaceId: workspace.id, path: 'destination/ambiguous.txt' }
    })).resolves.toMatchObject({ status: 'error', finalLocation: 'unknown' })
    await expect(readFile(join(root, 'source', 'ambiguous.txt'), 'utf8')).resolves.toBe('replacement bytes')
    await expect(readFile(join(root, 'destination', 'ambiguous.txt'), 'utf8')).resolves.toBe('original bytes')

    await expect(afterMove.move(workspace, workspace, {
      source: { workspaceId: 'forged-workspace', path: 'source/missing.txt' },
      destination: { workspaceId: workspace.id, path: 'destination/missing.txt' }
    })).resolves.toMatchObject({
      status: 'error',
      code: 'WORKSPACE_MOVE_OWNER_MISMATCH',
      finalLocation: 'source'
    })
    await expect(afterMove.move(workspace, workspace, {
      source: { workspaceId: workspace.id, path: '../outside.txt' },
      destination: { workspaceId: workspace.id, path: 'destination/outside.txt' }
    })).resolves.toMatchObject({
      status: 'error',
      code: 'WORKSPACE_MOVE_INVALID_PATH',
      finalLocation: 'source'
    })
    await expect(afterMove.move(workspace, workspace, {
      source: { workspaceId: workspace.id, path: 'source/same.txt' },
      destination: { workspaceId: workspace.id, path: 'source/same.txt' }
    })).resolves.toMatchObject({
      status: 'error',
      code: 'WORKSPACE_MOVE_SAME_PATH',
      finalLocation: 'source'
    })

    const otherWorkspace = { ...workspace, id: 'other-workspace' }
    await expect(afterMove.move(workspace, otherWorkspace, {
      source: { workspaceId: workspace.id, path: 'source/missing.txt' },
      destination: { workspaceId: otherWorkspace.id, path: 'destination/missing.txt' }
    })).resolves.toMatchObject({
      status: 'error',
      code: 'WORKSPACE_MOVE_CROSS_WORKSPACE',
      finalLocation: 'source'
    })
    await expect(afterMove.move(workspace, {
      ...workspace,
      id: 'other-host-workspace',
      hostId: 'other-host'
    }, {
      source: { workspaceId: workspace.id, path: 'source/missing.txt' },
      destination: { workspaceId: 'other-host-workspace', path: 'destination/missing.txt' }
    })).resolves.toMatchObject({
      status: 'error',
      code: 'WORKSPACE_MOVE_CROSS_HOST',
      finalLocation: 'source'
    })
  })

  it('does not infer object identity from paths after a missing move receipt', async () => {
    const { root, workspace, host } = await localFixture('move-unknown')

    const prepareMove = async (label: string) => {
      const sourceParent = join(root, `${label}-source`)
      const destinationParent = join(root, `${label}-destination`)
      const source = join(sourceParent, 'item.txt')
      const destination = join(destinationParent, 'item.txt')
      await Promise.all([mkdir(sourceParent), mkdir(destinationParent)])
      await writeFile(source, `original ${label}`)
      return {
        source,
        destination,
        sourcePath: `${label}-source/item.txt`,
        destinationPath: `${label}-destination/item.txt`
      }
    }

    const moveWithMissingReceipt = async (
      paths: Awaited<ReturnType<typeof prepareMove>>,
      mutateAfterCommit: () => Promise<void>
    ) => {
      const files = new WorkspaceFiles(() => host, {
        afterLocalMoveCommit: async () => {
          await mutateAfterCommit()
          throw new Error('injected move receipt failure')
        }
      })
      await expect(files.move(workspace, workspace, {
        source: { workspaceId: workspace.id, path: paths.sourcePath },
        destination: { workspaceId: workspace.id, path: paths.destinationPath }
      })).resolves.toMatchObject({
        status: 'error',
        code: 'WORKSPACE_MOVE_RESULT_UNKNOWN',
        finalLocation: 'unknown'
      })
    }

    const destinationOriginal = await prepareMove('destination-original')
    await moveWithMissingReceipt(destinationOriginal, async () => {})
    await expect(access(destinationOriginal.source)).rejects.toThrow()
    await expect(readFile(destinationOriginal.destination, 'utf8')).resolves.toBe(
      'original destination-original'
    )

    const sourceReplacement = await prepareMove('source-replacement')
    await moveWithMissingReceipt(sourceReplacement, async () => {
      await writeFile(sourceReplacement.source, 'unrelated source replacement')
    })
    await expect(readFile(sourceReplacement.source, 'utf8')).resolves.toBe(
      'unrelated source replacement'
    )
    await expect(readFile(sourceReplacement.destination, 'utf8')).resolves.toBe(
      'original source-replacement'
    )

    const movedBack = await prepareMove('moved-back')
    await moveWithMissingReceipt(movedBack, async () => {
      await rename(movedBack.destination, movedBack.source)
    })
    await expect(readFile(movedBack.source, 'utf8')).resolves.toBe('original moved-back')
    await expect(access(movedBack.destination)).rejects.toThrow()

    const bothAbsent = await prepareMove('both-absent')
    await moveWithMissingReceipt(bothAbsent, async () => {
      await rm(bothAbsent.destination)
    })
    await expect(access(bothAbsent.source)).rejects.toThrow()
    await expect(access(bothAbsent.destination)).rejects.toThrow()

    const destinationReplacement = await prepareMove('destination-replacement')
    await moveWithMissingReceipt(destinationReplacement, async () => {
      await rm(destinationReplacement.destination)
      await writeFile(destinationReplacement.destination, 'unrelated destination replacement')
    })
    await expect(access(destinationReplacement.source)).rejects.toThrow()
    await expect(readFile(destinationReplacement.destination, 'utf8')).resolves.toBe(
      'unrelated destination replacement'
    )

    const replacedParent = await prepareMove('replaced-parent')
    const heldDestinationParent = join(root, 'replaced-parent-destination-held')
    await moveWithMissingReceipt(replacedParent, async () => {
      await rename(join(root, 'replaced-parent-destination'), heldDestinationParent)
      await mkdir(join(root, 'replaced-parent-destination'))
    })
    await expect(access(replacedParent.source)).rejects.toThrow()
    await expect(readFile(join(heldDestinationParent, 'item.txt'), 'utf8')).resolves.toBe(
      'original replaced-parent'
    )
    await expect(access(replacedParent.destination)).rejects.toThrow()

    const interleaved = await prepareMove('interleaved')
    let occupancyReadStarted = false
    await moveWithMissingReceipt(interleaved, async () => {
      localWorkerRace.beforeInput = async () => {
        occupancyReadStarted = true
        await rm(interleaved.destination)
        await writeFile(interleaved.source, 'replacement during occupancy read')
      }
    })
    expect(occupancyReadStarted).toBe(false)
    localWorkerRace.beforeInput = null
    await expect(access(interleaved.source)).rejects.toThrow()
    await expect(readFile(interleaved.destination, 'utf8')).resolves.toBe('original interleaved')

    const replacedRoot = await prepareMove('replaced-root')
    const heldRoot = join(root, '..', 'workspace-held')
    await moveWithMissingReceipt(replacedRoot, async () => {
      await rename(root, heldRoot)
      await mkdir(root)
    })
    await expect(access(join(root, 'replaced-root-source', 'item.txt'))).rejects.toThrow()
    await expect(readFile(join(heldRoot, replacedRoot.destinationPath), 'utf8')).resolves.toBe(
      'original replaced-root'
    )
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
    await expect(files.move(workspace, workspace, {
      source: { workspaceId: workspace.id, path: 'src/new.ts' },
      destination: { workspaceId: workspace.id, path: 'src/renamed.ts' }
    })).resolves.toMatchObject({
      status: 'error',
      code: 'REMOTE_WORKSPACE_FILE_MOVE_UNSUPPORTED',
      finalLocation: 'source'
    })
    await files.delete(workspace, 'src/new.ts')

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
    expect(run).toHaveBeenCalledWith('rm', ['-rf', '--', '/srv/project/src/new.ts'], {
      timeoutMs: 15_000
    })
    expect(run.mock.calls.flatMap(([, args]) => args).join('\n')).not.toContain('mv --')
  })
})
