import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentMuxError, type AgentMuxControlFailure } from '../src/errors.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

describe('compiled CLI business error facts', () => {
  it.each<AgentMuxControlFailure>([
    { disposition: 'not_applied', confirmedInputBytes: 0 },
    { disposition: 'unknown', confirmedInputBytes: null },
    { disposition: 'unknown', confirmedInputBytes: 3 }
  ])('preserves original business and control failure facts without retrying: %j', async controlFailure => {
    const root = await mkdtemp(join(tmpdir(), 'cli-business-error-'))
    const path = join(root, 'control.sock')
    const operations: string[] = []
    const candidates = [{ agentSessionId: 'A', regionIds: ['R1'] }, { agentSessionId: 'B', regionIds: ['R2'] }]
    const original = Object.assign(new AgentMuxError('Private business refused.', 'BUSINESS_REFUSED', 'not_applied', controlFailure),
      { details: { availability: 'unknown' }, candidates })
    const server = new AgentMuxControlServer({ coreClients: () => [], execute: async request => {
      operations.push(request.operation)
      throw original
    } }, path)
    await server.start()
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
    try {
      await expect(rpc.call('settings.inspect', { target: 'copyPathsAsAbsolute' })).rejects.toMatchObject({
        code: original.code, message: original.message, detail: original.detail, details: original.details, candidates, controlFailure
      })
      const reply = await runCompiledObjectCli(['--endpoint', 'unix://' + path, 'settings', 'inspect', 'copyPathsAsAbsolute'],
        objectCliEnvironment(root))
      expect(reply.code, reply.stderr).toBe(1)
      expect(reply.stdout).toBe('')
      expect(JSON.parse(reply.stderr)).toEqual({
        ok: false, operation: 'settings.inspect', error: {
          code: original.code, message: original.message, detail: original.detail, details: original.details, candidates, controlFailure
        }
      })
      expect(operations).toEqual(['settings.get', 'settings.get'])
    } finally {
      await rpc.dispose()
      await server.stop()
      await rm(root, { recursive: true })
    }
  })
})
