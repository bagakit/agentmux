import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, realpath, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { verifyMacosSigning } from './macos-signing.mjs'

const exec = promisify(execFile)
const runNative = (command, args) => exec(command, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
export const nativeBundleId = 'dev.agentmux.native'
export const nativeAppName = 'AgentMux Native.app'
const executable = app => join(app, 'Contents', 'MacOS', 'agentmux-native-macos')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const architecture = arch => arch === 'x64' ? 'x86_64' : arch
const sourceRoot = root => join(root, 'packages', 'native-desktop')
const desktopRoot = root => join(root, 'apps', 'desktop')
const builtApp = root => join(desktopRoot(root), 'resources', nativeAppName)
export const packagedNativeApp = app => join(app, 'Contents', 'Resources', 'app', 'resources', nativeAppName)

/** Explicit profiles: development is a DEBUG bare executable, delivery a release App. No signing here. */
export async function buildNativeDesktop({ root, development = false, arch = process.arch, platform = process.platform, run = runNative } = {}) {
  if (platform !== 'darwin') return { state: 'unsupported', platform }
  const cpu = architecture(arch)
  assert.ok(['arm64', 'x86_64'].includes(cpu), 'Unsupported native macOS architecture')
  const args = [join(sourceRoot(root), 'scripts', 'build-macos.mjs'), '--configuration', development ? 'debug' : 'release', '--arch', cpu]
  if (development) args.push('--bare')
  else args.push('--output', builtApp(root))
  const result = await run(process.execPath, args)
  // Swift diagnostics go to stderr. stdout is one versioned receipt, never a path guessed from logs.
  if (result.stderr) process.stderr.write(result.stderr)
  const receipt = JSON.parse(result.stdout)
  assert.equal(receipt.schema, 'agentmux.native-build.v1')
  assert.equal(receipt.profile, development ? 'bare-debug' : 'application')
  assert.equal(receipt.configuration, development ? 'debug' : 'release')
  assert.equal(receipt.arch, cpu)
  assert.equal(receipt.signed, false)
  assert.equal(resolve(receipt.executablePath), resolve(development ? receipt.binaryPath : executable(builtApp(root))))
  if (development) {
    const expected = join(sourceRoot(root), 'macos', '.build', 'debug', 'agentmux-native-macos')
    // SwiftPM's debug alias and platform-qualified build directory identify the same file.
    assert.equal(await realpath(receipt.executablePath), await realpath(expected))
  } else {
    assert.equal(resolve(receipt.appPath), resolve(builtApp(root)))
    assert.equal(receipt.bundleId, nativeBundleId)
    assert.equal(sha(await readFile(receipt.binaryPath)), sha(await readFile(receipt.executablePath)), 'Native App does not contain the compiled binary')
    for (const [name, path] of [['LICENSE.orca', join(sourceRoot(root), 'macos', 'LICENSE.orca')], ['UPSTREAM.md', join(sourceRoot(root), 'macos', 'UPSTREAM.md')], ['THIRD_PARTY_NOTICES.md', join(sourceRoot(root), 'THIRD_PARTY_NOTICES.md')]]) {
      assert.deepEqual(await readFile(join(receipt.appPath, 'Contents', 'Resources', name)), await readFile(path), `Native build lost its pinned ${name}`)
    }
  }
  assert.ok((await stat(receipt.executablePath)).isFile(), 'Native build executable is missing')
  return receipt
}

/** Called after the existing resource copy and before the single inside-out Desktop signing pass. */
export async function verifyNativeDesktopCopy(appPath, root) {
  const app = packagedNativeApp(appPath)
  const bytes = await readFile(executable(app))
  assert.equal(sha(bytes), sha(await readFile(executable(builtApp(root)))), 'Packaged native binary differs from the built candidate')
  for (const name of ['Info.plist', 'Resources/LICENSE.orca', 'Resources/UPSTREAM.md', 'Resources/THIRD_PARTY_NOTICES.md']) {
    assert.deepEqual(await readFile(join(app, 'Contents', name)), await readFile(join(builtApp(root), 'Contents', name)), `Packaged native ${name} differs`)
  }
  for (const [name, path] of [['LICENSE.orca', join(sourceRoot(root), 'macos', 'LICENSE.orca')], ['UPSTREAM.md', join(sourceRoot(root), 'macos', 'UPSTREAM.md')], ['THIRD_PARTY_NOTICES.md', join(sourceRoot(root), 'THIRD_PARTY_NOTICES.md')]]) {
    assert.deepEqual(await readFile(join(app, 'Contents', 'Resources', name)), await readFile(path), `Native ${name} is not the pinned source notice`)
  }
  return { appPath: app, bundleId: nativeBundleId, unsignedExecutableSha256: sha(bytes) }
}

/** The same selected leaf must qualify both Apps; this is code identity, not a TCC grant. */
export async function verifyNativeDesktopSigning(appPath, plan, options) {
  return verifyMacosSigning(packagedNativeApp(appPath), plan, { ...options, bundleId: nativeBundleId })
}
