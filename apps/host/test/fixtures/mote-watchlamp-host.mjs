import { access, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
const state = dirname(process.env.AGENTMUX_AGENT_SESSION_STORE), path = join(state, 'continuous-progress-loops.json')
try { await access(path) } catch (error) {
  if (error.code !== 'ENOENT') throw error
  // Seed old durable records only before the first original Host start. Restart never replays them.
  const original = { hostId:'local',agentSessionId:'legacy-original-session',providerId:'codex',workspacePath:state,intervalMs:1000,everyMs:60000,prompt:'Original retained private work',nextCheckAt:Date.now()+600000,revision:1,creationOperationId:'legacy-original-operation' }
  await writeFile(path, JSON.stringify([
    { ...original, loopId:'legacy-paused',futureIntentId:'legacy-original-intent',status:'paused',lastDecision:'Paused by you. Input unconfirmed',lastTickAt:1,lastOutcome:'unknown' },
    { ...original, loopId:'pending-recovered',creationOperationId:'recovered-original-create',futureIntentId:'recovered-original-intent',status:'active',pendingCompletion:{id:'original-completion',operationId:'original-pending-input',prompt:'Frozen original body'},lastTickId:'original-tick',lastTickAt:2 }
  ]))
}
await import('./mobile-web-host.mjs')
