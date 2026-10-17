// Finite private source CLI → Core server → original Renderer admission seam.
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { join } from 'node:path'
register(new URL('../desktop-map/source-loader.mjs', import.meta.url), import.meta.url)
const { AgentMuxControlServer } = await import('../../../../../packages/core/src/control-host.ts')
const { runSourceObjectCli } = await import('../../../../../packages/core/test/helpers/source-object-cli.ts')
const [privateRoot] = process.argv.slice(2)
assert.ok(privateRoot && process.send, 'Only the private capture parent owns this host')
const send = value => { if (process.connected) process.send(value) }
const pending = new Map(), loader = new URL('../desktop-map/source-loader.mjs', import.meta.url)
const commands = { map: ['app', 'focus', '--surface', 'space', '--view', 'map'], workbench: ['app', 'focus', '--surface', 'space', '--view', 'workbench'], inspect: ['app', 'inspect'] }
const environment = { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: privateRoot, AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'control-state'), AGENTMUX_AGENT_SESSION_STORE: join(privateRoot, 'control-sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(privateRoot, 'control-messages.ndjson') }
const server = new AgentMuxControlServer({ socketPath: join(privateRoot, 'c.sock'), coreClients: () => [], execute: request => {
  if (request.operation !== 'focus' && request.operation !== 'inspect.client') throw Error('Only original navigation and inspection belong to this finite capture')
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(request.requestId); send({ kind: 'cancel', id: request.requestId }); reject(Error('Original Renderer admission did not settle')) }, 9000)
    pending.set(request.requestId, { resolve, reject, timeout })
    send({ kind: 'execute', request })
  })
} })
let running = false, stopped = false
async function stop() {
  if (stopped) return
  stopped = true
  for (const [id, item] of pending) { clearTimeout(item.timeout); send({ kind: 'cancel', id }); item.reject(Error('Private control host stopped')) }
  pending.clear(); await server.stop(); if (process.connected) process.disconnect()
}
process.on('message', async message => {
  if (message?.kind === 'execute-result') {
    const item = pending.get(message.id)
    if (!item) return
    pending.delete(message.id); clearTimeout(item.timeout)
    if (message.error) item.reject(Object.assign(Error(message.error.message), { code: message.error.code })); else item.resolve(message.result)
  } else if (message?.kind === 'run') {
    if (running || !Object.hasOwn(commands, message.step)) { send({ kind: 'cli-result', error: 'Unknown or concurrent private CLI step' }); return }
    running = true
    try {
      const result = await runSourceObjectCli(['--endpoint', 'unix://' + server.path, ...commands[message.step]], environment, '', 10000, loader)
      send({ kind: 'cli-result', step: message.step, result })
    } catch (error) { send({ kind: 'cli-result', step: message.step, error: error.message }) }
    finally { running = false }
  } else if (message?.kind === 'stop') await stop()
})
process.on('disconnect', () => { void stop() })
process.on('SIGTERM', () => { void stop() })
await server.start(); send({ kind: 'ready' })
