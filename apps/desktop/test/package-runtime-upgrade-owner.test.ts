const { fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
const { fixturePath: _hygiene_fixturePath, fixturePsBirth: _hygiene_fixturePsBirth } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { fstatSync, readSync } from 'node:fs'
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const hooks = vi.hoisted(() => ({ exec: vi.fn(), spawn: vi.fn(), live: vi.fn(), closeFailure: undefined as Error | undefined,
  openDrift: false }))
vi.mock('node:child_process', () => {
  const execFile = Object.assign(() => {}, { [Symbol.for('nodejs.util.promisify.custom')]: hooks.exec })
  return { execFile, spawn: hooks.spawn }
})
vi.mock('../../../packages/core/src/socket-liveness.ts', () => ({ probeSocketLiveness: hooks.live }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    if (hooks.openDrift) { hooks.openDrift = false; await actual.writeFile(args[0] as string, 'changed after manifest read before original open') }
    const original = await actual.open(...args)
    if (!hooks.closeFailure) return original
    return new Proxy(original, { get(target, key) {
      if (key === 'close') return async () => { await target.close(); throw hooks.closeFailure }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  } }
})
const helper = process.env.AGENTMUX_UPGRADE_OWNER_PATH ?? resolve(import.meta.dirname, '../scripts/package-runtime-upgrade.mjs')
const installer = await import(pathToFileURL(helper).href)
const roots: string[] = []
const plans: any[] = []
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
afterEach(async () => {
  vi.restoreAllMocks()
  for (const plan of plans.splice(0)) await installer.closeRuntimeUpgrade(plan)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  hooks.exec.mockReset(); hooks.spawn.mockReset(); hooks.live.mockReset()
  hooks.closeFailure = undefined
  hooks.openDrift = false
})

async function fixture(ledger: 'stale' | 'missing' | 'invalid' = 'stale') {
  const root = await mkdtemp(_hygiene_fixturePath("tmp/amx-owner-unit-")); roots.push(root)
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
  const pid = process.pid, uid = process.getuid!(), birth = ("" + (pid) + " " + (uid) + (" " + _hygiene_fixturePsBirth(23751753000)))
  const runtime = { runtimeId: 'persistent-runtime', daemonInstanceId: 'same-instance', buildId: 'ctxmuxd/0.1.0',
    protocolGeneration: 18, runtimeIdPersistence: 'state_dir', capabilities: { 'services.planned_exec_upgrade_continuity': 1 } }
  const run = { id: 'original-run', pid: 12345, backend: 'pty', acceptedInputBytes: 2, outputBytes: 50 }
  let signalled = false, mapped = binaries[0]!, currentLock = lock
  let extraLock = false, wrongInode = false, changeBirth = false, mappingReads = 0
  const startSeconds = String(Math.floor(Date.now() / 1000))
  let startMicroseconds = 123456, kernelReads = 0, insideBirthDrift = false, missingBirth = false, kernelUid = uid
  let displayBirth = birth
  let insideImage: string | undefined, insideLock: string | undefined
  let version = 'ctxmuxd 0.1.0 (protocol 18, handoff opaque-public-declaration)\n'
  let outgoingVersion = version
  let versionError: Error | undefined, versionChange: 'inode' | 'bytes' | undefined
  let versionCalls = 0
  let display = true, staticDrift: 'inode' | 'bytes' | 'restore-bytes' | undefined
  let staticArchitecture: string | undefined, staticExit = true, staticPrimary = false, staticCleanup = false
  const readerReceipts: any[] = []
  const fields = async (fd: string, path: string) => {
    const metadata = await lstat(path, { bigint: true })
    return `f${fd}\ntREG\nD0x${metadata.dev.toString(16)}\ni${wrongInode && fd === 'txt' && mappingReads > 1 ? metadata.ino + 1n : metadata.ino}\nn${path}\n`
  }
  hooks.live.mockResolvedValue('alive')
  hooks.exec.mockImplementation(async (executable: string, args: string[]) => {
    if (executable === binaries[0] && args.length === 1 && args[0] === '--version') {
      expect(signalled).toBe(false)
      return { stdout: outgoingVersion }
    }
    if (executable === binaries[1] && args.length === 1 && args[0] === '--version') {
      expect(signalled).toBe(false); versionCalls++
      if (versionError) throw versionError
      if (versionChange === 'bytes') await writeFile(binaries[1]!, 'changed-private-image')
      if (versionChange === 'inode') { const next = `${binaries[1]}.next`; await copyFile(binaries[1]!, next); await rename(next, binaries[1]!) }
      return { stdout: version }
    }
    if (executable === '/usr/bin/codesign') return { stdout: '', stderr: display ? `CDHash=${sha(await readFile(args.at(-1)!)).slice(0, 40)}\n` : 'Changed human-readable signature display\n' }
    if (executable === '/usr/bin/python3') return { stdout: JSON.stringify({ valid: true, cdHash: sha(await readFile(mapped)).slice(0, 40),
      pid, uid: kernelUid, startSeconds, startMicroseconds: missingBirth ? undefined : startMicroseconds + (insideBirthDrift && kernelReads++ > 0 ? 1 : 0) }) }
    if (executable === '/usr/bin/tar') return { stdout: '' }
    if (executable === '/bin/ps') return { stdout: changeBirth ? `${displayBirth}-changed` : displayBirth }
    if (executable === '/usr/sbin/lsof') {
      if (args.includes('-U')) return { stdout: `p${pid}\nu${uid}\nf7u\ntunix\nn${socket}\n` }
      mappingReads++
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
  // This is a controlled native reader port, not a claim that these unsigned
  // fixture files have signatures. Its only file source is the inherited FD.
  hooks.spawn.mockImplementation((command: string, args: string[], options: any) => {
    expect(command).toBe('/usr/bin/python3'); expect(args.slice(0, 2)).toEqual(['-I', '-c'])
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(),
      kill: vi.fn(() => true), unref: vi.fn() })
    queueMicrotask(async () => {
      const fd = options.stdio[3]
      if (!Number.isInteger(fd)) {
        child.stdout.end(JSON.stringify({ primary: { message: 'original file FD unavailable' }, cleanup: [] }))
        child.emit('exit', 0, null); child.emit('close', 0, null); return
      }
      const bytes = Buffer.alloc(fstatSync(fd).size)
      readSync(fd, bytes, 0, bytes.length, 0)
      // The CF reader can change the shared FD offset. Explicit-position hash
      // reads in the actual wrapper must still cover the entire original file.
      readSync(fd, Buffer.alloc(bytes.length), 0, bytes.length, null)
      const observation = { result: { kind: 'security-static-code', architecture: staticArchitecture ?? args[3],
        dictionaryKey: 'kSecCodeInfoUnique', dataType: 'CFData', byteLength: 20, cdHash: sha(bytes).slice(0, 40), valid: true },
        primary: staticPrimary ? { name: 'RuntimeError', message: 'original CF observation failed' } : null,
        calls: ['SecStaticCodeCreateWithPathAndAttributes', 'SecStaticCodeCheckValidity', 'SecCodeCopySigningInformation'].map(api => ({ api, status: 0 })),
        cleanup: ['signing-information', 'static-code', 'architecture-attributes', 'architecture-string', 'file-url'].map(owner =>
          ({ owner, released: !(staticCleanup && owner === 'static-code'), ...(staticCleanup && owner === 'static-code' ? { error: { message: 'independent CF release failed' } } : {}) })) }
      if (staticDrift) {
        // Select the file by the originally supplied FD's identity, only for this
        // explicit race stimulus. No production process/resource is controlled.
        const metadata = fstatSync(fd, { bigint: true })
        const path = (await Promise.all(binaries.map(async path => ({ path, stat: await lstat(path, { bigint: true }) }))))
          .find(value => value.stat.dev === metadata.dev && value.stat.ino === metadata.ino)!.path
        if (staticDrift === 'restore-bytes') {
          await writeFile(path, 'different image queried on the original inode')
          observation.result.cdHash = '77'.repeat(20)
          await writeFile(path, bytes)
        }
        else if (staticDrift === 'bytes') await writeFile(path, 'artifact changed during static query')
        else {
          // Move the parent directory rather than unlinking the held file: its
          // original ctime/mtime remain stable, so named dev/ino is independent.
          const parent = dirname(path), moved = `${parent}.original`
          await rename(parent, moved); await mkdir(parent)
          await copyFile(join(moved, 'ctxmuxd'), path)
          expect(fstatSync(fd, { bigint: true }).ctimeNs).toBe(metadata.ctimeNs)
        }
      }
      child.stdout.end(JSON.stringify(observation)); child.stderr.end()
      if (staticExit) { child.emit('exit', 0, null); child.emit('close', 0, null) }
      else child.emit('error', new Error('reader exit unavailable'))
      readerReceipts.push({ observation, exitConfirmed: staticExit, fd, signals: child.kill.mock.calls })
    })
    return child
  })
  const signal = vi.spyOn(process, 'kill').mockImplementation((target, name) => {
    expect(target).toBe(pid); expect(name).toBe('SIGHUP'); signalled = true; mapped = binaries[1]!; return true
  })
  return { root, old, candidate, configured, state, lock, receiptPath, binaries, signal,
    async prepare() { const plan = await installer.prepareRuntimeUpgrade(old, candidate); plans.push(plan); return plan },
    multipleLocks() { extraLock = true }, badImageInode() { wrongInode = true },
    driftBirth() { changeBirth = true; startMicroseconds++ },
    driftBirthInsideObservation() { insideBirthDrift = true },
    changeDisplayBirth(value: string) { displayBirth = value },
    missingKernelBirth() { missingBirth = true }, wrongKernelUid() { kernelUid++ },
    kernelBirth: `${startSeconds}:123456`,
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
    outgoingVersionResponse(value: string) { outgoingVersion = value },
    driftDuringVersion(kind: 'inode' | 'bytes') { versionChange = kind },
    versionCalls: () => versionCalls, wasSignalled: () => signalled,
    omitSignatureDisplay() { display = false }, staticFileDrift(kind: 'inode' | 'bytes' | 'restore-bytes') { staticDrift = kind },
    driftBeforeOriginalOpen() { hooks.openDrift = true },
    wrongStaticArchitecture() { staticArchitecture = 'another-architecture' },
    unknownReaderExit() { staticExit = false }, failStaticOwners() { staticPrimary = true; staticCleanup = true },
    failFileClose(error = new Error('original file close failed')) { hooks.closeFailure = error }, readerReceipts }
}

it('qualifies the original wrapper from machine signing facts when signature display changes', async () => {
  const f = await fixture(); f.omitSignatureDisplay()
  const result = await f.prepare().then(plan => ({ plan }), error => ({ error }))
  expect(result).toHaveProperty('plan.owner.imageIdentity.cdHash', sha(await readFile(f.binaries[0]!)).slice(0, 40))
  expect(hooks.exec.mock.calls.filter(([command]) => command === '/usr/bin/codesign')).toHaveLength(0)
  expect(f.readerReceipts).toHaveLength(2); expect(f.signal).not.toHaveBeenCalled()
})
it.each(['inode', 'bytes'] as const)('refuses original artifact %s drift during the static reader', async kind => {
  const f = await fixture(); f.staticFileDrift(kind)
  const result = await f.prepare().then(plan => ({ plan }), error => ({ error }))
  expect(result).toHaveProperty('error.message', 'The Runtime artifact changed while its code identity was being read.')
  expect(f.signal).not.toHaveBeenCalled()
})
it('refuses same-inode image replacement restored to original bytes before static observation ends', async () => {
  const f = await fixture(); f.staticFileDrift('restore-bytes')
  const result = await f.prepare().then(plan => ({ plan }), error => ({ error }))
  expect(result).toHaveProperty('error.message', 'The Runtime artifact changed while its code identity was being read.')
  expect(f.signal).not.toHaveBeenCalled()
})
it('binds full expected bytes even when they drift before the original open and then stay stable', async () => {
  const f = await fixture(); f.driftBeforeOriginalOpen()
  const result = await f.prepare().then(plan => ({ plan }), error => ({ error }))
  expect(result).toHaveProperty('error.message', 'The Runtime artifact changed while its code identity was being read.')
  expect(hooks.spawn).not.toHaveBeenCalled(); expect(f.signal).not.toHaveBeenCalled()
})
it.each(['architecture', 'exit'] as const)('does not accept a static reader with unconfirmed %s', async kind => {
  const f = await fixture()
  if (kind === 'architecture') f.wrongStaticArchitecture(); else f.unknownReaderExit()
  const result = await f.prepare().then(plan => ({ plan }), error => ({ error }))
  expect(result).toHaveProperty('error')
  expect(result).not.toHaveProperty('plan'); expect(f.signal).not.toHaveBeenCalled()
})
it('preserves both the original static observation and independent release failure', async () => {
  const f = await fixture(); f.failStaticOwners()
  const result = await f.prepare().then(plan => ({ plan }), error => ({ error }))
  expect(result).toHaveProperty('error.cause.message', 'original CF observation failed')
  expect('error' in result && result.error.errors.map((error: Error) => error.message))
    .toEqual(['original CF observation failed', 'independent CF release failed'])
  expect(f.signal).not.toHaveBeenCalled()
})
it('preserves original CF, independent CF release and original file close failures together', async () => {
  const f = await fixture(); f.failStaticOwners(); f.failFileClose()
  const result = await f.prepare().then(plan => ({ plan }), error => ({ error }))
  expect(result).toHaveProperty('error.cause.message', 'original CF observation failed')
  expect('error' in result && result.error.errors.map((error: Error) => ({ message: error.message, owner: (error as any).owner })))
    .toEqual([{ message: 'original CF observation failed', owner: undefined },
      { message: 'independent CF release failed', owner: 'static-code' }, { message: 'original file close failed', owner: 'artifact-file' }])
  expect(f.signal).not.toHaveBeenCalled()
})
it('does not mutate a frozen original file-close error or replace the CF primary', async () => {
  const f = await fixture(), original = Object.freeze(new Error('frozen original file close failed'))
  f.failStaticOwners(); f.failFileClose(original)
  const result = await f.prepare().then(plan => ({ plan }), error => ({ error }))
  expect(result).toHaveProperty('error.cause.message', 'original CF observation failed')
  expect('error' in result && result.error.errors.at(-1)).toMatchObject({ owner: 'artifact-file', cause: original })
  expect(original).not.toHaveProperty('owner'); expect(Object.isFrozen(original)).toBe(true)
  expect(f.signal).not.toHaveBeenCalled()
})

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
it('rejects OS mapped-image inode drift between owner observations', async () => {
  const f = await fixture(); f.badImageInode()
  await expect(f.prepare()).rejects.toThrow('file identities changed'); expect(f.signal).not.toHaveBeenCalled()
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
it('rejects same-PID same-second microsecond birth drift inside an owner observation', async () => {
  const f = await fixture(); f.driftBirthInsideObservation()
  const result = await f.prepare().then(plan => ({ plan }), error => ({ error }))
  expect(result).toHaveProperty('error.message', 'The Runtime process changed while its serving authority was being observed.')
  expect(f.signal).not.toHaveBeenCalled()
})
it('uses exact kernel birth even when the displayed date changes locale and timezone', async () => {
  const f = await fixture(); f.changeDisplayBirth('unavailable localized date in another timezone')
  const plan = await f.prepare()
  expect(plan.owner.birth).toBe(f.kernelBirth)
  expect(hooks.exec.mock.calls.filter(([command]) => command === '/bin/ps')).toHaveLength(0)
  expect(f.signal).not.toHaveBeenCalled()
})
it.each(['missing birth', 'different UID'])('keeps the owner unconfirmed for %s in kernel process facts', async kind => {
  const f = await fixture()
  if (kind === 'missing birth') f.missingKernelBirth(); else f.wrongKernelUid()
  const result = await f.prepare().then(plan => ({ plan }), error => ({ error }))
  expect(result).toHaveProperty('error')
  expect(f.signal).not.toHaveBeenCalled()
})
it('records only the confirmed actual post-exec image and serving state, retaining identity and original Run', async () => {
  const f = await fixture(), plan = await f.prepare(), mappedPath = await f.alternatePostImage()
  const outcome = await installer.finishRuntimeUpgrade(plan, f.candidate)
  expect(outcome.status).toBe('upgraded'); expect(outcome.originalRuns).toBe(1); expect(f.wasSignalled()).toBe(true)
  expect(f.versionCalls()).toBe(2)
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
  let clock = _reshape_fixtureEpoch(0, 0, 0); vi.spyOn(Date, 'now').mockImplementation(() => clock += 16000)
  const outcome = await installer.finishRuntimeUpgrade(plan, f.candidate)
  expect(outcome.status).toBe('old-confirmed'); expect(outcome.signalSent).toBe(true)
  expect(outcome.error).toContain('has not mapped'); expect(await readFile(f.receiptPath)).toEqual(bytes)
})

it.each(['timed out', 'exit 1'])('keeps the positively confirmed old service and ledger when candidate version %s, without signaling', async reason => {
  const f = await fixture(), plan = await f.prepare(), bytes = await readFile(f.receiptPath)
  f.versionFailure(new Error(`Private candidate version ${reason}`))
  const outcome = await installer.finishRuntimeUpgrade(plan, f.candidate)
  expect(outcome.status).toBe('old-confirmed'); expect(outcome.signalSent).toBe(false)
  expect(outcome.error).toContain(reason); expect(f.versionCalls()).toBe(2); expect(f.signal).not.toHaveBeenCalled()
  expect(await readFile(f.receiptPath)).toEqual(bytes)
})
it.each(['ctxmuxd 0.2.0 (protocol 18, handoff opaque)', 'ctxmuxd 0.1.0 (protocol 19, handoff opaque)',
  'ctxmuxd 0.1.0 (protocol 18, handoff )', ''])('rejects an unbound public version declaration %j before signaling', async response => {
  const f = await fixture(), plan = await f.prepare(), bytes = await readFile(f.receiptPath)
  f.versionResponse(response)
  const outcome = await installer.finishRuntimeUpgrade(plan, f.candidate)
  expect(outcome.status).toBe('old-confirmed'); expect(outcome.error).toContain('declare its selected')
  expect(outcome.signalSent).toBe(false); expect(f.versionCalls()).toBe(2); expect(f.signal).not.toHaveBeenCalled()
  expect(await readFile(f.receiptPath)).toEqual(bytes)
})
it.each(['inode', 'bytes'] as const)('rejects candidate %s drift during its actual version response and preserves the old ledger', async kind => {
  const f = await fixture(), plan = await f.prepare(), bytes = await readFile(f.receiptPath)
  f.driftDuringVersion(kind)
  // A broken pre-signal guard may reach the post-signal polling branch. Bound
  // that owning counterexample too, so the RED is a behavioral assertion.
  let clock = _reshape_fixtureEpoch(0, 0, 0); vi.spyOn(Date, 'now').mockImplementation(() => clock += 16000)
  const outcome = await installer.finishRuntimeUpgrade(plan, f.candidate)
  expect(outcome.status).toBe('old-confirmed'); expect(outcome.error).toContain('changed while its version response')
  expect(outcome.signalSent).toBe(false); expect(f.versionCalls()).toBe(2); expect(f.signal).not.toHaveBeenCalled()
  expect(await readFile(f.receiptPath)).toEqual(bytes)
})

it('refuses unequal public handoff declarations before owner extraction, signal or application cutover', async () => {
  const f = await fixture(), receipt = await readFile(f.receiptPath)
  f.outgoingVersionResponse('ctxmuxd 0.1.0 (protocol 18, handoff source-generation)\n')
  f.versionResponse('ctxmuxd 0.1.0 (protocol 18, handoff destination-generation)\n')
  await expect(f.prepare()).rejects.toThrow('Runtime handoff is unsupported: source-generation -> destination-generation')
  expect(f.signal).not.toHaveBeenCalled()
  expect(hooks.exec.mock.calls.map(([command]) => command).filter(command => command !== '/usr/bin/codesign').sort()).toEqual([...f.binaries].sort())
  expect(await readFile(f.receiptPath)).toEqual(receipt)
  expect(await readFile(f.binaries[0]!)).toEqual(Buffer.from('never-executed-private-image-0'))
})

it('keeps the original service when a candidate has no verifiable public handoff declaration', async () => {
  const f = await fixture(), receipt = await readFile(f.receiptPath)
  f.versionResponse('ctxmuxd 0.1.0 (protocol 18)\n')
  await expect(f.prepare()).rejects.toThrow('declare its selected version, protocol and handoff')
  expect(f.signal).not.toHaveBeenCalled()
  expect(hooks.exec.mock.calls.map(([command]) => command).filter(command => command !== '/usr/bin/codesign').sort()).toEqual([...f.binaries].sort())
  expect(await readFile(f.receiptPath)).toEqual(receipt)
})
