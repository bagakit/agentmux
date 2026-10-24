import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../macos')
const args = process.argv.slice(2)
const scratchIndex = args.indexOf('--scratch-path')
const scratch = scratchIndex >= 0 ? resolve(args[scratchIndex + 1]) : join(root, '.build')
function run(command, parameters) {
  const result = spawnSync(command, parameters, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
if (args.includes('--source-only')) {
  const source = join(root, 'Sources', 'AgentMuxNativeMacOS')
  const core = join(root, 'Sources', 'AgentMuxNativeMacOSCore')
  run('swiftc', ['-frontend', '-parse', ...readdirSync(source).filter(n => n.endsWith('.swift')).map(n => join(source, n))])
  run('swiftc', ['-frontend', '-parse', ...readdirSync(core).filter(n => n.endsWith('.swift')).map(n => join(core, n))])
  const test = join(root, 'Tests', 'AgentMuxNativeMacOSTests')
  run('swiftc', ['-frontend', '-parse', ...readdirSync(test).filter(n => n.endsWith('.swift')).map(n => join(test, n))])
  process.stdout.write('Native syntax parse passed; this is not compilation or behavior acceptance.\n')
} else {
  run('swift', ['test', '--package-path', root, '--scratch-path', scratch, '--jobs', '1'])
}
