import { createHash } from 'node:crypto'
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const files = ['packages/core/src/client-notifications.ts', 'packages/core/src/agentmux-cli-commands.ts',
  'packages/core/src/control.ts', 'packages/core/src/control-codec.ts', 'packages/core/src/rpc-business-codec.ts',
  'packages/core/src/diagnostic-evidence.ts', 'packages/core/src/diagnostic-evidence-codec.ts',
  'packages/core/src/diagnostic-evidence-service.ts', 'packages/core/src/public-rpc-service.ts',
  'packages/core/test/client-notifications.test.ts', 'packages/core/test/client-notifications.config.mts',
  'packages/core/scripts/verify-client-notifications.mjs']
async function identities() {
  return Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])))
}
const inputs = await identities(), base = join(root, '.tmp/client-notifications-core')
await mkdir(base, { recursive: true })
const directory = await mkdtemp(join(base, 'run-'))
const results = []
for (const mutation of [null, 'control-target-unchecked', 'cli-unread-filter-disconnected']) {
  const env = { ...process.env }; delete env.AGENTMUX_NOTIFICATION_CORE_MUTATION
  if (mutation) env.AGENTMUX_NOTIFICATION_CORE_MUTATION = mutation
  const run = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
    'packages/core/test/client-notifications.config.mts'], { cwd: root, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`, name = mutation ?? 'positive'
  await writeFile(join(directory, `${name}.log`), output)
  const passed = mutation ? run.status !== 0 && output.includes(`NOTIFICATION_CORE_MUTATION_APPLIED:${mutation}`) &&
    output.includes('AssertionError') && !output.includes('Failed Suites') : run.status === 0 && /5 passed/u.test(output)
  results.push({ mutation, exitCode: run.status, passed, log: `${name}.log` })
  if (!passed) { console.error(output); break }
}
const unchanged = JSON.stringify(inputs) === JSON.stringify(await identities())
const passed = unchanged && results.length === 3 && results.every(result => result.passed)
await writeFile(join(directory, 'receipt.json'), JSON.stringify({ schema: 'agentmux.client-notifications-core-verification.v1',
  inputs, sourceUnchanged: unchanged, passed, results }, null, 2))
console.log(JSON.stringify({ passed, receipt: join(directory, 'receipt.json') }))
if (!passed) process.exitCode = 1
