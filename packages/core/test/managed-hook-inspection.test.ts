import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseDocument } from 'yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentManagedHookInstaller, type AgentManagedHookPlan } from '../src/managed-hook-installer.js'
import { AgentProviderRegistry, BUILT_IN_AGENT_PROVIDERS } from '../src/agent-provider.js'

const scope = vi.hoisted(() => ({ home: '', growPath: '', unreadable: '' }))
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => scope.home }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, readFile: async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]) === scope.unreadable) throw Object.assign(new Error('private read failure'), { code: 'EACCES' })
    if (String(args[0]) === scope.growPath) { scope.growPath = ''; await fs.writeFile(args[0], 'x'.repeat(256 * 1024 + 1)) }
    return fs.readFile(...args)
  } }
})
let root: string
let installer: AgentManagedHookInstaller
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'amx-hook-inspection-'))
  scope.home = root
  installer = new AgentManagedHookInstaller(join(root, 'receipts'))
})
afterEach(async () => { scope.growPath = ''; scope.unreadable = ''; vi.useRealTimers(); await rm(root, { recursive: true, force: true }) })
const plan = (): AgentManagedHookPlan => ({ providerId: 'claude', mutations: [{ path: join(root, 'config.json'),
  content: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node agentmux-hook.js', timeout: 10 }] }] } }),
  mode: 0o600, merge: { kind: 'json-managed-events', marker: 'agentmux-hook.js' } }] })

async function snapshot(path: string) { const metadata = await stat(path); return { bytes: await readFile(path), mode: metadata.mode, mtime: metadata.mtimeMs } }

describe('fresh managed Hook disk observations', () => {
  it('observes every existing managed Provider plan and every companion without a second path registry', async () => {
    const providers = BUILT_IN_AGENT_PROVIDERS.filter(provider => provider.catalog.hookStrategy.kind === 'native' && provider.catalog.hookStrategy.installation === 'explicit-managed')
    expect(providers.length).toBeGreaterThanOrEqual(11)
    const plans = providers.map(provider => (new AgentProviderRegistry().get(provider.id).planManagedHooks?.({ workspacePath: root, env: {}, endpoint: { url: 'http://127.0.0.1:65535/hook', token: 'private-fixture-token' } }) ?? null)!)
    expect(plans.length).toBe(providers.length)
    for (const resolved of plans) {
      expect(resolved).not.toBeNull()
      expect(resolved.mutations.length).toBeGreaterThan(0)
      for (const mutation of resolved.mutations) expect(mutation.path.startsWith(root + '/')).toBe(true)
      expect((await installer.inspect(resolved)).status).toBe('not_installed')
      await installer.ensure(resolved)
      const before = await Promise.all(resolved.mutations.map(mutation => snapshot(mutation.path)))
      const result = await installer.inspect(resolved)
      expect(result.status, resolved.providerId).toBe('installed')
      expect(result.targets).toEqual(resolved.mutations.map(mutation => ({ path: mutation.path, status: 'current' })))
      expect(await Promise.all(resolved.mutations.map(mutation => snapshot(mutation.path)))).toEqual(before)
      if (resolved.mutations.length > 1) {
        await rm(resolved.mutations[1]!.path)
        expect((await installer.inspect(resolved)).status).toBe('partial')
      }
    }
  })

  it('reads live semantic ownership, ignoring formatting/foreign secrets but catching changed and stale managed commands', async () => {
    const resolved = plan(), path = resolved.mutations[0]!.path
    await writeFile(path, JSON.stringify({ secret: 'DO-NOT-REPORT', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'foreign-audit', timeout: 10 }] }] } }))
    expect((await installer.inspect(resolved)).status).toBe('not_installed')
    await installer.ensure(resolved)
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify(parsed))
    await chmod(path, 0o644)
    const before = await snapshot(path)
    for (let i = 0; i < 7; i++) expect((await installer.inspect(resolved)).status).toBe('installed')
    expect(await snapshot(path)).toEqual(before)
    const inspected = await installer.inspect(resolved)
    expect(JSON.stringify(inspected)).not.toMatch(/DO-NOT-REPORT|foreign-audit|node agentmux-hook/)
    parsed.hooks.Stop[1].hooks[0].command = 'node moved/agentmux-hook.js'
    await writeFile(path, JSON.stringify(parsed))
    expect((await installer.inspect(resolved)).status).toBe('partial')
    await installer.ensure(resolved)
    const repaired = JSON.parse(await readFile(path, 'utf8'))
    repaired.hooks.Obsolete = [{ command: 'stale agentmux-hook.js' }]
    await writeFile(path, JSON.stringify(repaired))
    expect((await installer.inspect(resolved)).status).toBe('partial')
    await installer.ensure(resolved)
    expect((await installer.inspect(resolved)).status).toBe('installed')
    // Observations never consume preview slots or create receipts.
    const previews = await Promise.all([0, 1, 2, 3].map(() => installer.preview(resolved)))
    expect(previews.length).toBe(4)
    await expect(installer.preview(resolved)).rejects.toMatchObject({ code: 'HOOK_PREVIEW_LIMIT' })
  })

  it('observes multi-file companion loss without creating any missing target, directory or receipt', async () => {
    const resolved = (new AgentProviderRegistry().get('hermes').planManagedHooks?.({ workspacePath: root, env: {} }) ?? null)!
    expect(resolved.mutations.length).toBe(2)
    for (let i = 0; i < 6; i++) expect((await installer.inspect(resolved)).status).toBe('not_installed')
    expect(await readdir(root)).toEqual([])
    await installer.ensure(resolved)
    await rm(resolved.mutations[1]!.path)
    const first = await snapshot(resolved.mutations[0]!.path)
    const result = await installer.inspect(resolved)
    expect(result.status).toBe('partial')
    expect(result.targets.map(target => target.status)).toEqual(['current', 'not_present'])
    expect(await snapshot(resolved.mutations[0]!.path)).toEqual(first)
    await expect(stat(resolved.mutations[1]!.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['json', 'schema', 'utf8', 'oversized', 'growth', 'symlink', 'unreadable'] as const)('reports %s as an inspection error without writes or secret output', async mode => {
    const resolved = plan(), path = resolved.mutations[0]!.path
    await writeFile(path, mode === 'utf8' ? Buffer.concat([Buffer.from('{"foreign":"'),Buffer.from([0xff]),Buffer.from('"}')]) : mode === 'json' ? '{ DO-NOT-REPORT' : mode === 'schema' ? '{"hooks":[]}' : mode === 'oversized' ? 'x'.repeat(256 * 1024 + 1) : '{}')
    if (mode === 'symlink') { const other = join(root, 'other'); await writeFile(other, '{}'); await rm(path); await symlink(other, path) }
    if (mode === 'unreadable') scope.unreadable = path
    if (mode === 'growth') scope.growPath = path
    const writes = vi.spyOn(await import('node:fs/promises'), 'writeFile')
    const result = await installer.inspect(resolved)
    expect(writes).not.toHaveBeenCalled()
    writes.mockRestore()
    expect(result.status).toBe('error')
    expect(result.targets).toEqual([{ path, status: 'error', code: mode === 'json' || mode === 'schema' || mode === 'utf8' ? 'HOOK_TARGET_UNPARSEABLE'
      : mode === 'oversized' || mode === 'growth' ? 'HOOK_FILE_TOO_LARGE' : mode === 'symlink' ? 'UNSAFE_HOOK_TARGET' : 'HOOK_TARGET_READ_FAILED' }])
    expect(JSON.stringify(result)).not.toContain('DO-NOT-REPORT')
    await expect(stat(join(root, 'receipts'))).rejects.toMatchObject({ code: 'ENOENT' })
    if (mode === 'growth') expect((await stat(path)).size).toBe(256 * 1024 + 1)
  })

  it('preserves semantic JSON key order and YAML comments while requiring every declared approval', async () => {
    const jsonPlan = plan()
    const reverse = (value: unknown): unknown => Array.isArray(value) ? value.map(reverse)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverse(entry)])) : value
    await writeFile(jsonPlan.mutations[0]!.path, JSON.stringify(reverse(JSON.parse(jsonPlan.mutations[0]!.content))))
    expect((await installer.inspect(jsonPlan)).status).toBe('installed')
    const hermes = (new AgentProviderRegistry().get('hermes').planManagedHooks?.({ workspacePath: root, env: {} }) ?? null)!
    await installer.ensure(hermes)
    const yaml = parseDocument(await readFile(hermes.mutations[0]!.path, 'utf8'))
    yaml.commentBefore = ' user comment'
    yaml.set('api_key', 'private-credential-never-report')
    await writeFile(hermes.mutations[0]!.path, yaml.toString() + '\n# trailing user comment\n')
    const approvals = JSON.parse(await readFile(hermes.mutations[1]!.path, 'utf8'))
    expect(approvals.approvals.length).toBeGreaterThan(0)
    for (const approval of approvals.approvals) approval.approved_at = 'native-extra-fact'
    approvals.approvals.push({event:'Other',command:'foreign-shell-hook',approved_at:'foreign-time'})
    await writeFile(hermes.mutations[1]!.path, JSON.stringify(approvals))
    const before = await Promise.all(hermes.mutations.map(mutation => snapshot(mutation.path)))
    const result = await installer.inspect(hermes)
    expect(result.targets).toEqual(hermes.mutations.map(mutation => ({ path: mutation.path, status: 'current' })))
    expect(result.status).toBe('installed')
    expect(await Promise.all(hermes.mutations.map(mutation => snapshot(mutation.path)))).toEqual(before)
    expect(JSON.stringify(result)).not.toMatch(/private-credential|foreign-shell-hook|native-extra-fact/)
    approvals.approvals.splice(0, 1)
    await writeFile(hermes.mutations[1]!.path, JSON.stringify(approvals))
    expect((await installer.inspect(hermes)).status).toBe('partial')
  })

  it('does not consume or invalidate an already approved preview during repeated observations', async () => {
    const resolved = plan()
    const preview = await installer.preview(resolved)
    for (let i = 0; i < 7; i++) expect((await installer.inspect(resolved)).status).toBe('not_installed')
    const receipt = await installer.install(preview.id)
    expect(receipt.entries.map(entry => entry.path)).toEqual([resolved.mutations[0]!.path])
    expect((await installer.inspect(resolved)).status).toBe('installed')
  })

  it('fresh reads and checkedAt change with disk edits, never returning an old cached installation result', async () => {
    const resolved = plan()
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1000)
    const absent = await installer.inspect(resolved)
    await mkdir(join(root, 'extra'))
    await writeFile(resolved.mutations[0]!.path, resolved.mutations[0]!.content)
    vi.setSystemTime(2000)
    const current = await installer.inspect(resolved)
    expect([absent.status, absent.checkedAt, current.status, current.checkedAt]).toEqual(['not_installed', 1000, 'installed', 2000])
  })
})
