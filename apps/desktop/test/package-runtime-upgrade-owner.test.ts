import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const hooks = vi.hoisted(() => ({ exec: vi.fn(), live: vi.fn() }))
vi.mock('node:child_process', () => {
  const execFile = Object.assign(() => {}, { [Symbol.for('nodejs.util.promisify.custom')]: hooks.exec })
  return { execFile }
})
vi.mock('../../../packages/core/src/socket-liveness.ts', () => ({ probeSocketLiveness: hooks.live }))
const helper = process.env.AGENTMUX_UPGRADE_OWNER_PATH ?? resolve(import.meta.dirname, '../scripts/package-runtime-upgrade.mjs')
const installer = await import(pathToFileURL(helper).href)
const roots: string[] = []
const plans: any[] = []
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
afterEach(async () => {
  vi.restoreAllMocks()
  for (const plan of plans.splice(0)) await installer.closeRuntimeUpgrade(plan)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  hooks.exec.mockReset(); hooks.live.mockReset()
})

async function fixture(ledger: 'stale' | 'missing' | 'invalid' = 'stale') {
  const root = await mkdtemp('/tmp/amx-owner-unit-'); roots.push(root)
  const socket = join(root, 'runtime/ctxmux.sock'), configured = join(root, 'configured/ctxmux')
  const state = join(root, 'actual-state'), lock = join(state, 'state.lock')
  await mkdir(dirname(socket)); await mkdir(state); await writeFile(lock, '')
  const old = join(root, 'old.app'), candidate = join(root, 'candidate.app')
  const binaries: string[] = []
  for (const [index, app] of [old, candidate].entries()) {
    const core = join(app, 'Contents/Resources/app/node_modules/@agentmux/core')
    const vendor = join(core, 'vendor/ctxmux', `${process.platform}-${process.arch}`)
    await mkdir(join(core, 'dist'), { recursive: true }); await mkdir(join(vendor, 'bin'), { recursive: true })
    await writeFile(join(core, 'package.json'), '{"type":"module"}')
    await writeFile(join(core, 'dist/runtime-paths.js'), `export const defaultCtxmuxSocketPath=()=>${JSON.stringify(socket)};export const defaultCtxmuxStateDirectory=()=>${JSON.stringify(configured)};`)
    const bytes = Buffer.from(`never-executed-private-image-${index}`), archive = Buffer.from('never-unpacked-private-sdk')
    const binary = join(vendor, 'bin/ctxmuxd'); binaries.push(binary)
    await writeFile(binary, bytes); await writeFile(join(vendor, 'sdk.tgz'), archive)
    await writeFile(join(vendor, 'manifest.json'), JSON.stringify({ schema: 'ctxmux.local-artifacts.v1',
      support: { platform: process.platform, architecture: process.arch }, source: { commit: `source-${index}`, tree: `tree-${index}` },
      product: { protocol: 18 }, binaries: [{ name: 'ctxmuxd', path: 'bin/ctxmuxd', version: '0.1.0', sha256: sha(bytes) }],
      sdk: { archive: { path: 'sdk.tgz', sha256: sha(archive) } } }))
  }
  const receiptPath = join(dirname(socket), 'owner.json')
  if (ledger !== 'missing') await writeFile(receiptPath, ledger === 'invalid' ? 'not-json' : JSON.stringify({
    schema: 'agentmux.ctxmux-owner.v1', daemonInstanceId: 'previous-incarnation', stateDirectory: configured }), { mode: 0o600 })
  const pid = process.pid, uid = process.getuid!(), birth = `${pid} ${uid} Fri Oct 2 21:42:33 2026`
  const runtime = { runtimeId: 'persistent-runtime', daemonInstanceId: 'same-instance', buildId: 'ctxmuxd/0.1.0',
    protocolGeneration: 18, runtimeIdPersistence: 'state_dir', capabilities: { 'services.planned_exec_upgrade_continuity': 1 } }
  const run = { id: 'original-run', pid: 12345, backend: 'pty', acceptedInputBytes: 2, outputBytes: 50 }
  let signalled = false, mapped = binaries[0]!, currentLock = lock
  let extraLock = false, wrongInode = false, changeBirth = false
  let insideImage: string | undefined, insideLock: string | undefined
  let version = 'ctxmuxd 0.1.0 (protocol 18, handoff opaque-public-declaration)\n'
  let versionError: Error | undefined, versionChange: 'inode' | 'bytes' | undefined
  let versionCalls = 0
  const fields = async (fd: string, path: string) => {
    const metadata = await lstat(path, { bigint: true })
    return `f${fd}\ntREG\nD0x${metadata.dev.toString(16)}\ni${wrongInode && fd === 'txt' ? metadata.ino + 1n : metadata.ino}\nn${path}\n`
  }
  hooks.live.mockResolvedValue('alive')
  hooks.exec.mockImplementation(async (executable: string, args: string[]) => {
    if (executable === binaries[1] && args.length === 1 && args[0] === '--version') {
      expect(signalled).toBe(false); versionCalls++
      if (versionError) throw versionError
      if (versionChange === 'bytes') await writeFile(binaries[1]!, 'changed-private-image')
      if (versionChange === 'inode') { const next = `${binaries[1]}.next`; await copyFile(binaries[1]!, next); await rename(next, binaries[1]!) }
      return { stdout: version }
    }
    if (executable === '/usr/bin/tar') return { stdout: '' }
    if (executable === '/bin/ps') return { stdout: changeBirth ? `${birth}-changed` : birth }
    if (executable === '/usr/sbin/lsof') {
      if (args.includes('-U')) return { stdout: `p${pid}\nu${uid}\nf7u\ntunix\nn${socket}\n` }
      const stdout = `p${pid}\nu${uid}\n${await fields('txt', mapped)}${await fields('11u', currentLock)}${extraLock ? await fields('12u', currentLock) : ''}`
      if (insideImage) { mapped = insideImage; insideImage = undefined }
      if (insideLock) { currentLock = insideLock; insideLock = undefined }
      return { stdout }
    }
    if (executable === process.execPath) {
      if (args.includes('--status')) return { stdout: JSON.stringify([{ ...run, state: { type: 'running' } }]) }
      return { stdout: JSON.stringify({ protocol: 18, runtime, running: [run] }) }
    }
    throw new Error(`Unexpected owning fixture command: ${executable}`)
  })
  const signal = vi.spyOn(process, 'kill').mockImplementation((target, name) => {
    expect(target).toBe(pid); expect(name).toBe('SIGHUP'); signalled = true; mapped = binaries[1]!; return true
  })
  return { root, old, candidate, configured, state, lock, receiptPath, binaries, signal,
    async prepare() { const plan = await installer.prepareRuntimeUpgrade(old, candidate); plans.push(plan); return plan },
    multipleLocks() { extraLock = true }, badImageInode() { wrongInode = true }, driftBirth() { changeBirth = true },
    async driftState() { currentLock = join(root, 'different-state/state.lock'); await mkdir(dirname(currentLock)); await writeFile(currentLock, '') },
    async driftDuringObservation(kind: 'image' | 'state') {
      const path = join(root, 'inside-observation', kind === 'image' ? 'ctxmuxd' : 'state.lock'); await mkdir(dirname(path))
      if (kind === 'image') { await copyFile(binaries[0]!, path); insideImage = path }
      else { await writeFile(path, ''); insideLock = path }
    },
    async alternatePostImage() {
      const path = join(root, 'actual-post-image/ctxmuxd'); await mkdir(dirname(path)); await link(binaries[1]!, path)
      signal.mockImplementation(() => { signalled = true; mapped = path; return true }); return path
    }, versionResponse(value: string) { version = value }, versionFailure(error: Error) { versionError = error },
    driftDuringVersion(kind: 'inode' | 'bytes') { versionChange = kind },
    versionCalls: () => versionCalls, wasSignalled: () => signalled }
}

it.each(['stale', 'missing', 'invalid'] as const)('qualifies actual authority despite a %s ledger and a different configured default', async ledger => {
  const f = await fixture(ledger), outcomes = await Promise.allSettled([f.prepare()])
  expect(outcomes).toHaveLength(1); expect(outcomes[0]!.status).toBe('fulfilled')
  if (outcomes[0]!.status !== 'fulfilled') throw outcomes[0]!.reason
  const plan = outcomes[0]!.value
  expect(plan.owner.state.directory).toBe(f.state); expect(plan.old.stateDirectory).toBe(f.configured)
  expect(plan.candidate.stateDirectory).toBe(f.configured); expect(f.state).not.toBe(f.configured)
  expect(plan.before.running).toEqual([{ id: 'original-run', pid: 12345, backend: 'pty', acceptedInputBytes: 2, outputBytes: 50 }])
  expect(plan.ownerReceipt.status).toBe(ledger === 'stale' ? 'mismatch' : ledger === 'invalid' ? 'unreadable' : 'missing')
  expect(f.signal).not.toHaveBeenCalled()
})
it('rejects ambiguous state descriptors before any signal', async () => {
  const f = await fixture(); f.multipleLocks()
  await expect(f.prepare()).rejects.toThrow('no unique state.lock'); expect(f.signal).not.toHaveBeenCalled()
})
it('rejects a mapped filename whose OS inode does not match the actual file', async () => {
  const f = await fixture(); f.badImageInode()
  await expect(f.prepare()).rejects.toThrow('same regular file'); expect(f.signal).not.toHaveBeenCalled()
})
it.each(['image', 'state'] as const)('rejects %s drift inside one observation even while PID, birth and socket stay the same', async kind => {
  const f = await fixture(); await f.driftDuringObservation(kind)
  await expect(f.prepare()).rejects.toThrow('files changed while')
  expect(f.signal).not.toHaveBeenCalled()
})
it('rejects state authority drift before handoff, preserves the stale ledger, and never signals', async () => {
  const f = await fixture(), plan = await f.prepare(), bytes = await readFile(f.receiptPath)
  await f.driftState()
  const outcome = await installer.finishRuntimeUpgrade(plan, f.candidate)
  expect(outcome.status).toBe('unknown'); expect(outcome.signalSent).toBe(false)
  expect(outcome.error).toContain('state authority changed'); expect(f.signal).not.toHaveBeenCalled()
  expect(await readFile(f.receiptPath)).toEqual(bytes)
})
it('rejects another birth identity before handoff without signaling or rewriting the ledger', async () => {
  const f = await fixture(), plan = await f.prepare(), bytes = await readFile(f.receiptPath)
  f.driftBirth()
  const outcome = await installer.finishRuntimeUpgrade(plan, f.candidate)
  expect(outcome.status).toBe('unknown'); expect(outcome.signalSent).toBe(false)
  expect(outcome.error).toContain('process identity changed'); expect(f.signal).not.toHaveBeenCalled()
  expect(await readFile(f.receiptPath)).toEqual(bytes)
})
it('records only the confirmed actual post-exec image and serving state, retaining identity and original Run', async () => {
  const f = await fixture(), plan = await f.prepare(), mappedPath = await f.alternatePostImage()
  const outcome = await installer.finishRuntimeUpgrade(plan, f.candidate)
  expect(outcome.status).toBe('upgraded'); expect(outcome.originalRuns).toBe(1); expect(f.wasSignalled()).toBe(true)
  expect(f.versionCalls()).toBe(1)
  expect(outcome.candidateVersion).toEqual({ version: '0.1.0', protocol: 18, handoff: 'opaque-public-declaration' })
  const receipt = JSON.parse(await readFile(f.receiptPath, 'utf8'))
  expect(receipt.daemonPath).toBe(mappedPath); expect(receipt.stateDirectory).toBe(f.state)
  expect(receipt.daemonSha256).toBe(sha(await readFile(f.binaries[1]!)))
  expect(receipt.runtimeId).toBe('persistent-runtime'); expect(receipt.daemonInstanceId).toBe('same-instance')
  expect((await lstat(f.receiptPath)).mode & 0o777).toBe(0o600)
})
it('does not claim same-native success from a signal while the original file remains mapped', async () => {
  const f = await fixture()
  await copyFile(f.binaries[0]!, f.binaries[1]!)
  const manifestPath = join(dirname(dirname(f.binaries[1]!)), 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.binaries[0].sha256 = sha(await readFile(f.binaries[1]!)); await writeFile(manifestPath, JSON.stringify(manifest))
  const plan = await f.prepare(), bytes = await readFile(f.receiptPath)
  f.signal.mockImplementation(() => true)
  let clock = 0; vi.spyOn(Date, 'now').mockImplementation(() => clock += 16000)
  const outcome = await installer.finishRuntimeUpgrade(plan, f.candidate)
  expect(outcome.status).toBe('old-confirmed'); expect(outcome.signalSent).toBe(true)
  expect(outcome.error).toContain('has not mapped'); expect(await readFile(f.receiptPath)).toEqual(bytes)
})

it.each(['timed out', 'exit 1'])('keeps the positively confirmed old service and ledger when candidate version %s, without signaling', async reason => {
  const f = await fixture(), plan = await f.prepare(), bytes = await readFile(f.receiptPath)
  f.versionFailure(new Error(`Private candidate version ${reason}`))
  const outcome = await installer.finishRuntimeUpgrade(plan, f.candidate)
  expect(outcome.status).toBe('old-confirmed'); expect(outcome.signalSent).toBe(false)
  expect(outcome.error).toContain(reason); expect(f.versionCalls()).toBe(1); expect(f.signal).not.toHaveBeenCalled()
  expect(await readFile(f.receiptPath)).toEqual(bytes)
})
it.each(['ctxmuxd 0.2.0 (protocol 18, handoff opaque)', 'ctxmuxd 0.1.0 (protocol 19, handoff opaque)',
  'ctxmuxd 0.1.0 (protocol 18, handoff )', ''])('rejects an unbound public version declaration %j before signaling', async response => {
  const f = await fixture(), plan = await f.prepare(), bytes = await readFile(f.receiptPath)
  f.versionResponse(response)
  const outcome = await installer.finishRuntimeUpgrade(plan, f.candidate)
  expect(outcome.status).toBe('old-confirmed'); expect(outcome.error).toContain('declare its selected')
  expect(outcome.signalSent).toBe(false); expect(f.versionCalls()).toBe(1); expect(f.signal).not.toHaveBeenCalled()
  expect(await readFile(f.receiptPath)).toEqual(bytes)
})
it.each(['inode', 'bytes'] as const)('rejects candidate %s drift during its actual version response and preserves the old ledger', async kind => {
  const f = await fixture(), plan = await f.prepare(), bytes = await readFile(f.receiptPath)
  f.driftDuringVersion(kind)
  // A broken pre-signal guard may reach the post-signal polling branch. Bound
  // that owning counterexample too, so the RED is a behavioral assertion.
  let clock = 0; vi.spyOn(Date, 'now').mockImplementation(() => clock += 16000)
  const outcome = await installer.finishRuntimeUpgrade(plan, f.candidate)
  expect(outcome.status).toBe('old-confirmed'); expect(outcome.error).toContain('changed while its version response')
  expect(outcome.signalSent).toBe(false); expect(f.versionCalls()).toBe(1); expect(f.signal).not.toHaveBeenCalled()
  expect(await readFile(f.receiptPath)).toEqual(bytes)
})
