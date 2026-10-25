import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../bin/amux', import.meta.url))
const hook = fileURLToPath(new URL('../bin/agentmux-hook.js', import.meta.url))
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tool-context-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  let rpcConnections = 0, hookRequests = 0
  const server = createServer(socket => { rpcConnections++; socket.destroy() })
  await new Promise<void>(resolve => server.listen(join(root, 'a.sock'), resolve))
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const http = createHttpServer((_request, response) => { hookRequests++; response.end('{}') })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => http.close(() => resolve())))
  const address = http.address() as { port: number }
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTMUX_TOOL_CONTEXT: 'unconfigured', AGENTMUX_RPC_ENDPOINT: 'unix:' + join(root, 'a.sock'),
    AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined,
    AGENTMUX_HOOK_URL: `http://127.0.0.1:${address.port}/hook`, AGENTMUX_HOOK_TOKEN: 'stale-hook-token', AGENTMUX_ENV: '1' }
  async function run(args: string[], target = cli, environment = env) {
    try {
      const pending = exec(process.execPath, ['--disable-warning=ExperimentalWarning', target, ...args], { env: environment, timeout: 10_000 }); pending.child.stdin!.end('{}')
      return { code: 0, ...await pending }
    } catch (error) { return error as { code: number; stdout: string; stderr: string } }
  }
  return { env, run, counts: () => ({ rpcConnections, hookRequests }) }
}
it.each([undefined, 'original-agent-on-B'])('built CLI refuses control with original claim %s before opening any resource Host socket, including stdio and Hook', async sid => {
  const f = await fixture(); f.env.AGENTMUX_AGENT_SESSION_ID = sid
  for (const args of [['whoami'], ['system', 'endpoint', '--stdio'], ['system', 'endpoint', '--inspect']]) {
    const result = await f.run(args)
    expect(result.code).not.toBe(0)
    expect(JSON.parse(result.stderr).error.code).toBe('AGENT_TOOL_CONTEXT_UNAVAILABLE')
  }
  const result = await f.run([], hook)
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain('original Agent Host route')
  expect(result.stdout.length).toBeGreaterThan(0) // Preserve passive Hook output; do not gate a healthy tool.
  expect(f.counts()).toEqual({ rpcConnections: 0, hookRequests: 0 })
})
it('built offline discovery and ordinary native commands remain usable; ordinary local mode still reaches its endpoint', async () => {
  const f = await fixture()
  for (const args of [['--help'], ['--skill'], ['agent', '--skill'], ['agent', 'ls', '--help']]) {
    const result = await f.run(args); expect(result.code).toBe(0); expect(result.stdout.length).toBeGreaterThan(0)
  }
  const native = await exec('/bin/sh', ['-c', 'printf ordinary-native'], { env: f.env })
  expect(native.stdout).toBe('ordinary-native')
  expect(f.counts()).toEqual({ rpcConnections: 0, hookRequests: 0 })
  await f.run(['whoami'], cli, { ...f.env, AGENTMUX_TOOL_CONTEXT: undefined })
  expect(f.counts().rpcConnections).toBe(1)
})
