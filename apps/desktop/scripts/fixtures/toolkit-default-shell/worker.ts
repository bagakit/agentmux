import { createHash } from 'node:crypto'
import { appendFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AgentMuxFileAgentSessionStore,
  AgentMuxError,
  startHeadlessAgentMux,
  AgentMuxControlServer,
} from '@agentmux/core'
import { RuntimeController } from '../../../src/main/runtime-controller.js'
import {
  connectDesktopAgentMuxHost,
  desktopBusinessSocketPath,
} from '../../../src/main/desktop-host.js'
import { ConfigStore, DEFAULT_CONFIG } from '../../../src/main/config-store.js'
import { ConfigOwner } from '../../../src/main/config-owner.js'
import { ToolkitOwner } from '../../../src/main/toolkit-owner.js'

// The parent owns the private Native and exact process cleanup. These are the
// production business owners with only Electron app paths supplied by the fixture.
const [role, directory, cli, resource] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
]
const store = new AgentMuxFileAgentSessionStore(
  join(directory, 'sessions.json'),
)
let dispose: () => Promise<void>
if (role === 'host') {
  let loseReply = process.env.PRIVATE_DEFAULT_SHELL_LOSE_REPLY === '1'
  delete process.env.PRIVATE_DEFAULT_SHELL_LOSE_REPLY
  const host = await startHeadlessAgentMux({ store, providers: [] })
  await host.client.connectRuntime()
  const create = host.client.createPreparedTerminal.bind(host.client)
  host.client.createPreparedTerminal = async (input) => {
    const run = await create(input)
    const request = JSON.parse(input.launch).request
    await appendFile(
      join(directory, 'creates.jsonl'),
      JSON.stringify({
        createOperationId: input.createOperationId,
        requestSHA256: createHash('sha256')
          .update(JSON.stringify(input))
          .digest('hex'),
        args: request.args,
        cwd: request.cwd,
        environmentKeys: Object.keys(request.env),
        run,
      }) + '\n',
      { mode: 0o600 },
    )
    if (loseReply) {
      loseReply = false
      throw new AgentMuxError(
        'Private creation reply lost after Native returned its Run.',
        'CONTROL_UNAVAILABLE',
      )
    }
    return run
  }
  dispose = () => host.stop()
  process.send?.({
    kind: 'ready',
    role,
    pid: process.pid,
    owner: host.ownerIdentity(),
  })
} else if (role === 'main') {
  const configStore = new ConfigStore(join(directory, 'config.json'))
  try {
    await access(join(directory, 'config.json'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await configStore.save({
      ...structuredClone(DEFAULT_CONFIG),
      toolkit: { tools: [] },
    })
  }
  let config = await configStore.get(),
    toolkit!: ToolkitOwner
  const runtime = new RuntimeController(store, connectDesktopAgentMuxHost)
  runtime.commit(await runtime.prepare(config))
  const configOwner = new ConfigOwner({
    read: () => config,
    save: (next) => configStore.save(next),
    prepare: (current, next) => toolkit.prepareConfig(current, next),
    publish: (next) => {
      config = next
      toolkit.configurationChanged()
    },
  })
  toolkit = new ToolkitOwner({
    config: configOwner,
    openRunPort: () => runtime.toolkitRunPort(),
    receiptPath: join(directory, 'toolkit-receipts.json'),
    enabled: () => false,
    launch: () => ({
      runner: process.execPath,
      cli,
      script: resource,
      cwd: directory,
      env: {},
    }),
  })
  const server = new AgentMuxControlServer({
    socketPath: desktopBusinessSocketPath(),
    toolkit,
    coreClients: () => [],
  })
  await server.start()
  await toolkit.load()
  dispose = async () => {
    await server.stop()
    await toolkit.dispose()
    await runtime.dispose()
    runtime.resourceSampler.dispose()
  }
  process.send?.({
    kind: 'ready',
    role,
    pid: process.pid,
    endpoint: 'unix:' + desktopBusinessSocketPath(),
  })
} else throw new Error('The private worker must name its Host or Main role')

let closing = false
process.on('message', async (message) => {
  if (message !== 'dispose' || closing) return
  closing = true
  try {
    await dispose()
    process.send?.({ kind: 'disposed', role, pid: process.pid }, () =>
      process.disconnect(),
    )
  } catch (error) {
    process.send?.({ kind: 'failed', message: String(error) }, () =>
      process.disconnect(),
    )
    process.exitCode = 1
  }
})
