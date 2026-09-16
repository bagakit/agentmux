import { api } from '../../../src/renderer/src/lib/api'

const errors = []
window.addEventListener('error', event => errors.push(event.message))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))
const deliveries = []
const disposers = []
for (let index = 0; index < 8; index++) {
  const control = { kind: 'terminal', hostId: 'private-host', runId: `private-run-${index}`, run: { runId: `private-run-${index}` } }
  disposers.push(api.sessions.onEvent(event => {
    const core = event.event
    if (core.type !== 'terminal-output') throw new Error('The bounded probe permits exactly one output event')
    deliveries.push({ index, event, data: core.dataBytes,
      matches: event.hostId === control.hostId && core.run.runId === control.run.runId })
  }, control))
}
window.bridgeProbe = () => ({
  errors: [...errors], registeredConsumers: disposers.length,
  deliveries: deliveries.map(item => ({ index: item.index, matches: item.matches,
    bytes: item.data.byteLength, first: item.data[0], last: item.data[item.data.length - 1] })),
  envelopeIdentities: new Set(deliveries.map(item => item.event)).size,
  typedArrayIdentities: new Set(deliveries.map(item => item.data)).size,
  backingBufferIdentities: new Set(deliveries.map(item => item.data.buffer)).size,
  receivedBytes: deliveries.reduce((sum, item) => sum + item.data.byteLength, 0)
})
window.finishBridgeProbe = () => disposers.splice(0).forEach(dispose => dispose())
window.bridgeProbeReady = true
