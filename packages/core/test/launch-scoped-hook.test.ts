import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runScopedHookCommand } from '../src/providers/shared.js'

const runner = fileURLToPath(new URL('../bin/agentmux-hook.js', import.meta.url))

async function invoke(program: string, args: string[], env: NodeJS.ProcessEnv, input: string) {
  const child = spawn(program, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') throw error })
  child.stdin.end(input)
  const exit = await result
  return { ...exit, stdout, stderr }
}

/** The actual packaged Hook entry sends to a private HTTP observer; no Provider config is installed. */
async function withCapture(use: (env: NodeJS.ProcessEnv, bodies: Record<string, unknown>[]) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'amux-launch-hook-'))
  const bodies: Record<string, unknown>[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
    response.writeHead(204, { 'x-agentmux-hook-mode': 'observer' })
    response.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Private Hook observer has no endpoint.')
  // The path exercises expansion and quoting; Node resolves the original module behind the symlink.
  const relocated = join(directory, `runner with spaces ' " \\ hook.js`)
  await symlink(runner, relocated)
  const env = { PATH: process.env.PATH, HOME: directory, AGENTMUX_STATE_DIRECTORY: directory,
    AGENTMUX_ENV: '1', AGENTMUX_PROVIDER_ID: 'claude', AGENTMUX_HOOK_PROVIDER: 'claude',
    AGENTMUX_HOOK_PAYLOAD_KEY: 'hook_event_name', AGENTMUX_HOOK_URL: `http://127.0.0.1:${address.port}/hook`,
    AGENTMUX_HOOK_TOKEN: 'private-launch-hook-token', AGENTMUX_HOOK_NODE: process.execPath,
    AGENTMUX_HOOK_RUNNER: relocated }
  try { await use(env, bodies) }
  finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}

const payload = JSON.stringify({ hook_event_name: 'Stop', session_id: 'private-original-native' })

describe('launch-scoped Hooks through the real Hook entry', () => {
  it('runs the generated launch command through its env-located runner, including paths with shell characters', async () => {
    await withCapture(async (env, bodies) => {
      const result = await invoke('/bin/sh', ['-c', runScopedHookCommand('claude')],
        { ...env, AGENTMUX_HOOK_LAUNCH_SCOPED: '1' }, payload)
      expect(result).toEqual({ code: 0, signal: null, stdout: '{}\n', stderr: '' })
      expect(bodies).toHaveLength(1)
      expect(bodies[0]).toMatchObject({ eventName: 'Stop', payload: { session_id: 'private-original-native' } })
    })
  })

  it('answers an unmarked leftover before stdin and never sends its event in a launch-scoped Run', async () => {
    await withCapture(async (env, bodies) => {
      const result = await invoke(process.execPath, [runner], { ...env, AGENTMUX_HOOK_LAUNCH_SCOPED: '1' },
        'x'.repeat(200 * 1024))
      expect(result).toEqual({ code: 0, signal: null, stdout: '{}\n', stderr: '' })
      expect(bodies).toEqual([])
    })
  })

  it.each(['0', undefined])('preserves ordinary unmarked Hook delivery when launch scope is %s', async scope => {
    await withCapture(async (env, bodies) => {
      const result = await invoke(process.execPath, [runner], { ...env, AGENTMUX_HOOK_LAUNCH_SCOPED: scope }, payload)
      expect(result).toEqual({ code: 0, signal: null, stdout: '{}\n', stderr: '' })
      expect(bodies).toHaveLength(1)
      expect(bodies[0]).toMatchObject({ eventName: 'Stop', payload: { session_id: 'private-original-native' } })
    })
  })

  it('keeps a launch declaration passive outside a Run whose Core provides its runner', async () => {
    await withCapture(async (env, bodies) => {
      const result = await invoke('/bin/sh', ['-c', runScopedHookCommand('claude')], {
        PATH: env.PATH, HOME: env.HOME, AGENTMUX_STATE_DIRECTORY: env.AGENTMUX_STATE_DIRECTORY
      }, payload)
      expect(result).toEqual({ code: 0, signal: null, stdout: '{}\n', stderr: '' })
      expect(bodies).toEqual([])
    })
  })
})
