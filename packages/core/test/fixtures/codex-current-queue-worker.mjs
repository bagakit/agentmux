import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { JSONRPCClient } from 'json-rpc-2.0'

const [root, sid, home] = process.argv.slice(2)
const child = spawn(process.env.AGENTMUX_TEST_CODEX_BINARY ?? 'codex', ['app-server', '--stdio'], {
  cwd: root, env: { ...process.env, CODEX_HOME: home, HOME: root }, stdio: ['pipe', 'pipe', 'inherit']
})
const events = [], listeners = new Set()
let carry = '', stopped = false
const client = new JSONRPCClient(request => new Promise((resolve, reject) => {
  child.stdin.write(JSON.stringify(request) + '\n', error => error ? reject(error) : resolve())
}))
child.stdout.on('data', bytes => {
  carry += bytes.toString()
  for (let newline; (newline = carry.indexOf('\n')) >= 0;) {
    const line = carry.slice(0, newline); carry = carry.slice(newline + 1)
    if (!line.trim()) continue
    const value = JSON.parse(line)
    if (value.method) { events.push(value); for (const listener of listeners) listener(value) }
    else client.receive(value)
  }
})
const stop = () => { if (stopped) return; stopped = true; child.stdin.end() }
process.on('SIGTERM', stop); process.on('SIGINT', stop)
child.on('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1 })
child.once('close', code => { client.rejectAllPendingRequests('Private original native backend closed'); process.exit(code ?? 1) })
const call = (method, params) => client.timeout(10_000).request(method, params)
try {
  await call('initialize', { clientInfo: { name: 'agentmux_native_queue_runtime_proof', version: '1' }, capabilities: { experimentalApi: true } })
  client.notify('initialized', {}, undefined)
  const started = await call('thread/start', { cwd: root, threadSource: 'user', modelProvider: 'private_queue', model: 'private-queue', approvalPolicy: 'never', sandbox: 'read-only' })
  const initial = await call('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'PRIVATE_QUEUE_INITIAL_' + sid }] })
  const completed = event => event.method === 'turn/completed' && event.params.turn.id === initial.turn.id
  if (!events.some(completed)) await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(listener); reject(new Error('Private original native turn did not end')) }, 10_000)
    const listener = event => { if (completed(event)) { clearTimeout(timer); listeners.delete(listener); resolve() } }
    listeners.add(listener)
  })
  const read = await call('thread/read', { threadId: started.thread.id, includeTurns: false })
  await writeFile(join(root, sid + '-identity.json'), JSON.stringify({ processId: process.pid, nativeSessionId: started.thread.id,
    transcriptPath: read.thread.path, capability: process.env.AGENTMUX_AGENT_CAPABILITY }) + '\n', { mode: 0o600 })
  process.stdout.write('Private native protocol ready\n')
} catch (error) { process.stderr.write(String(error) + '\n'); stop(); process.exitCode = 1 }
