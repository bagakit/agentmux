import { describe, expect, it, vi } from 'vitest'
import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts.js'
import type { ExecutionHost } from '@agentmux/core'
import { rebindLocalFolder } from '../src/main/workspace-rebind.js'
import { WorktreeService } from '../src/main/worktree-service.js'
import { configOwnerFixture, deferred } from './helpers/config-owner-fixture.js'

const folder: WorkspaceRecord = { id: 'folder', name: 'Project', hostId: 'local', path: '/project', kind: 'folder' }
const lane: WorkspaceRecord = { id: 'lane', name: 'Lane', hostId: 'local', path: '/lane', kind: 'worktree', repoPath: '/project', branch: 'lane' }
const sibling: WorkspaceRecord = { id: 'sibling', name: 'Other', hostId: 'local', path: '/other', kind: 'folder' }

describe('Main configuration short transactions', () => {
  it('merges simultaneous disjoint drafts from the same baseline and publishes each durable fact once', async () => {
    const f = await configOwnerFixture({ workspaces: [folder, lane] })
    const before = structuredClone(f.owner.current)
    await Promise.all([
      f.owner.edit(before, { ...before, copyPathsAsAbsolute: true }),
      f.owner.edit(before, { ...before, appearance: { ...before.appearance, terminalFontSize: 21 } })
    ])
    const expected = { ...before, copyPathsAsAbsolute: true, appearance: { ...before.appearance, terminalFontSize: 21 } }
    expect(f.owner.current).toEqual(expected)
    expect(await f.disk()).toEqual(expected)
    expect(f.publish.mock.calls.map(([config]) => [config.copyPathsAsAbsolute, config.appearance.terminalFontSize])).toEqual([[true, undefined], [true, 21]])
  })

  it('rejects stale same-field intent, keeps the committed value and does not write or publish the rejected draft', async () => {
    const f = await configOwnerFixture({ appearance: { terminalTheme: 'graphite', appAppearance: 'dark' } })
    const before = structuredClone(f.owner.current)
    await f.owner.update((current) => ({ ...current, appearance: { ...current.appearance, appAppearance: 'system' } }))
    const bytes = await f.bytes()
    await expect(f.owner.edit(before, { ...before, appearance: { ...before.appearance, appAppearance: 'light' } })).rejects.toMatchObject({ code: 'CONFIG_CONFLICT', field: 'appearance.appAppearance' })
    expect(await f.bytes()).toBe(bytes)
    expect(f.owner.current.appearance.appAppearance).toBe('system')
    expect(f.publish).toHaveBeenCalledTimes(1)
  })

  it('preserves a native remembered answer when a stale UI draft saves an unrelated preference', async () => {
    const f = await configOwnerFixture()
    const before = structuredClone(f.owner.current)
    await f.owner.update((current) => ({ ...current, browser: { ...current.browser, appLinkSchemes: { ...current.browser.appLinkSchemes, custom: 'deny' } } }))
    await f.owner.edit(before, { ...before, copyPathsAsAbsolute: true })
    expect(f.owner.current.browser.appLinkSchemes).toEqual({ custom: 'deny' })
    expect((await f.disk()).copyPathsAsAbsolute).toBe(true)
  })

  it('validates before Runtime preparation and leaves invalid input completely uncommitted', async () => {
    const f = await configOwnerFixture()
    const bytes = await f.bytes()
    const before = f.owner.current
    await expect(f.owner.edit(before, { ...before, hosts: [] })).rejects.toThrow('Local host is required')
    expect(f.runtime.prepare).not.toHaveBeenCalled()
    expect(f.publish).not.toHaveBeenCalled()
    expect(await f.bytes()).toBe(bytes)
  })

  it('keeps stable resource identities while independently editing, inserting and removing records', async () => {
    const f = await configOwnerFixture({ workspaces: [folder, lane] })
    const before = structuredClone(f.owner.current)
    await f.owner.update((current) => ({ ...current, workspaces: [...current.workspaces, sibling] }))
    await f.owner.edit(before, { ...before, workspaces: [{ ...folder, name: 'Renamed' }, lane] })
    await f.owner.edit(before, { ...before, workspaces: [folder] })
    expect(f.owner.current.workspaces).toEqual([{ ...folder, name: 'Renamed' }, sibling])
    expect((await f.disk()).workspaces).toEqual([{ ...folder, name: 'Renamed' }, sibling])
  })

  it('does not hold the owner while a real directory-rebind operation waits for the chooser', async () => {
    const f = await configOwnerFixture({ workspaces: [folder] })
    const chosen = deferred<{ canceled: boolean; filePaths: string[] }>()
    const chooseDirectory = vi.fn(() => chosen.promise)
    const rebinding = rebindLocalFolder(folder.id, f.owner.current, {
      chooseDirectory, save: (next, expected) => f.owner.edit(expected, next)
    })
    expect(chooseDirectory).toHaveBeenCalledWith('/')
    await f.owner.update((current) => ({ ...current, copyPathsAsAbsolute: true, workspaces: [...current.workspaces, sibling] }))
    expect((await f.disk()).copyPathsAsAbsolute).toBe(true)
    chosen.resolve({ canceled: false, filePaths: ['/moved/project'] })
    const result = await rebinding
    expect(result.config).toBe(f.owner.current)
    expect(result.workspace).toEqual({ ...folder, path: '/moved/project' })
    expect((await f.disk()).workspaces).toEqual([{ ...folder, path: '/moved/project' }, sibling])
    expect(f.owner.current.copyPathsAsAbsolute).toBe(true)
  })

  it('does not hold the owner during Git removal and withdraws only the named record afterwards', async () => {
    const f = await configOwnerFixture({ workspaces: [folder, lane] })
    const enteredGit = deferred<void>(), finishedGit = deferred<void>()
    const host = { run: vi.fn(async (command: string, args: string[]) => {
      if (command === 'git' && args.includes('remove')) { enteredGit.resolve(); await finishedGit.promise }
      return { exitCode: 0, stdout: '', stderr: '' }
    }) } as unknown as ExecutionHost
    const worktrees = new WorktreeService(() => host, { save: (next, expected) => f.owner.edit(expected, next) })
    const removal = worktrees.removeWorktree({ workspaceId: lane.id }, f.owner.current)
    await enteredGit.promise
    await f.owner.update((current) => ({ ...current, copyPathsAsAbsolute: true, workspaces: [...current.workspaces, sibling] }))
    expect((await f.disk()).copyPathsAsAbsolute).toBe(true)
    finishedGit.resolve()
    const result = await removal
    expect(result.removedPath).toBe('/lane')
    expect(result.config).toBe(f.owner.current)
    expect((await f.disk()).workspaces).toEqual([folder, sibling])
    expect(f.owner.current.copyPathsAsAbsolute).toBe(true)
    expect(host.run).toHaveBeenCalledWith('git', ['-C', '/project', 'worktree', 'remove', '--', '/lane'], expect.anything())
  })

  it('registers the worktree after Git add without dropping edits made while Git was running', async () => {
    const f = await configOwnerFixture({ workspaces: [folder] })
    const enteredGit = deferred<void>(), finishedGit = deferred<void>()
    const host = { run: vi.fn(async (_command: string, args: string[]) => {
      if (args.includes('add')) { enteredGit.resolve(); await finishedGit.promise }
      const stdout = args.includes('rev-parse') ? '/project\n'
        : args.includes('for-each-ref') ? 'main\n'
        : args.includes('list') ? 'worktree /project\0HEAD abc\0branch refs/heads/main\0\0' : ''
      return { exitCode: 0, stdout, stderr: '' }
    }) } as unknown as ExecutionHost
    const worktrees = new WorktreeService(() => host, { save: (next, expected) => f.owner.edit(expected, next) })
    const creating = worktrees.createForBranch({ workspaceId: folder.id, branch: 'new-lane', path: '/new-lane', createBranch: true }, f.owner.current)
    await enteredGit.promise
    await f.owner.update((current) => ({ ...current, copyPathsAsAbsolute: true, workspaces: [...current.workspaces, sibling] }))
    expect((await f.disk()).copyPathsAsAbsolute).toBe(true)
    finishedGit.resolve()
    const result = await creating
    expect(result.config).toBe(f.owner.current)
    expect((await f.disk()).workspaces).toEqual([folder, sibling, {
      id: result.workspace.id, name: 'new-lane', hostId: 'local', path: '/new-lane', kind: 'worktree', repoPath: '/project', branch: 'new-lane'
    }])
    expect(f.owner.current.copyPathsAsAbsolute).toBe(true)
  })

  it('can retry after failed persistence without poisoning the commit queue', async () => {
    const f = await configOwnerFixture()
    const before: AppConfig = f.owner.current
    f.save.mockRejectedValueOnce(new Error('disk full'))
    await expect(f.owner.edit(before, { ...before, copyPathsAsAbsolute: true })).rejects.toThrow('disk full')
    expect(f.publish).not.toHaveBeenCalled()
    await f.owner.edit(before, { ...before, copyPathsAsAbsolute: true })
    expect(f.publish).toHaveBeenCalledTimes(1)
    expect((await f.disk()).copyPathsAsAbsolute).toBe(true)
  })
})
