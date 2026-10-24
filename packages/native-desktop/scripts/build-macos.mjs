import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
const run = (command, commandArgs, capture = false) => {
  const result = spawnSync(command, commandArgs, { stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal}): ${result.stderr ?? ''}`)
  return result.stdout?.trim()
}
if (process.platform !== 'darwin') throw new Error('AgentMux native macOS can only be built on macOS')
if (!['debug', 'release'].includes(configuration)) throw new Error('configuration must be debug or release')
if (arch && !['arm64', 'x86_64'].includes(arch)) throw new Error('arch must be arm64 or x86_64')
const buildArgs = ['build', '--package-path', packageDirectory, '--scratch-path', scratch, '--configuration', configuration, '--jobs', '1']
if (arch) buildArgs.push('--arch', arch)
run('swift', buildArgs)
const binDirectory = run('swift', [...buildArgs, '--show-bin-path'], true)
const appPath = resolve(option('--output') ?? join(binDirectory, 'AgentMux Native.app'))
const executablePath = join(appPath, 'Contents', 'MacOS', 'agentmux-native-macos')
mkdirSync(dirname(executablePath), { recursive: true })
mkdirSync(join(appPath, 'Contents', 'Resources'), { recursive: true })
copyFileSync(join(binDirectory, 'agentmux-native-macos'), executablePath)
copyFileSync(join(packageDirectory, 'LICENSE.orca'), join(appPath, 'Contents', 'Resources', 'LICENSE.orca'))
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
process.stdout.write(`${JSON.stringify({ appPath, executablePath, bundleId: 'dev.agentmux.native', signed: false })}\n`)
