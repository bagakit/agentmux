import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { selfProcessIdentity } from './process.mjs'
const [path, receipt, credentials, coreRoot] = process.argv.slice(2)
const { nativeProcessBirth } = await import(pathToFileURL(join(coreRoot, 'dist/agent-native-process.js')).href)
await writeFile(receipt, JSON.stringify({ processId: process.pid, processIdentity: { pid: process.pid } }) + '\n', { mode: 0o600 })
await writeFile(receipt, JSON.stringify({ processId: process.pid, processIdentity: await selfProcessIdentity(nativeProcessBirth), agentSessionId: process.env.AGENTMUX_AGENT_SESSION_ID }) + '\n', { mode: 0o600 })
if (credentials) await writeFile(credentials, JSON.stringify({ capability: process.env.AGENTMUX_AGENT_CAPABILITY, agentSessionId: process.env.AGENTMUX_AGENT_SESSION_ID }), { mode: 0o600 })
process.stdin.setRawMode?.(true)
let writes = Promise.resolve()
process.stdin.on('data', bytes => { writes = writes.then(() => appendFile(path, bytes, { mode: 0o600 })) })
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await writes; process.exit(0) })
setInterval(() => {}, 1000)
