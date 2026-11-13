import { mkdir, mkdtemp, readFile, realpath, rm, rmdir, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentProviderRegistry } from '../../src/agent-provider.js'
import { claudeGlobalConfigPath, claudeTrustKey, prepareClaudeOwnedWorkspaceTrust } from '../../src/providers/claude-workspace-trust.js'

/**
 * Pre-trusting an AgentMux-owned home is what stops Claude's "Is this a project you trust?"
 * dialog from eating the first question (its cursor rests on "No, exit"). Each case below
 * names the property that would be lost if the module were changed.
 */
describe('Claude owned-workspace trust', () => {
  let base: string, home: string, motes: string, workspace: string, config: string
  const env = () => ({ HOME: home })
  const read = async () => JSON.parse(await readFile(config, 'utf8')) as { projects: Record<string, Record<string, unknown>>; [key: string]: unknown }

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'amx-claude-trust-')))
    home = join(base, 'home'); motes = join(home, '.agentmux', 'motes'); workspace = join(motes, 'a1b2c3d4e5f60718')
    await mkdir(workspace, { recursive: true })
    config = join(home, '.claude.json')
    await writeFile(config, JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { accountUuid: 'u' },
      projects: { '/elsewhere': { hasTrustDialogAccepted: false, lastCost: 1 } } }, null, 2), { mode: 0o600 })
  })
  afterEach(async () => { await rm(base, { recursive: true, force: true }) })

  it('trusts the owned root once and keeps every other key byte-for-byte', async () => {
    const before = await read()
    const receipt = await prepareClaudeOwnedWorkspaceTrust({ ownedRoot: motes, workspacePath: workspace, env: env() })
    expect(receipt).toMatchObject({ status: 'trusted', trustKey: claudeTrustKey(motes), configPath: config })
    const after = await read()
    expect(after.projects[motes]).toEqual({ hasTrustDialogAccepted: true })
    // Only one project entry is added; onboarding, account and other projects are untouched.
    expect({ ...after, projects: { ...after.projects, [motes]: undefined } }).toEqual({ ...before, projects: { ...before.projects, [motes]: undefined } })
    expect((await stat(config)).mode & 0o777).toBe(0o600)
  })

  it('does not rewrite the file when the root is already trusted', async () => {
    await prepareClaudeOwnedWorkspaceTrust({ ownedRoot: motes, workspacePath: workspace, env: env() })
    const past = new Date(Date.now() - 60_000)
    await utimes(config, past, past)
    const pinned = (await stat(config)).mtimeMs
    const receipt = await prepareClaudeOwnedWorkspaceTrust({ ownedRoot: motes, workspacePath: workspace, env: env() })
    expect(receipt.status).toBe('already-trusted')
    expect((await stat(config)).mtimeMs).toBe(pinned)
  })

  it('keeps an existing entry and only flips its trust flag', async () => {
    const value = await read()
    value.projects[motes] = { hasTrustDialogAccepted: false, allowedTools: ['Read'], lastSessionId: 's' }
    await writeFile(config, JSON.stringify(value, null, 2))
    await prepareClaudeOwnedWorkspaceTrust({ ownedRoot: motes, workspacePath: workspace, env: env() })
    expect((await read()).projects[motes]).toEqual({ hasTrustDialogAccepted: true, allowedTools: ['Read'], lastSessionId: 's' })
  })

  it('never creates a missing configuration: Claude owns its own onboarding', async () => {
    await rm(config)
    const receipt = await prepareClaudeOwnedWorkspaceTrust({ ownedRoot: motes, workspacePath: workspace, env: env() })
    expect(receipt).toMatchObject({ status: 'unconfirmed', code: 'CLAUDE_CONFIG_ABSENT' })
    await expect(stat(config)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a workspace outside the owned root and leaves the file alone', async () => {
    const project = join(base, 'project'); await mkdir(project)
    const before = await readFile(config, 'utf8')
    const receipt = await prepareClaudeOwnedWorkspaceTrust({ ownedRoot: motes, workspacePath: project, env: env() })
    expect(receipt).toMatchObject({ status: 'not-applicable', trustKey: null })
    expect(await readFile(config, 'utf8')).toBe(before)
  })

  it('refuses a workspace that escapes the owned root through a symlink', async () => {
    const outside = join(base, 'outside'); await mkdir(outside)
    const link = join(motes, 'linked'); await symlink(outside, link)
    const receipt = await prepareClaudeOwnedWorkspaceTrust({ ownedRoot: motes, workspacePath: link, env: env() })
    expect(receipt.status).toBe('not-applicable')
    expect((await read()).projects[motes]).toBeUndefined()
  })

  it('refuses a path outside the root that only resolves into it: Claude looks trust up by the spelled path', async () => {
    const alias = join(base, 'alias'); await symlink(workspace, alias)
    const receipt = await prepareClaudeOwnedWorkspaceTrust({ ownedRoot: motes, workspacePath: alias, env: env() })
    expect(receipt.status).toBe('not-applicable')
    expect((await read()).projects[motes]).toBeUndefined()
  })

  it('answers an already-trusted root without waiting on a lock Claude is holding', async () => {
    await prepareClaudeOwnedWorkspaceTrust({ ownedRoot: motes, workspacePath: workspace, env: env() })
    await mkdir(`${config}.lock`)
    const started = Date.now()
    const receipt = await prepareClaudeOwnedWorkspaceTrust({ ownedRoot: motes, workspacePath: workspace, env: env() })
    expect(receipt.status).toBe('already-trusted')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('trusts a git home exactly, not the root, because Claude stops at an untrusted repository', async () => {
    await mkdir(join(workspace, '.git'))
    const nested = join(workspace, 'packages', 'app'); await mkdir(nested, { recursive: true })
    const receipt = await prepareClaudeOwnedWorkspaceTrust({ ownedRoot: motes, workspacePath: nested, env: env() })
    expect(receipt).toMatchObject({ status: 'trusted', trustKey: workspace })
    const after = await read()
    expect(after.projects[workspace]).toEqual({ hasTrustDialogAccepted: true })
    expect(after.projects[motes]).toBeUndefined()
  })

  it('leaves a foreign repository inside a home untrusted, so Claude still asks about it', async () => {
    const vendor = join(workspace, 'refs', 'vendor'); await mkdir(join(vendor, '.git'), { recursive: true })
    const before = await readFile(config, 'utf8')
    const receipt = await prepareClaudeOwnedWorkspaceTrust({ ownedRoot: motes, workspacePath: join(vendor), env: env() })
    expect(receipt).toMatchObject({ status: 'not-applicable', code: 'WORKSPACE_FOREIGN_REPOSITORY' })
    expect(await readFile(config, 'utf8')).toBe(before)
  })

  it('waits for a Claude-held lock and keeps the key Claude wrote meanwhile', async () => {
    const lock = `${config}.lock`
    await mkdir(lock)
    const pending = prepareClaudeOwnedWorkspaceTrust({ ownedRoot: motes, workspacePath: workspace, env: env() })
    await new Promise(done => setTimeout(done, 120))
    // Claude, holding its lock, saves a new key; it then releases.
    const value = await read(); value.numStartups = 7
    await writeFile(config, JSON.stringify(value, null, 2))
    await rmdir(lock)
    expect((await pending).status).toBe('trusted')
    const after = await read()
    expect(after.numStartups).toBe(7)
    expect(after.projects[motes]).toEqual({ hasTrustDialogAccepted: true })
    await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reclaims an abandoned lock older than proper-lockfile\'s stale window', async () => {
    const lock = `${config}.lock`; await mkdir(lock)
    const old = new Date(Date.now() - 30_000); await utimes(lock, old, old)
    expect((await prepareClaudeOwnedWorkspaceTrust({ ownedRoot: motes, workspacePath: workspace, env: env() })).status).toBe('trusted')
  })

  it('reports an unparseable configuration as unconfirmed without writing', async () => {
    await writeFile(config, '{ not json')
    const receipt = await prepareClaudeOwnedWorkspaceTrust({ ownedRoot: motes, workspacePath: workspace, env: env() })
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

  it('is the Claude Provider\'s registered capability', () => {
    expect(new AgentProviderRegistry().get('claude').prepareOwnedWorkspaceTrust).toBe(prepareClaudeOwnedWorkspaceTrust)
  })
})
