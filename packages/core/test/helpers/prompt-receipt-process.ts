import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentPromptInputKey } from '../../src/agent-prompt-condition.js'

/** Actual source SDK in a cold owner process, then the source CLI over its real Unix RPC. */
export async function inspectPromptInSecondProcess(root: string, key: AgentPromptInputKey, database = join(root, 'sessions.json')) {
  const loader = fileURLToPath(new URL('./prompt-receipt-source-loader.mjs', import.meta.url))
  const reader = fileURLToPath(new URL('./prompt-receipt-reader.mjs', import.meta.url))
  const cli = fileURLToPath(new URL('../../src/agentmux.ts', import.meta.url))
  const socketRoot = await mkdtemp('/tmp/amux-receipt-')
  const socket = join(socketRoot, 'control.sock'), readback = join(root, 'cold-readback.json')
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(AGENTMUX_|CTXMUX_)/u.test(name)))
  Object.assign(env, { AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_STATE_DIRECTORY: join(root, 'state'),
    AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson'), AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json'),
    ...(process.env.AGENTMUX_TEST_RECEIPT_SOURCE_LOADS ? { AGENTMUX_TEST_RECEIPT_SOURCE_LOADS: process.env.AGENTMUX_TEST_RECEIPT_SOURCE_LOADS } : {}) })
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-loader', loader, reader, database, readback, socket, JSON.stringify(key)], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let error = ''
  child.stderr.on('data', chunk => { error += chunk })
  const closed = once(child, 'close')
  const timer = setTimeout(() => child.kill('SIGKILL'), 25_000)
  try {
    await new Promise<void>((resolve, reject) => {
      let output = ''
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) resolve() })
      child.once('error', reject); child.once('close', code => reject(new Error('Cold owner exited ' + code + ': ' + error)))
    })
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const command = spawn(process.execPath, ['--no-warnings', '--experimental-loader', loader, cli,
        '--endpoint', 'unix://' + socket, 'agent', 'input', 'inspect', '--input', '-'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
      const deadline = setTimeout(() => command.kill('SIGKILL'), 20_000)
      let stdout = '', stderr = ''
      command.stdout.on('data', value => { stdout += value }); command.stderr.on('data', value => { stderr += value })
      command.once('error', error => { clearTimeout(deadline); reject(error) }); command.once('close', code => { clearTimeout(deadline); resolve({ code, stdout, stderr }) })
      command.stdin.end(JSON.stringify({ key }))
    })
    if (result.code !== 0) throw Error('Source CLI failed: ' + result.stderr + result.stdout)
    return { readback: JSON.parse(await readFile(readback, 'utf8')), cli: JSON.parse(result.stdout) }
  } finally { clearTimeout(timer); child.stdin.end(); await closed; await rm(socketRoot, { recursive: true, force: true }) }
}
