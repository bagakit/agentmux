import { createInterface } from 'node:readline'

const { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentManagedHookInstaller, AgentProviderRegistry } = await import(process.argv[2])
const config = JSON.parse(process.argv[3])
const client = new AgentMuxClient({ providers: [new AgentProviderRegistry().get('grok')],
  store: new AgentMuxFileAgentSessionStore(config.storePath), hookInstaller: new AgentManagedHookInstaller(config.receipts) })
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
client.onEvent(event => { send({ event }) })
const allowed = new Set(['connect', 'createAgent', 'statusAgent', 'readAgentSession', 'sessionTimeline',
  'reattachAgent', 'listRuns', 'inspectManagedHooks', 'stopAgent', 'dispose'])
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, args } = JSON.parse(line)
  try {
    if (!allowed.has(method)) throw Error('Unsupported private Core proof method')
    const value = await client[method](...args)
    if (method === 'dispose') {
      await new Promise(resolve => process.stdout.write(JSON.stringify({ id, value: null }) + '\n', resolve))
      process.exit(0)
    }
    send({ id, value: value ?? null })
  } catch (error) { send({ id, error: { message: error.message, code: error.code, stack: error.stack } }) }
}
await client.dispose()
