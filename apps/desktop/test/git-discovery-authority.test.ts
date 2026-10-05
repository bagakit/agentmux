import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost, type ExecutionHost } from '@agentmux/core'
import { GitService } from '../src/main/git-service.js'
import { WorktreeService } from '../src/main/worktree-service.js'
import type { AppConfig } from '../src/shared/contracts.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'amx-git-authority-'))
  roots.push(path)
  const host = new LocalExecutionHost()
  const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }],
    executors: {}, appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: {} }, workspaces: [{ id: 'test', name: 'test', hostId: 'local', kind: 'folder', path }] } as AppConfig
  // Only diagnostic words change. The actual same-host Node filesystem producer still runs.
  const runner: ExecutionHost = { id: host.id, kind: host.kind, label: host.label,
    dispose: () => host.dispose(), run: async (command, args, options) => {
      const result = await host.run(command, args, options)
      return command === 'git' && result.exitCode === 128
        ? { ...result, stderr: 'diagnostic wording without repository classification' } : result
    } }
  return { path, runner, config }
}
describe('Git discovery authority through both product services', () => {
  it('confirms a plain folder from filesystem facts with arbitrary Git diagnostic wording', async () => {
    const { runner, config } = await fixture()
    expect((await new GitService(() => runner).status('test', config)).kind).toBe('not-a-git-repository')
    expect((await new WorktreeService(() => runner, { save: vi.fn() }).list('test', config)).kind).toBe('not-a-git-repository')
  })
  it('preserves corrupt metadata as an error in both services despite identical diagnostic wording', async () => {
    const { path, runner, config } = await fixture()
    await mkdir(join(path, '.git'))
    await writeFile(join(path, '.git', 'HEAD'), 'ref: refs/heads/\n')
    await expect(new GitService(() => runner).status('test', config)).rejects.toThrow('diagnostic wording')
    await expect(new WorktreeService(() => runner, { save: vi.fn() }).list('test', config)).rejects.toThrow('diagnostic wording')
  })
  it('keeps unavailable metadata observation unknown rather than granting absence', async () => {
    const { runner, config } = await fixture()
    const unavailable: ExecutionHost = { ...runner, run: async (command, args, options) => command === 'node'
      ? { exitCode: 127, stdout: '', stderr: 'observer unavailable' } : runner.run(command, args, options) }
    await expect(new GitService(() => unavailable).status('test', config)).rejects.toThrow('diagnostic wording')
    await expect(new WorktreeService(() => unavailable, { save: vi.fn() }).list('test', config)).rejects.toThrow('diagnostic wording')
  })
})
