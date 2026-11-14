import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

export const initializationMutations = {
  'cold-semantic-drop': ['packages/core/src/client.ts', [
    ['if (!isRestorableLocalPromptInput(saved.intent)) continue', "if (!isRestorableLocalPromptInput(saved.intent) || saved.intent.admissionIntent.kind !== 'manual-actor') continue"]]],
  'cold-index-omit': ['packages/core/src/agent-message-journal.ts', [
    ["IN ('manual-actor', 'session-conversation')", "IN ('manual-actor')"]]],
  'stage-manual': ['packages/core/src/public-rpc-service.ts', [
    ["admissionIntent:{kind:'session-conversation'},execution:'immediate'}},context)", "admissionIntent:{kind:'manual-actor'},execution:'immediate'}},context)"]]],
  'startup-bypass': ['packages/core/src/client.ts', [
    ['if (!this.nativeSessionStarting(session, intent)) return null', 'if (true) return null']]],
  'lost-wake': ['packages/core/src/client.ts', [
    ["return { phase: 'service', reason: 'observation-failed', wake: 'session-restored', failure,\n      observation: { phase: 'native-initialization' } }", "return { phase: 'service', reason: 'observation-failed', wake: 'explicit-rejoin', failure,\n      observation: { phase: 'native-initialization' } }"]]],
  'continue-bypass': ['packages/core/src/client.ts', [
    ['const initializationWait = this.nativeSessionStarting(current, saved.intent.admissionIntent) && await', 'const initializationWait = !context.continueGate && this.nativeSessionStarting(current, saved.intent.admissionIntent) && await']]],
  'manual-gate': ['packages/core/src/client.ts', [
    ['if (!this.nativeSessionStarting(session, intent)) return null', 'if (false) return null'],
    ['if (!this.nativeSessionStarting(current, intent)) return null', 'if (false) return null'],
    ['const initializationWait = this.nativeSessionStarting(current, saved.intent.admissionIntent) && await', 'const initializationWait = await']]],
  'current-environment': ['packages/core/src/providers/grok-input-initialization.ts', [
    ["const env = Object.fromEntries(Object.entries(context.env).filter((entry): entry is [string, string] => entry[1] !== undefined))", 'const env = { ...process.env, ...context.env, HOME: process.env.HOME, GROK_HOME: process.env.GROK_HOME }']]],
  'history-start-veto': ['packages/core/src/client.ts', [
    ["sameRun(session.nativeSourceObservation.run, session.run) && session.nativeSourceObservation.state !== 'unknown'", 'sameRun(session.nativeSourceObservation.run, session.run)']]],
  'history-native-veto': ['packages/core/src/prompt-submission.ts', [
    ['hasCurrentNativeMainBinding(current) ||\n                control?.onlyIfUnclaimed', 'control?.onlyIfUnclaimed']]],
  'old-route-rebuild': ['packages/core/src/public-rpc-service.ts', [
    ["if(prior.route||!advance||result.binding!=='confirmed') return prior", "if(!advance||result.binding!=='confirmed') return prior"]]],
  'diagnostic-hang': ['packages/core/src/client.ts', [
    ['!this.nativeSessionStarting(event.session, intent))) diagnostic.abort(new AgentMuxError(', '!this.nativeSessionStarting(event.session, intent))) void (new AgentMuxError(']]]
}
const observed = new Set(['packages/core/src/client.ts', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/agent-provider.ts',
  'packages/core/src/agent-input-wait.ts', 'packages/core/src/agent-message-journal.ts', 'packages/core/src/agent-global-message-queue.ts',
  'packages/core/src/providers/index.ts', 'packages/core/src/providers/grok-input-initialization.ts',
  'packages/core/src/agent-native-source.ts', 'packages/core/src/prompt-submission.ts', 'packages/core/src/client-event-publisher.ts',
  'packages/core/test/platform-initialization-input.test.ts', 'packages/core/test/native-history-input-continuity.test.ts',
  'packages/core/test/platform-initialization-diagnostic-lifetime.test.ts', 'apps/host/test/mote-existing-platform-input.test.ts',
  'apps/host/test/helpers/mote-conversation-start-fixture.ts'])
export function instrumentInitialization(source, path, consumer) {
  const name = process.env.MOTE_INITIALIZATION_MUTANT
  if (name && !Object.hasOwn(initializationMutations, name)) throw Error('Unknown initialization mutation ' + name)
  const mutation = initializationMutations[name]
  let loaded = source
  if (mutation?.[0] === path) for (const [before, after] of mutation[1]) {
    if (loaded.split(before).length !== 2) throw Error('Expected one initialization mutation anchor: ' + name)
    loaded = loaded.replace(before, after)
  }
  if (process.env.MOTE_INITIALIZATION_LOADED && observed.has(path)) {
    const hash = value => createHash('sha256').update(value).digest('hex')
    appendFileSync(process.env.MOTE_INITIALIZATION_LOADED, JSON.stringify({ path, consumer, sourceSHA256: hash(source), loadedSHA256: hash(loaded),
      ...(loaded === source ? {} : { mutation: name }) }) + '\n')
  }
  return loaded
}
