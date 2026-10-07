import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentMuxClientEvent } from '../src/types.js'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'

describe.runIf(process.platform === 'darwin' && process.arch === 'arm64')('Hosted read observations on a healthy private Run', () => {
  it('keeps alternating status and creation observations quiet while the original process, output and accepted input remain unchanged', async () => {
    const scope = await headlessFixture()
    try {
      const client = await scope.client()
      const created = await client.createAgent({ providerId: 'codex', executorId: 'fixture', workspacePath: scope.root,
        injectAgentMuxGuide: false, commandOverride: resolve(import.meta.dirname, 'fixtures/fake-codex-cli.mjs'),
        env: { AGENTMUX_FAKE_NATIVE_RECORD: '1' } })
      await until(() => client.agentSession(created.agentSessionId), session => Boolean(session.nativeHandle) && session.semanticStatus?.state === 'done', 'private native status settled')
      const before = await client.statusAgent(created.agentSessionId)
      const originalReplay = await client.readRunReplay(before.session.run, 0, 'raw')
      const native = client.runtimeIdentity()
      expect(before.run.state).toBe('running')
      expect(before.run.pid).toBeTypeOf('number')
      const acceptedBefore = originalReplay.run.acceptedInputBytes!
      expect(acceptedBefore).toBeTypeOf('number')
      expect(originalReplay.replay.length).toBeGreaterThan(0)
      const events: AgentMuxClientEvent[] = []
      const release = client.onEvent(event => {
        if (event.type === 'agent-session' && event.session.agentSessionId === created.agentSessionId) events.push(event)
      })
      try {
        for (let index = 0; index < 8; index++) {
          const current = await client.statusAgent(created.agentSessionId)
          expect(current.session).toEqual(before.session)
          expect(current.run).toMatchObject({ runId: before.run.runId, pid: before.run.pid, state: 'running', acceptedInputBytes: acceptedBefore })
          expect(await client.inspectAgentCreation(created.agentSessionId)).toEqual(before.session)
        }
        expect(events).toEqual([])
        const after = await client.readRunReplay(before.session.run, 0, 'raw')
        expect(after.run).toMatchObject({ runId: originalReplay.run.runId, pid: originalReplay.run.pid, state: 'running',
          acceptedInputBytes: acceptedBefore, latestOutputBytes: originalReplay.run.latestOutputBytes })
        expect(after.replay.map(chunk => Buffer.from(chunk.dataBytes).toString('base64')))
          .toEqual(originalReplay.replay.map(chunk => Buffer.from(chunk.dataBytes).toString('base64')))
        expect(client.runtimeIdentity()).toEqual(native)
        console.info(JSON.stringify({ schema: 'agentmux.hosted-observation-healthy-run.v1',
          agentSessionId: created.agentSessionId, runId: before.run.runId, processId: before.run.pid,
          sameNativeInstance: native.instanceId, statusReads: 8, creationReads: 8, sessionEvents: events.length,
          acceptedInputBytesBefore: acceptedBefore, acceptedInputBytesAfter: after.run.acceptedInputBytes, originalOutputRetained: true }))
      } finally { release() }
    } finally { await scope.cleanup() }
  }, 30_000)
})
