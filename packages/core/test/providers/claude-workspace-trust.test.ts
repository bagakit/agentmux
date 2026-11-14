import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rm, rmdir, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentProviderRegistry } from '../../src/agent-provider.js'
import { claudeGlobalConfigPath, claudeTrustKey, prepareClaudeOwnedWorkspaceTrust } from '../../src/providers/claude-workspace-trust.js'

/**
 * Pre-trusting an AgentMux-owned home is what stops Claude's "Is this a project you trust?"
 * dialog from eating the first question (its cursor rests on "No, exit"). The Host confirms the
 * home; this module records trust for it the way Claude reads it back. Each case names the
 * property that would be lost if the module were changed.
 */
describe('Claude owned-workspace trust', () => {
  let base: string, home: string, motes: string, workspace: string, config: string
  const env = () => ({ HOME: home })
  const read = async (path = config) => JSON.parse(await readFile(path, 'utf8')) as { projects: Record<string, Record<string, unknown>>; [key: string]: unknown }
  const prepare = (workspacePath = workspace, environment: Record<string, string> = env()) =>
    prepareClaudeOwnedWorkspaceTrust({ ownedRoot: workspacePath, workspacePath, env: environment })

  beforeEach(async () => {
    // A real temporary root: on macOS tmpdir() itself sits behind the /var -> /private/var symlink.
    base = await realpath(await mkdtemp(join(tmpdir(), 'amx-claude-trust-')))
    home = join(base, 'home'); motes = join(home, '.agentmux', 'motes'); workspace = join(motes, 'a1b2c3d4e5f60718')
    await mkdir(workspace, { recursive: true })
    config = join(home, '.claude.json')
    await writeFile(config, JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { accountUuid: 'u' },
      projects: { '/elsewhere': { hasTrustDialogAccepted: false, lastCost: 1 } } }, null, 2), { mode: 0o600 })
  })
  afterEach(async () => { await rm(base, { recursive: true, force: true }) })

  it('trusts exactly the confirmed home once and keeps every other key byte-for-byte', async () => {
    const before = await read()
    const receipt = await prepare()
    expect(receipt).toMatchObject({ status: 'trusted', trustKey: workspace, configPath: config })
    const after = await read()
    expect(after.projects[workspace]).toEqual({ hasTrustDialogAccepted: true })
    // Only that one entry is added: not the root above it, and not onboarding, account or other projects.
    expect(after.projects[motes]).toBeUndefined()
    expect({ ...after, projects: { ...after.projects, [workspace]: undefined } }).toEqual({ ...before, projects: { ...before.projects, [workspace]: undefined } })
    expect((await stat(config)).mode & 0o777).toBe(0o600)
  })

  it('does not rewrite the file when the home is already trusted', async () => {
    await prepare()
    const past = new Date(Date.now() - 60_000)
    await utimes(config, past, past)
    const pinned = (await stat(config)).mtimeMs
    const receipt = await prepare()
    expect(receipt.status).toBe('already-trusted')
    expect((await stat(config)).mtimeMs).toBe(pinned)
  })

  it('keeps an existing entry and only flips its trust flag', async () => {
    const value = await read()
    value.projects[workspace] = { hasTrustDialogAccepted: false, allowedTools: ['Read'], lastSessionId: 's' }
    await writeFile(config, JSON.stringify(value, null, 2))
    await prepare()
    expect((await read()).projects[workspace]).toEqual({ hasTrustDialogAccepted: true, allowedTools: ['Read'], lastSessionId: 's' })
  })

  it('never creates a missing configuration: Claude owns its own onboarding', async () => {
    await rm(config)
    const receipt = await prepare()
    expect(receipt).toMatchObject({ status: 'unconfirmed', code: 'CLAUDE_CONFIG_ABSENT' })
    await expect(stat(config)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('records the real path for a home launched through an alias, because Claude looks trust up by its realpath cwd', async () => {
    // A retained Session can still name its home through an old address, such as
    // `scratch/topic--...` -> `../motes/<id>`. Claude starts in the physical directory.
    const scratch = join(home, '.agentmux', 'scratch'); await mkdir(scratch)
    const alias = join(scratch, 'topic--launcher--leader'); await symlink('../motes/a1b2c3d4e5f60718', alias)
    const receipt = await prepare(alias)
    expect(receipt).toMatchObject({ status: 'trusted', trustKey: workspace })
    const after = await read()
    expect(after.projects[workspace]).toEqual({ hasTrustDialogAccepted: true })
    expect(after.projects[alias]).toBeUndefined()
  })

  it('records the real path when an ancestor of the home is a symlink, such as a relocated ~/.agentmux', async () => {
    const physical = join(base, 'volume', 'agentmux'); await mkdir(join(physical, 'motes', 'f0e1d2c3b4a59687'), { recursive: true })
    const linkedRoot = join(home, 'linked-agentmux'); await symlink(physical, linkedRoot)
    const spelled = join(linkedRoot, 'motes', 'f0e1d2c3b4a59687')
    const receipt = await prepare(spelled)
    expect(receipt).toMatchObject({ status: 'trusted', trustKey: join(physical, 'motes', 'f0e1d2c3b4a59687') })
    const after = await read()
    expect(after.projects[join(physical, 'motes', 'f0e1d2c3b4a59687')]).toEqual({ hasTrustDialogAccepted: true })
    expect(after.projects[spelled]).toBeUndefined()
  })

  it('reports an unresolvable home as unconfirmed without writing', async () => {
    const before = await readFile(config, 'utf8')
    const receipt = await prepare(join(motes, 'missing-home'))
    expect(receipt).toMatchObject({ status: 'unconfirmed', trustKey: null, code: 'CLAUDE_TRUST_UNCONFIRMED' })
    expect(await readFile(config, 'utf8')).toBe(before)
  })

  it('refuses a different directory even when a caller supplies a home ancestor', async () => {
    const nested = join(workspace, 'foreign')
    await mkdir(nested)
    const before = await readFile(config, 'utf8')
    const receipt = await prepareClaudeOwnedWorkspaceTrust({ ownedRoot: workspace, workspacePath: nested, env: env() })
    expect(receipt).toMatchObject({ status: 'not-applicable', code: 'CLAUDE_TRUST_HOME_MISMATCH' })
    expect(await readFile(config, 'utf8')).toBe(before)
  })

  it('writes through a symlinked configuration to its target and keeps the link, as Claude does', async () => {
    // A dotfiles layout: ~/.claude.json -> dotfiles/claude.json.
    const dotfiles = join(base, 'dotfiles'); await mkdir(dotfiles)
    const target = join(dotfiles, 'claude.json')
    await writeFile(target, await readFile(config, 'utf8'), { mode: 0o600 }); await rm(config)
    await symlink('../dotfiles/claude.json', config)
    const receipt = await prepare()
    expect(receipt).toMatchObject({ status: 'trusted', configPath: config })
    expect((await lstat(config)).isSymbolicLink()).toBe(true)
    expect(await readlink(config)).toBe('../dotfiles/claude.json')
    expect((await read(target)).projects[workspace]).toEqual({ hasTrustDialogAccepted: true })
    expect((await stat(target)).mode & 0o777).toBe(0o600)
    // The temporary file was staged beside the real target and renamed onto it; nothing is left behind.
    expect((await readdir(dotfiles)).sort()).toEqual(['claude.json'])
    expect((await readdir(home)).filter(name => name.includes('agentmux-'))).toEqual([])
  })

  it('keeps Claude\'s lock beside the spelled configuration path even when it is a symlink', async () => {
    const dotfiles = join(base, 'dotfiles'); await mkdir(dotfiles)
    await writeFile(join(dotfiles, 'claude.json'), await readFile(config, 'utf8')); await rm(config)
    await symlink(join(dotfiles, 'claude.json'), config)
    await mkdir(`${config}.lock`)
    const pending = prepare()
    await new Promise(done => setTimeout(done, 120))
    // Still waiting on Claude's lock at the spelled path, so nothing was written yet.
    expect((await read(join(dotfiles, 'claude.json'))).projects[workspace]).toBeUndefined()
    await rmdir(`${config}.lock`)
    expect((await pending).status).toBe('trusted')
    await expect(stat(join(dotfiles, 'claude.json.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('answers an already-trusted home without waiting on a lock Claude is holding', async () => {
    await prepare()
    await mkdir(`${config}.lock`)
    const started = Date.now()
    const receipt = await prepare()
    expect(receipt.status).toBe('already-trusted')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('waits for a Claude-held lock and keeps the key Claude wrote meanwhile', async () => {
    const lock = `${config}.lock`
    await mkdir(lock)
    const pending = prepare()
    await new Promise(done => setTimeout(done, 120))
    // Claude, holding its lock, saves a new key; it then releases.
    const value = await read(); value.numStartups = 7
    await writeFile(config, JSON.stringify(value, null, 2))
    await rmdir(lock)
    expect((await pending).status).toBe('trusted')
    const after = await read()
    expect(after.numStartups).toBe(7)
    expect(after.projects[workspace]).toEqual({ hasTrustDialogAccepted: true })
    await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reclaims an abandoned lock older than proper-lockfile\'s stale window', async () => {
    const lock = `${config}.lock`; await mkdir(lock)
    const old = new Date(Date.now() - 30_000); await utimes(lock, old, old)
    expect((await prepare()).status).toBe('trusted')
  })

  it('reports an unparseable configuration as unconfirmed without writing', async () => {
    await writeFile(config, '{ not json')
    const receipt = await prepare()
    expect(receipt.status).toBe('unconfirmed')
    expect(await readFile(config, 'utf8')).toBe('{ not json')
  })

  it('follows CLAUDE_CONFIG_DIR and a non-empty legacy .config.json the way Claude does', async () => {
    const dir = join(base, 'cfg'); await mkdir(dir)
    expect(await claudeGlobalConfigPath({ HOME: home, CLAUDE_CONFIG_DIR: dir })).toBe(join(dir, '.claude.json'))
    await writeFile(join(dir, '.config.json'), '{}')
    expect(await claudeGlobalConfigPath({ HOME: home, CLAUDE_CONFIG_DIR: dir })).toBe(join(dir, '.config.json'))
    expect(await claudeGlobalConfigPath({ HOME: home })).toBe(join(home, '.claude.json'))
  })

  it('keys a folder by its NFC real path', async () => {
    // Created decomposed (e + U+0301); Claude records the composed form (U+00E9).
    const decomposed = join(base, 'café'); await mkdir(decomposed)
    expect(await claudeTrustKey(decomposed)).toBe(join(base, 'café'))
    expect(await claudeTrustKey(join(dirname(workspace), '.', 'a1b2c3d4e5f60718'))).toBe(workspace)
  })

  it('is the Claude Provider\'s registered capability', () => {
    expect(new AgentProviderRegistry().get('claude').prepareOwnedWorkspaceTrust).toBe(prepareClaudeOwnedWorkspaceTrust)
  })
})
