import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import ts from 'typescript'
import { afterEach, expect, it } from 'vitest'
import { preservePackageSmokeFailure } from '../scripts/package-smoke-context.mjs'

// Same source-loading seam as package-smoke-diagnostics. No substitute producer:
// main calls the original createDmg, detachCreatedImage and verifyDmg bodies.
const source = await readFile(process.env.AGENTMUX_PACKAGE_SMOKE_SOURCE ?? new URL('../scripts/package-macos.mjs', import.meta.url), 'utf8')
const ast = ts.createSourceFile('package-macos.mjs', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const bodies = Object.fromEntries(['main', 'createDmg', 'detachCreatedImage', 'verifyDmg', 'run', 'sha256'].map(name => {
  const declarations = ast.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === name)
  if (declarations.length !== 1 || !declarations[0]!.body?.statements.length) throw new Error(`Expected one nonempty original ${name}`)
  return [name, declarations[0]!.getText(ast)]
}))
type Run = (command: string, args: string[], options?: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>
const nativeRun = new Function('spawn', `return (${bodies.run})`)(spawn) as Run
const exists = async (path: string) => await lstat(path).then(() => true, error => {
  if (error.code === 'ENOENT') return false
  throw error
})
const payloadPath = 'Contents/Resources/nonempty-payload.bin'
const payload = Buffer.from(Array.from({ length: 64 * 1024 }, (_, index) => (index % 251) + 1))
type Scenario = 'success' | 'verify-failure' | 'cleanup-failure'
type Facts = Record<string, any>
const roots: Array<{ root: string; facts: Facts; mounts: Set<string> }> = []
afterEach(async () => {
  for (const fixture of roots.splice(0)) {
    let cleanupError: unknown
    try {
      for (const mount of fixture.mounts) await nativeRun('hdiutil', ['detach', mount], { capture: true })
      await rm(fixture.root, { recursive: true, force: true })
      fixture.facts.cleanup = { fixtureRemoved: !await exists(fixture.root), remainingMounts: [] }
    } catch (error) {
      cleanupError = error
      fixture.facts.cleanup = { fixtureRemoved: false, root: fixture.root, remainingMounts: [...fixture.mounts], error: String(error) }
    }
    const evidence = process.env.AGENTMUX_DMG_STAGE_EVIDENCE
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      await writeFile(join(evidence, fixture.facts.scenario + '.json'), JSON.stringify(fixture.facts, null, 2) + '\n')
    }
    if (cleanupError) throw cleanupError
  }
}, 0)

it('private staging absence keeps an actual ENOTDIR observation error instead of reporting absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-package-dmg-observation-')), file = join(root, 'regular')
  try {
    await writeFile(file, 'Nonempty private observation fixture\n')
    expect((await stat(file)).size).toBeGreaterThan(0)
    expect(await exists(file)).toBe(true)
    expect(await exists(join(root, 'missing'))).toBe(false)
    await expect(exists(join(file, 'child')), 'dmg-absence-does-not-hide-original-observation-errors').rejects.toMatchObject({ code: 'ENOTDIR' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

async function consumeOriginalMain(scenario: Scenario) {
  const root = await mkdtemp(join(tmpdir(), 'amx-package-dmg-stage-'))
  const sourceApp = join(root, 'source/AgentMux.app'), repositoryRoot = join(root, 'repository')
  const releaseRoot = join(root, 'published'), outputApp = join(releaseRoot, 'AgentMux.app'), outputDmg = join(releaseRoot, 'AgentMux.dmg')
  const facts: Facts = { scenario, fixtureRoot: root, sourceSHA256: digest(source), functionSHA256: Object.fromEntries(Object.entries(bodies).map(([name, body]) => [name, digest(body)])),
    sourcePayloadSHA256: digest(payload), sourcePayloadBytes: payload.length, nativeCommands: [], verificationCopies: 0,
    boundary: 'Actual original packaging main/DMG producer and native image/copy commands only. Unrelated build, branding, signing, identity and Runtime verification ports are controlled. No App launch, install, Runtime, full App build or in-flight package qualification.' }
  const mounts = new Set<string>(); roots.push({ root, facts, mounts })
  await mkdir(join(sourceApp, 'Contents/Resources/app/resources/bin'), { recursive: true })
  await mkdir(join(sourceApp, 'Contents/MacOS'))
  await writeFile(join(sourceApp, payloadPath), payload)
  await writeFile(join(sourceApp, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.agentmux.private-dmg-fixture</string></dict></plist>\n')
  await writeFile(join(sourceApp, 'Contents/MacOS/AgentMux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await writeFile(join(sourceApp, 'Contents/Resources/app/resources/bin/agentmux-workspace-move'), 'private fixture; never executed\n')
  await mkdir(join(repositoryRoot, 'apps/desktop/resources/bin'), { recursive: true })
  await writeFile(join(repositoryRoot, 'apps/desktop/resources/bin/agentmux-workspace-move'), 'private fixture; never executed\n')
  let temporaryRoot = '', verifyError: unknown, observedError: unknown, diagnostics: Awaited<ReturnType<typeof preservePackageSmokeFailure>> | undefined
  const cleanupError = Object.assign(new Error('Private completed DMG input cleanup denied'), { code: 'EACCES' })
  const run: Run = async (command, args, options = {}) => {
    // These ports are outside this task. Never execute a build, signer, App or Runtime.
    if (command === 'pnpm' || command === 'codesign' || command === process.execPath) return { stdout: '', stderr: '' }
    if (!['cp', 'xattr', 'ditto', 'hdiutil', 'plutil', 'shasum', 'du'].includes(command)) throw new Error(`Unexpected packaging command: ${command}`)
    if (command === 'hdiutil' && args[0] === 'create') temporaryRoot = dirname(args[args.indexOf('-srcfolder') + 1]!)
    const input = join(temporaryRoot, 'dmg-root')
    if (command === 'hdiutil' && args[0] === 'verify') {
      facts.inputPresentBeforeVerify = await exists(input)
      if (scenario === 'verify-failure') await writeFile(args[1]!, 'Nonempty deliberately invalid private DMG image\n')
    }
    if (command === 'ditto' && args.length === 2) {
      facts.verificationCopies++
      facts.inputPresentAtVerificationCopy = await exists(input)
      facts.mountedPayloadSHA256 = digest(await readFile(join(args[0]!, payloadPath)))
      facts.applicationsLink = await readlink(join(dirname(args[0]!), 'Applications'))
    }
    const row: Facts = { command, args }; facts.nativeCommands.push(row)
    try {
      const result = await nativeRun(command, args, options)
      row.status = 'succeeded'; row.stdoutSHA256 = digest(result.stdout); row.stderrSHA256 = digest(result.stderr)
      if (command === 'hdiutil' && args[0] === 'verify') facts.verifyReturnedSuccessfully = true
      if (command === 'hdiutil' && args[0] === 'attach') mounts.add(args[args.indexOf('-mountpoint') + 1]!)
      if (command === 'hdiutil' && args[0] === 'detach') mounts.delete(args[1]!)
      if (command === 'ditto' && args.length === 2) facts.verificationPayloadSHA256 = digest(await readFile(join(args[1]!, payloadPath)))
      return result
    } catch (error) {
      row.status = 'failed'; row.error = String(error)
      if (command === 'hdiutil' && args[0] === 'verify') verifyError = error
      throw error
    }
  }
  const noop = async () => {}
  const ports = {
    assert: (condition: unknown, message: string) => { if (!condition) throw new Error(message) },
    process: { argv: [], platform: 'darwin', arch: 'arm64', execPath: process.execPath, stderr: { write: () => {} }, stdout: { write: () => {} } },
    preflightMacosSigning: async () => ({ kind: 'ad-hoc' }), sourceIdentity: async () => ({ commit: 'private-source', tree: 'private-tree', status: '' }),
    inspectElectronApplication: async () => ({ application: sourceApp }), dirname, basename, join, mkdir, mkdtemp, stat, realpath, readdir, rename, symlink,
    tmpdir: () => root, run, repositoryRoot, desktopRoot: join(repositoryRoot, 'apps/desktop'), releaseRoot, outputApp, outputDmg,
    PRODUCT_NAME: 'AgentMux', manifest: { version: '0.1.0' }, appOnly: false, installRequested: false,
    brandApplication: noop, copyRuntimeApplication: noop, verifyIdentity: noop, verifyThirdPartyNotices: noop, verifyNativeDesktopCopy: noop,
    verifyNativeDesktopSigning: noop, auditBundle: noop, verifyWorkspaceMoveHelper: noop,
    signAndVerifyMacosApplication: async () => ({ kind: 'ad-hoc' }), verifyPackagedRuntime: noop,
    verifyLaunchServices: async () => { throw new Error('No App may launch in the private image fixture') },
    rm: async (...args: Parameters<typeof rm>) => {
      if (temporaryRoot && args[0] === join(temporaryRoot, 'dmg-root')) {
        facts.cleanupAfterVerify = facts.verifyReturnedSuccessfully === true
        if (scenario === 'cleanup-failure') throw cleanupError
      }
      return await rm(...args)
    },
    publishPackageArtifact: async () => ({ publication: { status: 'fixture' }, cleanup: { status: 'fixture' } }),
    preservePackageSmokeFailure: async (...args: Parameters<typeof preservePackageSmokeFailure>) => {
      facts.inputPresentAtDiagnostic = await exists(join(args[0], 'dmg-root'))
      observedError = args[2]; diagnostics = await preservePackageSmokeFailure(...args)
      facts.diagnostics = diagnostics; return diagnostics
    }
  }
  const declarations = ['sha256', 'createDmg', 'detachCreatedImage', 'verifyDmg', 'main'].map(name => bodies[name]).join('\n')
  const main = new Function(...Object.keys(ports), `${declarations}\nreturn main`)(...Object.values(ports)) as () => Promise<void>
  const error = await main().then(() => null, error => error)
  facts.sourcePayloadAfterSHA256 = digest(await readFile(join(sourceApp, payloadPath)))
  facts.temporaryRootRemoved = !await exists(temporaryRoot)
  facts.error = error === null ? null : String(error)
  facts.originalErrorReachedDiagnostics = error !== null && observedError === error
  facts.noRemainingImageMount = mounts.size === 0
  if (diagnostics) facts.persistedDiagnostics = JSON.parse(await readFile(join(diagnostics.directory, 'failure.json'), 'utf8'))
  if (error === null) { facts.publishedPayloadSHA256 = digest(await readFile(join(outputApp, payloadPath))); facts.publishedDmgBytes = (await stat(outputDmg)).size }
  return { facts, error, verifyError, cleanupError, diagnostics }
}

it.skipIf(process.platform !== 'darwin')('original packaging main releases its verified DMG input before the real verification copy and preserves nonempty image bytes', async () => {
  const result = await consumeOriginalMain('success')
  expect(result.error).toBeNull()
  expect(result.facts.inputPresentBeforeVerify, 'dmg-input-is-retained-until-native-verify-returns').toBe(true)
  expect(result.facts.inputPresentAtVerificationCopy, 'dmg-consumed-input-released-before-verification-copy').toBe(false)
  expect(result.facts.cleanupAfterVerify).toBe(true)
  expect(result.facts.verificationCopies).toBe(1)
  for (const key of ['sourcePayloadAfterSHA256', 'mountedPayloadSHA256', 'verificationPayloadSHA256', 'publishedPayloadSHA256']) expect(result.facts[key]).toBe(digest(payload))
  expect(result.facts.publishedDmgBytes).toBeGreaterThan(0)
  expect(result.facts.applicationsLink).toBe('/Applications')
  expect(result.facts.temporaryRootRemoved).toBe(true)
  expect(result.facts.noRemainingImageMount).toBe(true)
}, 0)

it.skipIf(process.platform !== 'darwin')('original packaging main keeps the native image verify error and its input until existing failure diagnostics run', async () => {
  const result = await consumeOriginalMain('verify-failure')
  expect(result.verifyError).toBeInstanceOf(Error)
  expect(result.error).toBe(result.verifyError)
  expect(result.facts.inputPresentAtDiagnostic, 'dmg-failed-verification-retains-input-for-original-diagnostics').toBe(true)
  expect(result.facts.originalErrorReachedDiagnostics).toBe(true)
  expect(result.diagnostics!.failures[0]!.message).toBe((result.verifyError as Error).message)
  expect(result.facts.persistedDiagnostics).toEqual(result.diagnostics)
  expect(result.facts.verificationCopies).toBe(0)
  expect(result.facts.sourcePayloadAfterSHA256).toBe(digest(payload))
  expect(result.facts.temporaryRootRemoved).toBe(true)
}, 0)

it.skipIf(process.platform !== 'darwin')('original packaging main reports completed-input cleanup failure without making another verification copy', async () => {
  const result = await consumeOriginalMain('cleanup-failure')
  expect(result.error, 'dmg-cleanup-failure-is-not-packaging-success').toBe(result.cleanupError)
  expect(result.facts.verifyReturnedSuccessfully).toBe(true)
  expect(result.facts.originalErrorReachedDiagnostics).toBe(true)
  expect(result.facts.inputPresentAtDiagnostic).toBe(true)
  expect(result.diagnostics!.failures[0]!.message).toBe(result.cleanupError.message)
  expect(result.facts.persistedDiagnostics).toEqual(result.diagnostics)
  expect(result.facts.verificationCopies).toBe(0)
  expect(result.facts.sourcePayloadAfterSHA256).toBe(digest(payload))
  expect(result.facts.temporaryRootRemoved).toBe(true)
}, 0)
