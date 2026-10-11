import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export function continuityExecutorProvider(core, executable) {
  return core.defineAgentProvider({ catalog: { id: 'execution-source', label: 'Private execution source', executable,
    expectedProcess: 'node', promptDelivery: 'positional-argv', readySignal: { kind: 'foreground-process', expectedProcess: 'node' },
    hookStrategy: { kind: 'none' }, resumeStrategy: { kind: 'provider-native', locator: 'session-id' }, acpStrategy: { kind: 'none' },
    capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: true, replyCorrelation: 'none' } },
    buildArgs: (_prompt, args) => [...args],
    buildResumeArgs: (id, _path, prompt, args) => [...args, 'resume', id, ...(prompt ? [prompt] : [])], hook: { rules: [] } })
}

if (process.argv[2] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(await readFile(process.argv[2], 'utf8')), core = await import(config.entry)
  const store = new core.AgentMuxFileAgentSessionStore(config.storePath)
  const client = new core.AgentMuxClient({ store, providers: [continuityExecutorProvider(core, config.defaultProgram)] })
  Object.defineProperty(client.hookServer, 'port', { value: 0 })
  const starts = [], start = client.kernel.start.bind(client.kernel)
  client.kernel.start = async spec => { starts.push({ program: spec.program, args: spec.args, sentinel: spec.env.SDK_RECOVERY_SENTINEL ?? null }); return await start(spec) }
  try {
    await client.connect()
    const result = config.action === 'continue' ? await client.controlAgentContinuity(config.request) : await client.ensureAgentContinuity(config.request)
    let observed
    for (let n = 0; n < 500; n++) {
      const current = await store.readMetadata(config.request.agentSessionId)
      if (current.run.runId !== config.request.expectedRun.runId) {
        const run = (await client.listRuns()).find(value => value.runId === current.run.runId)
        if (run?.state === 'running') {
          for (const kind of ['catalog', 'sdk', 'owner']) {
            try {
              const witness = JSON.parse(await readFile(config.root + '/' + kind + '-' + run.pid + '.json', 'utf8'))
              if (witness.pid === run.pid) { observed = { session: client.agentSession(current.agentSessionId), witness, starts }; break }
            } catch {}
          }
        }
      }
      if (observed) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    if (!observed) throw new Error('The exact next Native process did not publish its witness.')
    process.stdout.write(JSON.stringify({ result, ...observed }) + '\n')
  } finally { await client.dispose() }
}
