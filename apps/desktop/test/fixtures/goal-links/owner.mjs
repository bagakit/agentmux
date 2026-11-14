import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startHeadlessAgentMux } from '@agentmux/core'
import { createHostGoals } from '../../../../host/src/goals.ts'
const state = process.env.AGENTMUX_STATE_DIRECTORY
let scope = 'original'
try { scope = await readFile(join(state, 'goal-scope'), 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
if (!['original', 'other'].includes(scope)) throw Error('The private fixture requires an exact Goal scope')
const root = join(state, scope)
await mkdir(root, { recursive: true })
const configurationPath = join(root, 'configuration.json')
await writeFile(configurationPath, JSON.stringify({ version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private device' }], executors: {}, workspaces: [], goals: {} }))
let runtime
const goals = createHostGoals({ configurationPath, projects: async () => [], runtime: () => runtime,
  coreCall: (_host, method, params, context) => runtime.server.callRpc(method, params, context) })
runtime = await startHeadlessAgentMux({ providers: [], socketPath: join(process.env.AGENTMUX_RUNTIME_DIRECTORY, 'headless.sock'),
  service: { goalControl: goals.execute, goalChanges: goals.goalChanges, goalDelegations: goals.goalDelegations, goalParticipation: goals.participation } })
process.stdout.write(JSON.stringify({ owner: runtime.ownerIdentity(), socketPath: runtime.socketPath }) + '\n')
process.once('SIGTERM', () => { void (async () => { await writeFile(join(state, 'goal-list-proof.json'), JSON.stringify({ scope, items: await goals.list() })); await goals.dispose(); await runtime.stop() })() })
process.once('SIGINT', () => { void goals.dispose().then(() => runtime.stop()) })
