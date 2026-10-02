import { win32 as _hygiene_win32 } from "node:path"
import { fixtureFileUrl as _hygiene_fixtureFileUrl, fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost, type ExecutionHost } from '@agentmux/core'
import type { AppConfig } from '../src/shared/contracts'
import { GitService, GIT_NONINTERACTIVE_ENV } from '../src/main/git-service'
import { normalizeGitProjectRemote } from '../src/shared/git-project-identity'

const roots: string[] = []
const options = { env: GIT_NONINTERACTIVE_ENV, timeoutMs: 20_000, maxOutputBytes: 2 * 1024 * 1024 }
const local = new LocalExecutionHost()
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

async function command(root: string, ...args: string[]) {
  const result = await local.run('git', ['-C', root, ...args], options)
  expect(result.exitCode, 'The private real-Git fixture must be established successfully').toBe(0)
  return result.stdout
}
async function folder() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-project-source-'))); roots.push(root); return root
}
async function repository() {
  const root = await folder()
  await command(root, 'init', '-q', '-b', 'original')
  await command(root, 'config', 'user.name', 'Private fixture')
  await command(root, 'config', 'user.email', 'private@example.invalid')
  await writeFile(join(root, 'original.txt'), 'Original committed content\n')
  await command(root, 'add', '--', 'original.txt'); await command(root, 'commit', '-q', '-m', 'Original work')
  await writeFile(join(root, 'original.txt'), 'Original dirty work remains\n')
  return root
}
function configuration(root: string): AppConfig {
  return { version: 9, hosts: [{ id: 'original-host', kind: 'ssh', label: 'Original device', hostname: 'private.invalid' }],
    executors: {}, workspaces: [{ id: 'original-workspace', hostId: 'original-host', path: root, name: 'Same project name', kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true,
      saveBookmark: true, more: true } } }
}
function owner(root: string) {
  // Actual Git executes in this private repository. Only the ExecutionHost transport
  // selector is instrumented; this is not a claim of a real remote SSH machine.
  const run = vi.fn<ExecutionHost['run']>((binary, args, input) => local.run(binary, args, input))
  const host: ExecutionHost = { id: 'original-host', kind: 'ssh', label: 'Original device', run, dispose: async () => {} }
  const decoy: ExecutionHost = { id: 'local', kind: 'local', label: 'Unrelated display device',
    run: async () => { throw new Error('The unrelated display Host must not read this repository') }, dispose: async () => {} }
  const hostFor = vi.fn((id: string) => id === host.id ? host : decoy)
  return { service: new GitService(hostFor), hostFor, run, config: configuration(root) }
}
async function originalFacts(root: string) {
  return { config: await readFile(join(root, '.git/config')), head: await readFile(join(root, '.git/HEAD')),
    index: await readFile(join(root, '.git/index')), refs: await command(root, 'for-each-ref', '--format=%(refname) %(objectname)'),
    content: await readFile(join(root, 'original.txt')) }
}

describe('configured Git Project sources', () => {
  it.each(['https://reader:private-token@CODE.example/Team/project.git',
    'ssh://git@code.example/Team/project', 'git@code.example:Team/project.git',
    'ssh://reader@code.example:22/Team/project.git', 'https://code.example:443/Team/project.git/'])
  ('normalizes equivalent HTTPS, SSH and scp sources without exposing userinfo: %s', remote => {
    const identity = normalizeGitProjectRemote(remote)
    expect(identity, 'Repository source normalization must exclude credentials and preserve equivalent addresses').toBe('code.example/Team/project')
    expect(identity).not.toMatch(/reader|git@|private-token/)
  })

  it('preserves repository path case, namespaces, servers and nondefault port distinctions', () => {
    const remotes = ['ssh://git@code.example:2222/Team/project.git', 'ssh://git@code.example:2200/Team/project.git',
      'https://code.example/Other/project.git', 'https://other.example/Team/project.git', 'https://code.example/team/project.git']
    const identities = remotes.map(normalizeGitProjectRemote)
    expect(identities.every(identity => identity !== null)).toBe(true)
    expect(new Set(identities).size, 'Different explicit source ports must remain different Project hints').toBe(remotes.length)
    expect(identities[0]).toBe('code.example:2222/Team/project')
  })

  it.each([_hygiene_fixturePath("srv/project.git"), '../project.git', _hygiene_fixtureFileUrl("srv/project.git"), _hygiene_win32.join("C:", _hygiene_win32.sep, "repos\\project.git"),
    'ext::unconfirmed-helper project', 'ssh://host/~other/project.git',
    'ssh://host/team/../project.git', 'git@host:../project.git', 'https://host/team/%2e%2e/project.git',
    'https://host/team/project?token=private-token', 'https://host/team/project#unknown',
    'https://', 'ssh://host/', '', 'git@host:team/project\nother'])
  ('keeps unsupported or ambiguous source addresses unknown: %s', remote => {
    expect(normalizeGitProjectRemote(remote)).toBeNull()
  })

  it('reads real Git through the original Workspace Host and preserves repository config, refs, index and dirty content', async () => {
    const root = await repository()
    await command(root, 'remote', 'add', 'origin', 'https://reader:private-token@code.example/Team/project.git')
    const fixture = owner(root), before = await originalFacts(root)
    expect(await fixture.service.projectIdentity('original-workspace', fixture.config), 'The exact Workspace Host must own the real-Git source read').toEqual({
      kind: 'known', hostId: 'original-host', repoPath: root, identities: ['code.example/Team/project'] })
    expect(fixture.hostFor.mock.calls).toEqual([['original-host']])
    expect(fixture.run.mock.calls.map(([, args]) => args)).toEqual([
      ['-C', root, 'rev-parse', '--show-toplevel'], ['-C', root, 'remote'],
      ['-C', root, 'remote', 'get-url', '--all', '--', 'origin'] ])
    for (const [binary, , runOptions] of fixture.run.mock.calls) {
      expect(binary).toBe('git'); expect(runOptions).toEqual(options)
    }
    expect(await originalFacts(root)).toEqual(before)
  })

  it('uses origin and never merges distinct forks because they share an upstream', async () => {
    const first = await repository(), second = await repository()
    for (const [root, source] of [[first, 'alice'], [second, 'bob']]) {
      await command(root!, 'remote', 'add', 'origin', ("https://code.example/" + (source) + _hygiene_fixturePath("project.git")))
      await command(root!, 'remote', 'add', 'upstream', 'https://code.example/shared/project.git')
    }
    const a = owner(first), b = owner(second)
    const one = await a.service.projectIdentity('original-workspace', a.config)
    const two = await b.service.projectIdentity('original-workspace', b.config)
    expect(one, 'A fork origin must not become its upstream Project').toMatchObject({ kind: 'known', identities: ['code.example/alice/project'] })
    expect(two).toMatchObject({ kind: 'known', identities: ['code.example/bob/project'] })
    if (one.kind === 'known' && two.kind === 'known') expect(one.identities.some(id => two.identities.includes(id))).toBe(false)
  })

  it('reads the sole source with Git insteadOf expansion and excludes unrelated push URLs', async () => {
    const root = await repository()
    await command(root, 'remote', 'add', 'source', 'private-alias:Team/project.git')
    await command(root, 'config', 'url.https://code.example/.insteadOf', 'private-alias:')
    await command(root, 'config', 'remote.source.pushurl', 'https://other.example/wrong/project.git')
    const fixture = owner(root)
    expect(await fixture.service.projectIdentity('original-workspace', fixture.config)).toMatchObject({
      kind: 'known', identities: ['code.example/Team/project'] })
    expect(fixture.run.mock.calls.at(-1)?.[1]).toEqual(['-C', root, 'remote', 'get-url', '--all', '--', 'source'])
  })

  it('deduplicates equivalent configured origin URLs while retaining distinct explicit source coordinates', async () => {
    const root = await repository()
    await command(root, 'remote', 'add', 'origin', 'https://code.example/Team/project.git')
    await command(root, 'config', '--add', 'remote.origin.url', 'git@code.example:Team/project')
    await command(root, 'config', '--add', 'remote.origin.url', 'ssh://git@code.example:2222/Team/project.git')
    const fixture = owner(root)
    expect(await fixture.service.projectIdentity('original-workspace', fixture.config)).toMatchObject({ kind: 'known',
      identities: ['code.example/Team/project', 'code.example:2222/Team/project'] })
  })

  it('keeps multiple sources without origin unavailable and leaves manual organization possible', async () => {
    const root = await repository()
    await command(root, 'remote', 'add', 'first', 'https://code.example/Team/project.git')
    await command(root, 'remote', 'add', 'second', 'https://other.example/Other/project.git')
    const fixture = owner(root), before = await originalFacts(root)
    expect(await fixture.service.projectIdentity('original-workspace', fixture.config)).toEqual({
      kind: 'unavailable', hostId: 'original-host', workspacePath: root,
      reason: 'Repository source is ambiguous; choose projects manually.' })
    expect(fixture.run).toHaveBeenCalledTimes(2)
    expect(await originalFacts(root)).toEqual(before)
  })

  it('reports no-remote only after a successful actual repository source read', async () => {
    const root = await repository(), fixture = owner(root)
    expect(await fixture.service.projectIdentity('original-workspace', fixture.config)).toEqual({ kind: 'no-remote', hostId: 'original-host', repoPath: root })
    expect(fixture.run).toHaveBeenCalledTimes(2)
  })

  it('distinguishes an actual plain folder from a Git observation failure', async () => {
    const root = await folder(), fixture = owner(root)
    expect(await fixture.service.projectIdentity('original-workspace', fixture.config)).toEqual({
      kind: 'not-a-git-repository', hostId: 'original-host', workspacePath: root })
    expect(fixture.run).toHaveBeenCalledTimes(1)
  })

  it('keeps unsupported origin unavailable without borrowing a recognized upstream', async () => {
    const root = await repository()
    await command(root, 'remote', 'add', 'origin', _hygiene_fixturePath("private/unconfirmed-source.git"))
    await command(root, 'remote', 'add', 'upstream', 'https://code.example/shared/project.git')
    const fixture = owner(root)
    expect(await fixture.service.projectIdentity('original-workspace', fixture.config)).toMatchObject({ kind: 'unavailable' })
  })

  it('keeps read failures unavailable with scrubbed diagnostics rather than claiming no-remote', async () => {
    const root = await folder(), fixture = owner(root)
    fixture.run.mockRejectedValue(new Error('Could not read https://reader:private-token@code.example/Team/project.git: access denied'))
    const result = await fixture.service.projectIdentity('original-workspace', fixture.config)
    expect(result, 'A failed Git read must remain unavailable rather than no-remote').toEqual({ kind: 'unavailable', hostId: 'original-host', workspacePath: root,
      reason: 'Could not read https://***@code.example/Team/project.git: access denied' })
    expect(JSON.stringify(result)).not.toContain('private-token')
  })

  it('rejects an unknown Workspace operation before borrowing any Host', async () => {
    const fixture = owner(_hygiene_fixturePath("private/unused"))
    await expect(fixture.service.projectIdentity('unknown-workspace', fixture.config)).rejects.toThrow('Unknown workspace')
    expect(fixture.hostFor).not.toHaveBeenCalled()
  })
})
