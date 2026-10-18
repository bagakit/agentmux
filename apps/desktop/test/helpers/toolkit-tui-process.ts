import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { CustomToolkitOwner } from '../../src/main/toolkit-custom-owner.js'
import { ConfigOwner } from '../../src/main/config-owner.js'
import { ToolkitReceiptStore } from '../../src/main/toolkit-receipt-store.js'
import type { ToolkitRunPort } from '../../src/main/toolkit-run-port.js'
import type { AppConfig } from '../../src/shared/contracts.js'

// This process owns only its Core connection and Toolkit observer. The parent
// owns Native activation and cleanup, including when a disposal mutant fails.
const directory = process.argv[2]!
const config = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')) as AppConfig
const client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore(), providers: [] })
await client.connect()
const port: ToolkitRunPort = {
  create: async input => await client.createTerminal(input),
  observe: (ref, listener) => client.onEvent(event => {
    if (event.type === 'connection-state' || 'run' in event && event.run?.runId === ref.runId &&
        (event.type === 'process-state' || event.type === 'run-removed')) listener(event)
  }),
  attach: async (ref, after) => await client.attachTerminal(ref.runId, after, 'raw'),
  replay: async (ref, after) => await client.readRunReplay(ref, after, 'raw'),
  status: async ref => (await client.runtimeSubject({ kind: 'terminal-run', runId: ref.runId })).run,
  release: async ref => await client.releaseRunAttachment(ref),
  stop: async ref => await client.stopTerminal(ref),
  remove: async ref => await client.removeTerminal(ref)
}
const owner = new CustomToolkitOwner({
  config: new ConfigOwner({ read: () => config, save: async next => next, publish: () => {} }),
  receipts: new ToolkitReceiptStore(join(directory, 'receipts.json'), () => ['interactive']),
  openRunPort: async () => port, runner: process.execPath, env: {}
})
let closing = false
process.on('message', async value => {
  if (value !== 'dispose' || closing) return
  closing = true
  try {
    await owner.dispose()
    await client.dispose()
    process.send?.({ kind: 'disposed', pid: process.pid }, () => process.disconnect())
  } catch (error) {
    process.send?.({ kind: 'failed', message: String(error) }, () => process.disconnect())
    process.exitCode = 1
  }
})
await owner.loadConfigured()
process.send?.({ kind: 'ready', pid: process.pid, snapshot: await owner.get('interactive') })
