import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..'), output = resolve(process.argv[2] ?? '.tmp/tool-execution-ui-mutants')
await mkdir(output, { recursive: true })
const outcomes = []
for (const [mutation, test] of [['tool-target', 'launcher-tool-execution.test.tsx'], ['local-host-inventory', 'launcher-tool-execution.test.tsx'], ['notices', 'tool-execution-notice.test.tsx'], ['initial-order', 'execution-binding-readers.test.ts'], ['reader-isolation', 'execution-binding-readers.test.ts']]) {
  if (process.argv[3] && !process.argv[3].split(',').includes(mutation)) continue
  let log = ''
  const child = spawn(resolve(root, 'packages/core/node_modules/.bin/vitest'), ['run', '--config', 'apps/desktop/test/vitest.tool-execution-ui.config.mts', `apps/desktop/test/${test}`], { cwd: root, env: { ...process.env, TOOL_EXECUTION_UI_MUTANT: mutation }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => { log += chunk }); child.stderr.on('data', chunk => { log += chunk })
  const exitCode = await new Promise(done => child.on('close', done))
  await writeFile(resolve(output, `${mutation}.log`), log)
  const killed = exitCode !== 0 && /TOOL_EXECUTION_MUTANT_HIT/u.test(log) && /AssertionError/u.test(log) && /Tests\s+.*failed/u.test(log)
  outcomes.push({ mutation, exitCode, killed }); await writeFile(resolve(output, 'receipt.json'), JSON.stringify(outcomes, null, 2))
  console.log(JSON.stringify(outcomes.at(-1))); assert(killed, `Mutation must reach real assertions: ${mutation}`)
}
