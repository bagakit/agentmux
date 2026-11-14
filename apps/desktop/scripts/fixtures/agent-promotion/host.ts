import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { ScratchTopics } from '@agentmux/host/mote-resources'
import { AgentMuxControlServer, AgentMuxSpatialStateStore } from '@agentmux/core'
import { createHostContent } from '@agentmux/host/content-owner'
import { join } from 'node:path'
import { createHostMoteMainReader } from '../../../../host/src/mote-dialogue.js'
import { HostMoteQuickPreferences } from '../../../../host/src/mote-quick-preferences.js'
import { spatialCatalog } from '@agentmux/core'
import { access, readFile } from 'node:fs/promises'
const root = process.argv[2]!
// Inject finite filesystem/semantic-writer faults; application source keeps its original methods.
const originalLink = fs.promises.link
fs.promises.link = async (from, to) => {
  if (String(to).endsWith('.complete')) {
    let fault = false; try { await access(join(root, 'fail-completion')); fault = true } catch {}
    if (fault) throw Object.assign(new Error('Injected completion publication disk failure.'), { code: 'EIO' })
  }
  return originalLink(from, to)
}
const originalOpen = fs.promises.open
fs.promises.open = async (...args: Parameters<typeof originalOpen>) => {
  const file = await originalOpen(...args)
  if (String(args[0]).endsWith('.complete')) {
    const originalSync = file.sync.bind(file)
    file.sync = async () => {
      let fault = false; try { await access(join(root, 'fail-completion-sync')); fault = true } catch {}
      if (fault) throw Object.assign(new Error('Injected completion marker fsync failure after link.'), { code: 'EIO' })
      return originalSync()
    }
  }
  return file
}
syncBuiltinESMExports()
const prepare = ScratchTopics.prototype.prepareMotePromotion
ScratchTopics.prototype.prepareMotePromotion = async function(workspace, topicId) {
  let fault = false; try { await access(join(root, 'fail-personality')); fault = true } catch {}
  if (fault) throw Object.assign(new Error('Injected original personality sync owner failure.'), { code: 'EIO' })
  return prepare.call(this, workspace, topicId)
}
const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json')), commit = spatial.commit.bind(spatial)
spatial.commit = async input => {
  if (input.graph.spaces.some(space => space.kind === 'mote')) {
    let fail = false; try { await access(join(root, 'fail-spatial')); fail = true } catch {}
    if (fail) throw Object.assign(new Error('Injected spatial interruption after durable content.'), { code: 'SPATIAL_STATE_CONFLICT' })
  }
  return commit(input)
}
let server: AgentMuxControlServer
const content = createHostContent({ configurationPath: join(root, 'config.json'), spatial })
const sessions = JSON.parse(await readFile(join(root, 'agents.json'), 'utf8'))
// The retained record supplies frozen execution facts. Only current metadata for preference choices is a leaf; original Files, Core RPC, CLI, spatial owner and restart are production code.
const client = { readAgentSessions: async () => sessions, readAgentSession: async (id: string) => sessions.find((s: { agentSessionId: string }) => s.agentSessionId === id), agentSessions: () => sessions, agentSession: (id: string) => sessions.find((session: { agentSessionId: string }) => session.agentSessionId === id),
  statusAgent: async (id: string) => ({ session: sessions.find((session: { agentSessionId: string }) => session.agentSessionId === id), capabilities: {}, observation: { process: 'running', semantic: 'idle', readiness: 'ready', source: 'native-hook', observedAt: Date.now(), stale: false } }) }
const main = createHostMoteMainReader({ configurationPath: join(root, 'config.json'), spatial, files: content.files! })
const moteQuickPreferences = new HostMoteQuickPreferences({ main, files: content.files!, catalog: async () => { const state = await spatial.read(); return state ? spatialCatalog(state.graph) : null }, executors: async () => [] })
server = new AgentMuxControlServer({ socketPath: join(root, 'rpc.sock'), spatialState: spatial, moteQuickPreferences, coreClients: () => [{ hostId: 'local', client: client as never }], ...content })
await server.start(); process.stdout.write('READY\n')
process.once('SIGTERM', () => { void server.stop().then(() => process.exit(0)) })
