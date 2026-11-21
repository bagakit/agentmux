import { mkdir, readFile } from 'node:fs/promises'
import { createModelStateMainBridge } from './model-state-main-bridge.mjs'
import { modelStateOwnerFixture } from './model-state-owner.mjs'

const directory = process.argv[2]
if (!directory || !process.send) throw new Error('The private Main owner needs its isolated directory and IPC channel.')
await mkdir(directory, { recursive: true })
const core = await import('@agentmux/core')
const { sessionInputOperationResult } = await import('../../../../apps/desktop/src/shared/session-input-result.ts')
const native = process.argv[3] === 'native'
const onRuntimeEvent = event => process.send({ type: 'runtime-event', event })
const f = native ? await (await import('./codex-model-state-native.mjs')).createNativeModelStateFixture({ onRuntimeEvent })
  : await modelStateOwnerFixture(core, directory, { mode: process.argv[3] === 'restore' ? 'restore' : 'create',
    ...(process.argv[4] ? { processId: Number(process.argv[4]) } : {}),
    ...(process.argv[5] ? { initialObservation: JSON.parse(process.argv[5]) } : {}) })
const bridge = native ? f.bridge : await createModelStateMainBridge({ client: f.client, directory, agentSessionId: f.id, onRuntimeEvent })
const nativeRequestCounts = async () => {
  if (!process.env.AMX_MODEL_SYNC_NATIVE_TRACE) return null
  const frames = (await readFile(process.env.AMX_MODEL_SYNC_NATIVE_TRACE, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const sent = frames.filter(frame => frame.phase === 'send' && frame.method)
  return Object.fromEntries([...new Set(sent.map(frame => frame.method))].sort().map(method => [method, sent.filter(frame => frame.method === method).length]))
}
let closing = false
const close = async () => { if (closing) return; closing = true; if (!native) await bridge.close(); await f.close() }
process.once('SIGTERM', () => { void close().finally(() => process.exit()) })
process.on('message', message => {
  if (message?.type !== 'call') return
  void (async () => {
    let result
    switch (message.method) {
      case 'inspectConfiguration': result = await bridge.inspectConfiguration(...message.args); break
      case 'inspectInformation': result = await bridge.inspectInformation(...message.args); break
      case 'setConfiguration': result = await bridge.setConfiguration(...message.args);
        if (f.state?.dropReply) { f.state.dropReply = false; throw new core.AgentMuxError('The original Main reply was lost after dispatch.',
          'CONTROL_CONNECTION_FAILED', undefined, { disposition: 'unknown', confirmedInputBytes: null }) }
        break
      case 'emit': if (native) throw new Error('A real native scene accepts only its original TUI and protocol events.');
        result = await f.emit(f.snapshot(message.args[0])); break
      case 'selectInTui': result = await f.selectInTui(); break
      case 'nativeRead': result = await f.nativeRead(); break
      case 'verifyExternalInTui': result = await f.verifyExternalInTui(...message.args); break
      case 'mode': if (native) throw new Error('The real native scene does not synthesize Provider outcomes.');
        Object.assign(f.state, message.args[0]); result = null; break
      case 'stats': result = native ? { native: true, proof: f.proof, modelHttpRequests: f.modelHttpRequests, requests: bridge.requests,
        thread: await f.nativeRead(), nativeRequests: await nativeRequestCounts() } : { informationReads: f.state.reads, configurationReads: f.state.configurations,
        nativeWrites: f.state.writes, runtimeWrites: f.state.runtimeWrites, requests: bridge.requests }; break
      case 'close': await close(); process.send({ type: 'reply', id: message.id, result: null }, () => process.exit()); return
      default: throw new Error('Unknown private Main fixture method.')
    }
    process.send({ type: 'reply', id: message.id, result })
  })().catch(async error => {
    const failure = await sessionInputOperationResult(() => Promise.reject(error))
    process.send({ type: 'reply', id: message.id, error: failure.error })
  })
})
const initial = await bridge.inspectConfiguration()
process.send({ type: 'ready', control: bridge.control, inspection: initial, session: f.client.agentSession(bridge.control.agentSessionId), endpoint: bridge.endpoint })
