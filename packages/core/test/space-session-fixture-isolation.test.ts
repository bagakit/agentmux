import { afterEach, expect, test, vi } from 'vitest'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { createSpaceSessionsFixture } from './helpers/space-session-fixture.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

test('Space fixture readers keep both Core owners inside separate private roots despite inherited runtime and queue paths', async () => {
  const ambient = await mkdtemp(join(tmpdir(), 'amx-unused-environment-'))
  cleanup.push(() => rm(ambient, { recursive: true, force: true }))
  const environment = {
    AGENTMUX_STATE_DIRECTORY: join(ambient, 'state'),
    AGENTMUX_RUNTIME_DIRECTORY: join(ambient, 'runtime'),
    AGENTMUX_MESSAGE_QUEUE_PATH: join(ambient, 'messages.ndjson'),
    AGENTMUX_AGENT_SESSION_STORE: join(ambient, 'sessions.json'),
    CTXMUX_SOCKET_PATH: join(ambient, 'native.sock')
  }
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)
  const fixture = await createSpaceSessionsFixture(cleanup)
  const paths: string[] = []
  for (const owner of [fixture.b, fixture.d]) {
    const original = owner.core as unknown as { kernel: { socketPath: string; stateDirectory: string }; deliveryAttempts: { directory: string } }
    const owned = [owner.core.agentMessageQueuePath(), original.kernel.socketPath, original.kernel.stateDirectory, original.deliveryAttempts.directory]
    for (const path of owned) {
      const child = relative(owner.root, path)
      expect(isAbsolute(child) || child === '..' || child.startsWith('../')).toBe(false)
      paths.push(path)
    }
    // Exercise the real journal reader only after its path is proven private.
    expect(await owner.core.inspectAgentInput({ key: { kind: 'prompt', agentSessionId: 'fixture-reader',
      expectedRun: { runId: 'fixture-reader-run' }, submissionId: 'fixture-read-only' } })).toBeNull()
    await expect(access(owner.core.agentMessageQueuePath())).resolves.toBeUndefined()
    expect(owner.runs).not.toHaveBeenCalled()
    expect(owner.inventory).not.toHaveBeenCalled()
  }
  expect(new Set(paths).size).toBe(paths.length)
  for (const [key, value] of Object.entries(environment)) expect(process.env[key]).toBe(value)
  for (const value of Object.values(environment)) await expect(access(value)).rejects.toMatchObject({ code: 'ENOENT' })
})
