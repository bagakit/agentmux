import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../macos')
const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a value`)
  return args[index + 1]
}
const scratch = resolve(option('--scratch-path') ?? join(packageDirectory, '.build'))
const configuration = option('--configuration') ?? 'release'
const arch = option('--arch')
const bare = args.includes('--bare')
const run = (command, commandArgs, capture = false) => {
  const result = spawnSync(command, commandArgs, { stdio: capture ? 'pipe' : ['ignore', 2, 2], encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal}): ${result.stderr ?? ''}`)
  return result.stdout?.trim()
}
if (process.platform !== 'darwin') throw new Error('AgentMux native macOS can only be built on macOS')
if (!['debug', 'release'].includes(configuration)) throw new Error('configuration must be debug or release')
if (bare && configuration !== 'debug') throw new Error('--bare requires configuration debug')
if (!bare && configuration !== 'release') throw new Error('debug native builds require --bare; the application profile is release')
if (arch && !['arm64', 'x86_64'].includes(arch)) throw new Error('arch must be arm64 or x86_64')
const buildArgs = ['build', '--package-path', packageDirectory, '--scratch-path', scratch, '--configuration', configuration, '--jobs', '1']
if (arch) buildArgs.push('--arch', arch)
run('swift', buildArgs)
const binDirectory = run('swift', [...buildArgs, '--show-bin-path'], true)
const binaryPath = join(binDirectory, 'agentmux-native-macos')
if (bare) {
  process.stdout.write(`${JSON.stringify({ schema: 'agentmux.native-build.v1', executablePath: binaryPath, binaryPath,
    profile: 'bare-debug', configuration: 'debug', arch: arch ?? process.arch, signed: false })}\n`)
} else {
const appPath = resolve(option('--output') ?? join(binDirectory, 'AgentMux Native.app'))
const executablePath = join(appPath, 'Contents', 'MacOS', 'agentmux-native-macos')
// Resolve existing ancestors too: a symlinked output parent must not hide an
// overlap with the source or compiler output that this operation will consume.
const entry = path => {
  try { return lstatSync(path) } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}
const canonical = path => {
  const tail = []
  let ancestor = path
  while (!entry(ancestor)) {
    if (dirname(ancestor) === ancestor) throw new Error(`Cannot resolve output ancestor: ${path}`)
    tail.unshift(basename(ancestor))
    ancestor = dirname(ancestor)
  }
  return resolve(realpathSync(ancestor), ...tail)
}
const contains = (container, target) => {
  const distance = relative(container, target)
  return distance === '' || (!isAbsolute(distance) && distance !== '..' && !distance.startsWith(`..${sep}`))
}
if (basename(appPath) !== 'AgentMux Native.app') throw new Error('Application output must be named AgentMux Native.app')
const canonicalApp = canonical(appPath)
for (const input of [binaryPath, packageDirectory]) {
  if (contains(canonicalApp, canonical(input))) throw new Error('Application output contains a build input')
}
for (const source of ['Sources', 'Tests', 'Verification']) {
  const sourcePath = canonical(join(packageDirectory, source))
  if (contains(sourcePath, canonicalApp) || contains(canonicalApp, sourcePath)) throw new Error('Application output overlaps native source')
}
const info = entry(appPath)
if (info) {
  const plist = join(appPath, 'Contents', 'Info.plist')
  const plistInfo = entry(plist)
  if (!info.isDirectory() || info.isSymbolicLink() || !plistInfo?.isFile() || plistInfo.isSymbolicLink() ||
      run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '--', plist], true) !== 'dev.agentmux.native') {
    throw new Error('Existing application output is not an owned AgentMux Native app; preserving it')
  }
}
// Compilation succeeded and the exact output has a known product identity.
rmSync(appPath, { recursive: true, force: true })
mkdirSync(dirname(executablePath), { recursive: true })
mkdirSync(join(appPath, 'Contents', 'Resources'), { recursive: true })
copyFileSync(binaryPath, executablePath)
copyFileSync(join(packageDirectory, 'LICENSE.orca'), join(appPath, 'Contents', 'Resources', 'LICENSE.orca'))
copyFileSync(join(packageDirectory, 'UPSTREAM.md'), join(appPath, 'Contents', 'Resources', 'UPSTREAM.md'))
copyFileSync(join(packageDirectory, '..', 'THIRD_PARTY_NOTICES.md'), join(appPath, 'Contents', 'Resources', 'THIRD_PARTY_NOTICES.md'))
chmodSync(executablePath, 0o755)
writeFileSync(join(appPath, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleExecutable</key><string>agentmux-native-macos</string>
<key>CFBundleIdentifier</key><string>dev.agentmux.native</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleName</key><string>AgentMux Native</string>
<key>CFBundleDisplayName</key><string>AgentMux Native</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>LSUIElement</key><true/>
<key>NSAccessibilityUsageDescription</key><string>AgentMux Native reads and operates the exact application controls you authorize.</string>
<key>NSScreenCaptureUsageDescription</key><string>AgentMux Native captures the window, display or selected rectangle you request.</string>
</dict></plist>
`)
process.stdout.write(`${JSON.stringify({ schema: 'agentmux.native-build.v1', appPath, executablePath, binaryPath,
  bundleId: 'dev.agentmux.native', profile: 'application', configuration: 'release', arch: arch ?? process.arch, signed: false })}\n`)
}
