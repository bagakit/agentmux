import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClientEventPublisher } from '../src/client-event-publisher.js'
import { AgentExecutionBridge, type AgentExecutionBridgeState } from '../src/agent-execution-bridge.js'
import type { AgentMuxClientEvent } from '../src/types.js'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'

type PublisherProbe = { runListeners: Map<string, Map<unknown, unknown>>;
  deliver(event: AgentMuxClientEvent, registrations: unknown[]): void }

describe.runIf(process.platform === 'darwin' && process.arch === 'arm64')('Hosted exact Run consumers on real private PTYs', () => {
  it('keeps live bridge dispatch indexed with 10,000 unrelated registrations and leaves both Runs healthy after reader release', async () => {
    const scope = await headlessFixture({ cli: true })
    const runs: string[] = [], releases: (() => void)[] = []
    let bridge: AgentExecutionBridge | undefined
    try {
      const client = await scope.client(), trigger = join(scope.root, 'trigger'), effects = join(scope.root, 'effects')
      await writeFile(trigger, '0')
      const front = await client.createTerminal({ workspacePath: scope.root, command: process.execPath, args: ['-e', `
        const fs = require('node:fs'); process.stdin.setRawMode(true); process.stdin.resume();
        const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
        let sequence = 0, pending = '';
        setInterval(() => { const next = Number(fs.readFileSync(process.argv[1], 'utf8'));
          if (next > sequence) { sequence = next; send({type:'request',generation:'original',payload:{id:sequence,method:'fixture',params:{}}}); }
        }, 10);
        process.stdin.on('data', bytes => { pending += bytes; let end;
          while ((end = pending.indexOf('\\n')) >= 0) { const frame = JSON.parse(pending.slice(0,end)); pending = pending.slice(end+1);
            send({type:'received',id:frame.payload.id}); }
        }); send({type:'ready'});
      `, trigger] })
      runs.push(front.runId)
      const exec = await client.createTerminal({ workspacePath: scope.root, command: process.execPath, args: ['-e', `
        const fs = require('node:fs'); process.stdin.setRawMode(true); process.stdin.resume(); let pending = '';
        const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
        process.stdin.on('data', bytes => { pending += bytes; let end;
          while ((end = pending.indexOf('\\n')) >= 0) { const frame = JSON.parse(pending.slice(0,end)); pending = pending.slice(end+1);
            fs.appendFileSync(process.argv[1], frame.payload.id + '\\n');
            send({type:'response',generation:frame.generation,payload:{id:frame.payload.id,result:{accepted:true}}}); }
        }); send({type:'ready'});
      `, effects] })
      runs.push(exec.runId)
      const instance = client.runtimeIdentity().instanceId
      const position = (runId: string) => ({ runId, ownerInstanceId: instance, inputByte: 0, outputByte: 0 })
      const state: AgentExecutionBridgeState = { bindingId: randomUUID(), frontend: position(front.runId), executor: position(exec.runId) }
      const observed: Array<{ side: string; frame: unknown }> = [], errors: Error[] = []
      const registration = vi.spyOn(AgentMuxClientEventPublisher.prototype, 'onRunEvent')
      const unscoped = vi.spyOn(client, 'onEvent')
      bridge = new AgentExecutionBridge({ state, ports: { frontend: client, executor: client }, persist: async () => {},
        onFrame: async (side, frame) => { observed.push({ side, frame }) }, onError: error => { errors.push(error) } })
      await bridge.start()
      await until(() => observed.filter(item => (item.frame as { type?: string }).type === 'ready').length, count => count === 2, 'both raw protocol processes ready')
      expect(unscoped).not.toHaveBeenCalled()
      expect(registration.mock.calls.map(([runId]) => runId)).toEqual([front.runId, exec.runId])
      const publisher = registration.mock.contexts[0] as unknown as PublisherProbe
      expect(registration.mock.contexts[1]).toBe(publisher)
      const registry = publisher.runListeners
      const scans = [vi.spyOn(registry, Symbol.iterator), vi.spyOn(registry, 'entries'), vi.spyOn(registry, 'values'),
        vi.spyOn(registry, 'keys'), vi.spyOn(registry, 'forEach')]
      const deliver = vi.spyOn(publisher, 'deliver')
      let unrelatedCalls = 0
      const costs: number[][] = []
      for (const sequence of [1, 2]) {
        if (sequence === 2) for (let index = 0; index < 10_000; index++) {
          releases.push(client.onRunEvent(`unrelated-${index}`, () => { unrelatedCalls++ }))
        }
        deliver.mockClear(); for (const scan of scans) scan.mockClear()
        await writeFile(trigger, String(sequence))
        await until(() => observed.some(item => (item.frame as { type?: string; id?: number }).type === 'received' &&
          (item.frame as { id?: number }).id === sequence), Boolean, 'real native bytes cross Hosted bridge in both directions')
        expect(await readFile(effects, 'utf8')).toBe(sequence === 1 ? '1\n' : '1\n2\n')
        const counts = new Map<AgentMuxClientEvent, number>()
        for (const [event, listeners] of deliver.mock.calls) if (event.type === 'terminal-output') {
          counts.set(event, (counts.get(event) ?? 0) + listeners.length)
        }
        expect(counts.size).toBeGreaterThanOrEqual(3)
        expect([...counts.values()].every(count => count === 1)).toBe(true)
        expect(scans.every(scan => scan.mock.calls.length === 0)).toBe(true)
        expect(unrelatedCalls).toBe(0)
        costs.push([...counts.values()])
      }
      expect(errors).toEqual([])
      expect(unscoped).not.toHaveBeenCalled()
      const snapshot = bridge.snapshot()
      expect(snapshot.pending).toBeUndefined()
      expect(snapshot.frontend.runId).toBe(front.runId); expect(snapshot.executor.runId).toBe(exec.runId)
      expect(snapshot.executor.inputByte).toBeGreaterThan(0)
      await bridge.close(); bridge = undefined
      expect(registry.has(front.runId)).toBe(false); expect(registry.has(exec.runId)).toBe(false)
      const originalNative = client.runtimeIdentity().instanceId
      for (const runId of runs) {
        const replay = await client.readRunReplay({ runId }, 0, 'raw')
        expect(replay.run).toMatchObject({ runId, state: 'running' }); expect(replay.gap).toBeNull()
        expect(replay.replay.length).toBeGreaterThan(0)
      }
      expect(client.runtimeIdentity().instanceId).toBe(originalNative)
      console.info(JSON.stringify({ scope: 'real-hosted-run-event-index', actualMachines: 1, unrelatedRegistrations: [0, 10_000],
        candidateVisitsPerOutputEvent: costs, unrelatedCallbacks: unrelatedCalls, registryScans: 0, originalRunsRetained: true }))
    } finally {
      await bridge?.close()
      for (const release of releases) release()
      vi.restoreAllMocks()
      const client = await scope.client().catch(() => null)
      for (const runId of runs) await client?.stopTerminal({ runId }).catch(() => {})
      await scope.cleanup()
    }
  }, 40_000)
})
