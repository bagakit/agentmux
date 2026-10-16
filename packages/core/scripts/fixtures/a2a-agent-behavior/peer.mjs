import { appendFile, writeFile } from 'node:fs/promises'
const [path, receipt, credentials] = process.argv.slice(2)
await writeFile(receipt, JSON.stringify({ processId: process.pid, agentSessionId: process.env.AGENTMUX_AGENT_SESSION_ID }) + '\n', { mode: 0o600 })
if (credentials) await writeFile(credentials, JSON.stringify({ capability: process.env.AGENTMUX_AGENT_CAPABILITY, agentSessionId: process.env.AGENTMUX_AGENT_SESSION_ID }), { mode: 0o600 })
process.stdin.setRawMode?.(true)
let writes = Promise.resolve()
process.stdin.on('data', bytes => { writes = writes.then(() => appendFile(path, bytes, { mode: 0o600 })) })
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await writes; process.exit(0) })
setInterval(() => {}, 1000)
