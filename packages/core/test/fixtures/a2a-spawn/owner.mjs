import { join } from 'node:path'

// Runs only against the verifier's fresh compiled candidate. The controlled Provider
// is a real PTY process; it records launch identity and echoes raw input without a model.
const entry = process.env.AGENTMUX_TEST_COLLABORATION_CORE
const root = process.env.AGENTMUX_SPAWN_FIXTURE_ROOT
if (!entry || !root) throw new Error('A fresh Core candidate and private fixture namespace are required.')
const core = await import(entry)
const program = `const fs=require('node:fs'),path=require('node:path');
const sid=process.env.AGENTMUX_AGENT_SESSION_ID;
fs.writeFileSync(path.join(${JSON.stringify(root)},sid+'.json'),JSON.stringify({agentSessionId:sid,capability:process.env.AGENTMUX_AGENT_CAPABILITY,pid:process.pid,prompt:process.argv[1]}),{mode:0o600,flag:'wx'});
process.stdin.setRawMode(true);process.stdin.on('data',d=>process.stdout.write('INPUT:'+d.toString()));console.log('ACTOR-READY');setInterval(()=>{if(!fs.existsSync(${JSON.stringify(root)}))process.exit(0)},1000)`
const provider = core.defineAgentProvider({ catalog: { id: 'spawn-process', label: 'Controlled spawn process',
  executable: process.execPath, expectedProcess: 'node', promptDelivery: 'positional-argv',
  readySignal: { kind: 'foreground-process', expectedProcess: 'node' }, hookStrategy: { kind: 'none' },
  resumeStrategy: { kind: 'none' }, acpStrategy: { kind: 'none' },
  capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: false, replyCorrelation: 'none' } },
  buildArgs: prompt => ['-e', program, prompt], hook: { rules: [] } })
const runtime = await core.startHeadlessAgentMux({ providers: [provider],
  store: new core.AgentMuxFileAgentSessionStore(process.env.AGENTMUX_AGENT_SESSION_STORE) })
await runtime.client.connect()
let stopping = false
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (stopping) return
  stopping = true
  void runtime.stop().then(() => process.exit(0), error => { console.error(error); process.exit(1) })
})
process.stdout.write(JSON.stringify({ processId: process.pid, socketPath: runtime.socketPath, owner: runtime.ownerIdentity() }) + '\n')
