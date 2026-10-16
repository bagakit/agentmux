import assert from 'node:assert/strict'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { bounded, terminate } from './process.mjs'

const [executable, planPath, prompt] = process.argv.slice(2)
const plan = JSON.parse(await readFile(planPath, 'utf8'))
assert.equal(process.env.HOME, plan.home)
assert.equal(process.env.CODEX_HOME, plan.authHome)
assert.equal(process.cwd(), plan.workspace)
assert.ok(isAbsolute(executable) && isAbsolute(plan.cli))
assert.equal(resolve(process.env.AGENTMUX_CLI), plan.cli, 'The actual public CLI must belong to this candidate')
assert.ok(plan.args.includes('--no-daemon') && plan.args.includes('--ignore-user-config') && plan.args.includes('--ignore-rules'))
await writeFile(plan.credentials, JSON.stringify({ capability: process.env.AGENTMUX_AGENT_CAPABILITY, agentSessionId: process.env.AGENTMUX_AGENT_SESSION_ID }), { mode: 0o600 })
const actualPrompt = plan.userContext ? `Original user task (fixture native exec context):\n${plan.userContext}\n\nOriginal Core Agent message input:\n${prompt}` : prompt
const args = [...plan.args, actualPrompt]
// A dedicated group is rooted at this exact model. Core Stop remains first;
// its owner receipt supports bounded fallback without host process enumeration.
const child = spawn(executable, args, { env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
await writeFile(plan.processReceipt, JSON.stringify({ wrapperPid: process.pid, modelPid: child.pid, modelOwnProcessGroup: true,
  executable, args, originalCorePrompt: prompt, fixtureUserContext: plan.userContext ?? null, home: process.env.HOME, authHome: process.env.CODEX_HOME, cli: process.env.AGENTMUX_CLI,
  workspace: process.cwd(), userConfigCopied: false }) + '\n', { mode: 0o600 })
let writes = Promise.resolve(), stopping = false
for (const [stream, path, output] of [[child.stdout, plan.events, process.stdout], [child.stderr, plan.stderr, process.stderr]]) {
  stream.on('data', bytes => { output.write(bytes); writes = writes.then(() => appendFile(path, bytes, { mode: 0o600 })) })
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (stopping) return
  stopping = true
  void terminate(child).then(() => {}, error => { process.stderr.write(error.message + '\n'); process.exitCode = 1 })
})
child.on('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1 })
child.on('close', async (code, signal) => { await bounded(writes, 5000, 'Private native output flush'); process.exitCode = code ?? (signal ? 1 : 0) })
