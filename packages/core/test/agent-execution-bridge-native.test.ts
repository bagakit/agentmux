import { expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentExecutionBridge, type AgentExecutionBridgePort, type AgentExecutionBridgeState } from '../src/agent-execution-bridge.js'
import type { AgentMuxRunInputOperation } from '../src/types.js'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'

it('delivers one large original JSON frame through real Core/SDK Input chunks after a middle ACK loss and Core restart', async () => {
  const scope = await headlessFixture({ cli: true })
  let client = await scope.client()
  await client.connectRuntime()
  const runs: { runId: string }[] = [], frames: unknown[] = []
  let bridge: AgentExecutionBridge | undefined
  try {
    const original = Buffer.from(JSON.stringify({ type: 'request', generation: 'original-native-generation', payload: {
      id: 'one-original-native-operation', data: '中文'.repeat(400_000) } }) + '\n')
    const sourcePath = join(scope.root, 'source.jsonl'), resultPath = join(scope.root, 'applied.jsonl'), savedPath = join(scope.root, 'bridge.json'), triggerPath = join(scope.root, 'emit')
    await writeFile(sourcePath, original)
    const source = await client.createTerminal({ workspacePath: scope.root, command: process.execPath, createOperationId: randomUUID(), args: ['-e',
      `process.stdin.setRawMode(true);process.stdout.write(JSON.stringify({type:'ready',side:'source'})+'\\n');const timer=setInterval(()=>{if(require('node:fs').existsSync(process.argv[2])){clearInterval(timer);process.stdout.write(require('node:fs').readFileSync(process.argv[1]))}},10);setInterval(()=>{},1000)`, sourcePath, triggerPath] })
    runs.push({ runId: source.runId })
    const sink = await client.createTerminal({ workspacePath: scope.root, command: process.execPath, createOperationId: randomUUID(), args: ['-e',
      `process.stdin.setRawMode(true);process.stdout.write(JSON.stringify({type:'ready',side:'sink'})+'\\n');const parts=[];let count=0;process.stdin.on('data',b=>{parts.push(b);if(b.includes(10)){const all=Buffer.concat(parts);const value=JSON.parse(all.toString());count++;require('node:fs').appendFileSync(process.argv[1],JSON.stringify({count,id:value.payload.id,bytes:all.length,digest:require('node:crypto').createHash('sha256').update(all).digest('hex')})+'\\n');parts.length=0}});setInterval(()=>{},1000)`, resultPath] })
    runs.push({ runId: sink.runId })
    await until(async () => await Promise.all(runs.map(run => client.readRunReplay(run, 0, 'raw'))),
      snapshots => snapshots.every(snapshot => snapshot.replay.some(chunk => chunk.data.includes('ready'))), 'both original raw helper PTYs')
    const ownerInstanceId = client.runtimeIdentity().instanceId
    let saved: AgentExecutionBridgeState = { bindingId: randomUUID(), frontend: { runId: source.runId, ownerInstanceId, inputByte: 0, outputByte: 0 }, executor: { runId: sink.runId, ownerInstanceId, inputByte: 0, outputByte: 0 } }
    const attempts: AgentMuxRunInputOperation[] = [], replayRanges: { start: number; end: number; bytes: number }[] = [], errors: Error[] = []
    let loseAck = true
    const port = (): AgentExecutionBridgePort => new Proxy(client, { get(target, property) {
      if (property === 'writeTerminal') return async (run: { runId: string }, operation: AgentMuxRunInputOperation) => {
        attempts.push(structuredClone(operation))
        const receipt = await target.writeTerminal(run, operation)
        if (loseAck && attempts.length === 2) { loseAck = false; throw new Error('Injected loss after the original second Input receipt') }
        return receipt
      }
      if (property === 'readRunReplay') return async (...args: Parameters<typeof target.readRunReplay>) => {
        const replay = await target.readRunReplay(...args)
        replayRanges.push(...replay.replay.map(chunk => ({ start: chunk.startByte, end: chunk.endByte, bytes: chunk.dataBytes.byteLength })))
        return replay
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    } }) as unknown as AgentExecutionBridgePort
    const make = () => new AgentExecutionBridge({ state: saved, ports: { frontend: port(), executor: port() },
      persist: async next => { await writeFile(savedPath, JSON.stringify(next)); saved = structuredClone(next) },
      onFrame: async (_side, frame) => { frames.push(frame) }, onError: error => { errors.push(error) } })
    bridge = make(); await bridge.start()
    const start = saved.frontend.outputByte
    await writeFile(triggerPath, 'emit once')
    await until(() => errors, values => values.length === 1, 'lost original middle Input acknowledgement')
    expect(saved.frontend.outputByte).toBe(start)
    expect(saved.pending?.sourceStartByte).toBe(start)
    const sourceReplay = await client.readRunReplay({ runId: source.runId }, start, 'raw')
    expect(sourceReplay.gap).toBeNull()
    const transported = Buffer.concat(sourceReplay.replay.map(chunk => Buffer.from(chunk.dataBytes)))
    expect(JSON.parse(transported.toString())).toEqual(JSON.parse(original.toString()))
    expect(saved.pending?.sourceEndByte).toBe(start + transported.byteLength)
    expect(saved.pending!.chunk!.offset).toBeGreaterThan(0)
    const uncertain = structuredClone(attempts[1])
    await bridge.close(); bridge = undefined
    const before = scope.owner
    await scope.restart()
    expect(scope.owner.ownerInstanceId).not.toBe(before.ownerInstanceId)
    client = await scope.client(); await client.connectRuntime()
    expect(client.runtimeIdentity().instanceId).toBe(ownerInstanceId)
    saved = JSON.parse(await readFile(savedPath, 'utf8'))
    bridge = make(); await bridge.start()
    const result = await until(async () => { try { return await readFile(resultPath, 'utf8') } catch { return '' } }, value => value.endsWith('\n'), 'one complete original native frame')
    expect(attempts[2]).toEqual(uncertain)
    expect(result.trim().split('\n').map(line => JSON.parse(line))).toEqual([{ count: 1, id: 'one-original-native-operation', bytes: transported.byteLength,
      digest: createHash('sha256').update(transported).digest('hex') }])
    expect(replayRanges[0]!.start).toBe(start)
    expect(replayRanges.at(-1)!.end).toBe(start + transported.byteLength)
    expect(saved.pending).toBeUndefined()
    expect(saved.frontend.outputByte).toBe(start + transported.byteLength)
    expect(saved.executor.inputByte).toBe(transported.byteLength)
    expect(errors).toHaveLength(1)
  } finally {
    await bridge?.close()
    const failures: unknown[] = []
    for (const run of runs) { try { await client.stopTerminal(run) } catch (error) { failures.push(error) } }
    try { await scope.cleanup() } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'Private helper cleanup is unconfirmed')
  }
}, 60_000)
