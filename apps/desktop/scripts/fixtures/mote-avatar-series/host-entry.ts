import { startAgentMuxHost, agentMuxHostStore } from '../../../../host/src/host.js'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const directory = process.argv[2]!
const host = await startAgentMuxHost({ store: agentMuxHostStore(join(directory, 'sessions.json')), providers: [], mobilePort: 0 })
await writeFile(join(directory, 'host-ready.json'), JSON.stringify({ pid: process.pid, socket: host.server.path }))
process.on('SIGTERM', () => { void host.dispose().then(() => process.exit(0)) })
