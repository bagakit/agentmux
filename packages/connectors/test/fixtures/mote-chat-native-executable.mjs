import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import { AgentProviderRegistry } from '../../../core/src/index.ts'
import { spawnClaudeNativeInputProducer } from '../../../core/test/helpers/claude-native-input-producer.ts'

const root = await mkdtemp('/tmp/amx-mote-native-run-'), id = 'native-' + process.env.AGENTMUX_AGENT_SESSION_ID
const source = join(root, 'config', 'projects', 'project', id + '.jsonl')
const child = spawnClaudeNativeInputProducer({ root, id, socketPath: join(root, 'input.sock'), sourcePath: source, workspace: process.cwd(), adoptInput: true, detached: false })
child.stderr.on('data', bytes => process.stderr.write(bytes))
child.on('message', value => { if (value?.frame?.type === 'user') process.stdout.write('Original native user frame retained\n') })
const [ready] = await once(child, 'message')
if (!ready.ready) throw Error('Original native producer did not start')
const handshake = new AgentProviderRegistry().get('claude').terminalHandshake
if (handshake) process.stdout.write(handshake.query)
process.stdin.resume()
child.once('exit', async code => { await rm(root, { recursive: true, force: true }); process.exit(code ?? 1) })
const stop = () => { if (child.connected) child.disconnect() }
process.once('SIGTERM', stop); process.once('SIGINT', stop)
