import { fixturePath } from './helpers/fixture-values.js'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteCoreInstallManager, type RemoteCoreInstallProbe } from '../src/remote-core-install.js'
import { remoteCoreUpgradeTargetDigest, type RemoteCoreUpgradeHost } from '../src/remote-core-upgrade.js'
import { STAGE_CORE, SELECT_CORE_RELEASE } from '../src/remote-core-upgrade-programs.js'
import { PROBE_CORE_INSTALL, INSTALL_NODE, INSTALL_SERVICE, READ_INSTALLED_OWNER } from '../src/remote-core-install-programs.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const host: RemoteCoreUpgradeHost = { kind: 'ssh', id: 'fresh', label: 'Fresh server', hostname: 'fresh.invalid' }
const digest = 'c'.repeat(64), prefix = fixturePath('home/dev/.agentmux/server')

async function fixture(probe: Partial<RemoteCoreInstallProbe> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'core-install-')); roots.push(root)
  const archivePath = join(root, 'core.tar.gz'), nodePath = join(root, 'node.tar.gz')
  await writeFile(archivePath, 'portable-core'); await writeFile(nodePath, 'linux-node')
  const effects: string[] = []
  let current: RemoteCoreInstallProbe = { platform: 'linux', machine: 'x86_64', glibc: '2.36', home: fixturePath('home/dev'), prefix, user: 'dev',
    installed: false, socket: 'absent', availableBytes: 8 * 1024 ** 3, systemd: { user: true, linger: false }, ...probe }
  let failAt: string | undefined, lostAt: string | undefined, ownerReady = true, ownerReply: unknown = { runtimeId: 'new-runtime', availability: 'connected' }
  const run = vi.fn(async (command: string, args: string[], options: { input?: string | Uint8Array }) => {
    const input = String(options.input ?? '')
    const step = args[1] === PROBE_CORE_INSTALL ? 'probe' : args[1] === INSTALL_NODE ? 'node' : args[1] === STAGE_CORE ? 'stage'
      : args[1] === SELECT_CORE_RELEASE ? 'select' : args[1] === INSTALL_SERVICE ? 'service' : args[1] === READ_INSTALLED_OWNER ? 'owner' : 'other'
    if (step !== 'probe' && step !== 'owner') effects.push(step)
    if (failAt === step) return { stdout: '', stderr: `${step} refused`, exitCode: 1 }
    if (lostAt === step) throw new Error(`${step} reply lost`)
    let output: unknown
    if (step === 'probe') output = { ...current, prefix: JSON.parse(input).prefix ?? current.prefix }
    else if (step === 'node') {
      expect(command).toBe('/bin/sh'); expect(args.slice(3)).toEqual([prefix, 'v24.22.1', sha('linux-node')])
      expect(input).toBe(Buffer.from('linux-node').toString('base64'))
      output = { node: join(prefix, 'node', 'v24.22.1', 'bin', 'node') }
    } else if (step === 'stage') {
      expect(JSON.parse(input)).toMatchObject({ stateDirectory: join(prefix, 'state'), digest, node: join(prefix, 'node', 'v24.22.1', 'bin', 'node') })
      output = { releaseDirectory: join(prefix, 'state', 'core-releases', digest), remoteCommand: '', digest }
    } else if (step === 'select') output = { current: digest }
    else if (step === 'service') {
      const p = JSON.parse(input)
      output = { remoteCommand: join(prefix, 'bin', 'amux'), remoteSocketPath: join(prefix, 'runtime', 'control.sock'), startScript: join(prefix, 'start.sh'),
        unit: p.keepRunning === 'systemd' ? join(current.home, '.config/systemd/user/agentmux-core.service') : null }
    } else if (step === 'owner') {
      if (!ownerReady) throw new Error('not serving yet')
      output = { owner: ownerReply }
    } else throw new Error('Unexpected program')
    return { stdout: JSON.stringify(output), stderr: '', exitCode: 0 }
  })
  const manager = new RemoteCoreInstallManager({ stateDirectory: root, startPollMs: 1,
    executionHost: () => ({ id: 'fresh', kind: 'ssh' as const, label: 'Fresh', run, dispose: async () => {} }),
    artifact: async () => ({ digest, sourceCommit: 'source', version: '0.1.0', ownerProtocolVersion: 2, requiredNativeProtocolVersion: 25, nativeBuild: 'n', nativeDigest: 'b'.repeat(64),
      archivePath, archiveDigest: sha('portable-core'), files: [] }),
    node: async () => ({ path: nodePath, version: 'v24.22.1', sha256: sha('linux-node') }) })
  return { root, manager, effects, run,
    setProbe: (value: Partial<RemoteCoreInstallProbe>) => { current = { ...current, ...value } },
    failAt: (step: string) => { failAt = step }, loseAt: (step: string) => { lostAt = step }, ownerNotReady: () => { ownerReady = false },
    ownerReplies: (value: unknown) => { ownerReply = value } }
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

describe('first Core install', () => {
  it('checks read-only and offers both ways to keep running, with start at boot from linger', async () => {
    const f = await fixture()
    const check = await f.manager.check(host)
    expect(check).toMatchObject({ eligible: true, reason: 'ready', candidate: { digest }, node: { version: 'v24.22.1' },
      keepRunning: [{ mode: 'start-script', available: true, startsAtBoot: false }, { mode: 'systemd', available: true, startsAtBoot: false }],
      expected: { targetDigest: remoteCoreUpgradeTargetDigest(host), prefix, candidateDigest: digest, nodeSha256: sha('linux-node') } })
    expect(f.effects).toEqual([])
    f.setProbe({ systemd: { user: true, linger: true } })
    expect((await f.manager.check(host)).keepRunning?.[1]).toEqual({ mode: 'systemd', available: true, startsAtBoot: true })
    f.setProbe({ systemd: { user: false, linger: null } })
    expect((await f.manager.check(host)).keepRunning?.[1]).toEqual({ mode: 'systemd', available: false, startsAtBoot: null })
  })

  it.each([
    ['an installed release', { installed: true }, 'installed'],
    ['a serving Core', { socket: 'serving' as const }, 'installed'],
    ['an unconfirmed socket', { socket: 'unknown' as const }, 'unverified'],
    ['another architecture', { machine: 'aarch64' }, 'unsupported'],
    ['macOS', { platform: 'darwin' }, 'unsupported'],
    ['an old glibc', { glibc: '2.31' }, 'unsupported'],
    ['no glibc', { glibc: null }, 'unsupported'],
    ['too little space', { availableBytes: 1024 }, 'unsupported']
  ])('offers no install for %s', async (_name, probe, reason) => {
    const f = await fixture(probe)
    expect(await f.manager.check(host)).toMatchObject({ eligible: false, reason })
    expect(f.effects).toEqual([])
  })

  it.each(['start-script', 'systemd'] as const)('installs with %s, names the release current and reads the new identity', async keepRunning => {
    const f = await fixture(), check = await f.manager.check(host)
    const receipt = await f.manager.install(host, { ...check.expected!, keepRunning }, 'first')
    expect(receipt).toMatchObject({ status: 'completed', stage: 'completed', installed: { remoteCommand: join(prefix, 'bin', 'amux'),
      remoteSocketPath: join(prefix, 'runtime', 'control.sock'), runtimeId: 'new-runtime', unit: keepRunning === 'systemd' ? expect.stringContaining('agentmux-core.service') : null } })
    expect(f.effects).toEqual(['node', 'stage', 'select', 'service'])
    expect(receipt.detail).toContain(keepRunning === 'systemd' ? 'only after linger is enabled' : 'After this machine restarts')
    // The same operation ID reads the original result; nothing runs again.
    expect(await f.manager.install(host, { ...check.expected!, keepRunning }, 'first')).toEqual(receipt)
    expect(f.effects).toHaveLength(4)
  })

  it('refuses before any remote write when a Core appeared after the check', async () => {
    const f = await fixture(), check = await f.manager.check(host); f.setProbe({ socket: 'serving' })
    expect(await f.manager.install(host, { ...check.expected!, keepRunning: 'start-script' }, 'raced')).toMatchObject({ status: 'failed', stage: 'preparing' })
    expect(f.effects).toEqual([])
  })

  it('refuses systemd when the user manager is no longer available', async () => {
    const f = await fixture(), check = await f.manager.check(host); f.setProbe({ systemd: { user: false, linger: null } })
    expect(await f.manager.install(host, { ...check.expected!, keepRunning: 'systemd' }, 'no-systemd')).toMatchObject({ status: 'failed' })
    expect(f.effects).toEqual([])
  })

  it('refuses an admission for another Host route', async () => {
    const f = await fixture(), check = await f.manager.check(host)
    await expect(f.manager.install({ ...host, hostname: 'other.invalid' }, { ...check.expected!, keepRunning: 'start-script' }, 'moved')).rejects.toThrow('changed')
    expect(f.effects).toEqual([])
  })

  it.each([['node', 'pushing-node'], ['stage', 'staging-core'], ['service', 'starting']] as const)('keeps a %s failure after a remote write unknown and never repeats it', async (step, stage) => {
    const f = await fixture(), check = await f.manager.check(host); f.failAt(step)
    const receipt = await f.manager.install(host, { ...check.expected!, keepRunning: 'start-script' }, 'broken')
    expect(receipt).toMatchObject({ status: 'unknown', stage })
    const before = [...f.effects]
    expect(await new RemoteCoreInstallManager({ stateDirectory: f.root, artifact: async () => { throw new Error('unused') } }).inspect(host, 'broken')).toMatchObject({ status: 'unknown', stage })
    expect(await f.manager.install(host, { ...check.expected!, keepRunning: 'start-script' }, 'broken')).toMatchObject({ status: 'unknown' })
    expect(f.effects).toEqual(before)
  })

  it('keeps an install unknown when the new Core never confirms its identity', async () => {
    const f = await fixture(), check = await f.manager.check(host); f.ownerNotReady()
    expect(await f.manager.install(host, { ...check.expected!, keepRunning: 'start-script' }, 'silent')).toMatchObject({ status: 'unknown', stage: 'confirming' })
  })

  it.each([['no Runtime ID', { availability: 'connected' }], ['an empty Runtime ID', { runtimeId: '', availability: 'connected' }],
    ['an unavailable owner', { runtimeId: 'new-runtime', availability: 'unavailable' }]])('keeps an install unknown when the new Core reports %s', async (_name, owner) => {
    const f = await fixture(), check = await f.manager.check(host); f.ownerReplies(owner)
    expect(await f.manager.install(host, { ...check.expected!, keepRunning: 'start-script' }, 'odd-owner')).toMatchObject({ status: 'unknown', stage: 'confirming' })
  })

  it('treats a receipt naming another location as unknown', async () => {
    const f = await fixture(), check = await f.manager.check(host)
    const execute = f.run.getMockImplementation()!
    f.run.mockImplementation(async (command, args, options) => args[1] === INSTALL_NODE
      ? { stdout: JSON.stringify({ node: '/elsewhere/bin/node' }), stderr: '', exitCode: 0 } : await execute(command, args, options))
    expect(await f.manager.install(host, { ...check.expected!, keepRunning: 'start-script' }, 'moved-node')).toMatchObject({ status: 'unknown', stage: 'pushing-node' })
  })

  it('reserves the operation record exactly once and keeps it after the result', async () => {
    const f = await fixture(), check = await f.manager.check(host)
    await f.manager.install(host, { ...check.expected!, keepRunning: 'start-script' }, 'kept')
    const retained = JSON.parse(await readFile(join(f.root, 'install-operations', 'kept.json'), 'utf8'))
    expect(retained.receipt).toMatchObject({ operationId: 'kept', status: 'completed' })
  })
})
