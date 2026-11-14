import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

export async function runStorageSourceCli(root: string, socket: string, args: readonly string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(AGENTMUX_|CTXMUX_)/u.test(name)))
  Object.assign(env, { AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_STATE_DIRECTORY: join(root, 'state'),
    AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson'),
    ...(process.env.AGENTMUX_TEST_RECEIPT_SOURCE_LOADS ? { AGENTMUX_TEST_RECEIPT_SOURCE_LOADS: process.env.AGENTMUX_TEST_RECEIPT_SOURCE_LOADS } : {}) })
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', '--experimental-loader', fileURLToPath(new URL('./prompt-receipt-source-loader.mjs', import.meta.url)),
      fileURLToPath(new URL('../../src/agentmux.ts', import.meta.url)), '--endpoint', 'unix://' + socket, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
    child.once('error', error => { clearTimeout(timer); reject(error) }); child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}
