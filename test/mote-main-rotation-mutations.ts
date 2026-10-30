import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
export const mainRotationVariants: Record<string, { file: string; before: string; after: string; test: string }> = {
  'setup-source-evidence': { file:'packages/core/src/mote-main-setup.ts', before:"observed = {kind:'source',operationId:saved.operationId,file:saved.file,reference:saved.reference,roleRevision:saved.roleRevision}", after:"observed = {kind:'preferences',source:{resource:saved.file.resource,documentRevision:saved.file.revision,defaults:expected}}", test:'original source evidence after a later Main' },
  'setup-retention-truth': { file:'packages/core/src/public-rpc-service.ts', before:'The original preference result is retained; Main admission retention is unconfirmed: ', after:'The original save succeeded independently of admission retention: ', test:'unknown or refused native preference results' },
  'setup-admission-route': { file:'packages/core/src/public-rpc-service.ts', before:'scope.hostId === input.creation.hostId', after:'scope.hostId === input.target.expectedResource.hostId', test:'routes the original admission Host independently' },
  'setup-resource-route': { file:'packages/core/src/public-rpc-service.ts', before:'const hostId = input.target.expectedResource.hostId', after:"const hostId = 'local'", test:'a separate resource protocol Host' },
  'setup-inspect-mutates': { file:'packages/core/src/mote-main-setup.ts', before:'if (advance) { await ports.assertCurrent(); result.record = await ports.spatial.observeMoteMainBinding(record.requestId,observed) }', after:'if (true) { await ports.assertCurrent(); result.record = await ports.spatial.observeMoteMainBinding(record.requestId,observed) }', test:'a native File result remains confirmed' },
  'setup-loses-native-ack': { file:'packages/core/src/mote-main-setup.ts', before:'result.bindingReceipt = retainedMoteMainBindingReceipt(record,saved)', after:'result.bindingReceipt = null', test:'a native File result remains confirmed' },
  'setup-managed-caller': { file:'packages/core/src/public-rpc-service.ts', before:"if (caller || context.caller !== undefined || !context.principal || !['user','device'].includes(context.principal.kind))", after:"if (false && (caller || context.caller !== undefined || !context.principal || !['user','device'].includes(context.principal.kind)))", test:'public setup refuses managed callers' },
  'setup-cli-save-settlement': { file:'packages/core/src/public-rpc-service.ts', before:'try { await this.spatial.recordMoteMainBindingResult(input,parsed) }', after:'try { /* Mutant drops ordinary writer publication. */ }', test:'independent actual CLI preferences save settles' },
  'initial-mote-admission': { file: 'packages/core/src/spatial-agent-open.ts',
    before: 'if (pending && pending.requestId !== input.request.requestId)', after: 'if (false && pending && pending.requestId !== input.request.requestId)', test: 'another client with no pointer' },
  'stale-mounted-baseline': { file: 'apps/desktop/src/renderer/src/components/MoteMainActions.tsx',
    before: 'if (lifetime.current === token) setReading(fresh)', after: 'if (false) setReading(fresh)', test: 'same mounted component can rotate' },
  'late-navigation': { file: 'apps/desktop/src/renderer/src/components/MoteMainActions.tsx',
    before: 'activity.current === activityAtStart && ', after: '', test: 'later human reading or input' },
  'desktop-live-spatial': { file: 'apps/desktop/src/renderer/src/store.ts',
    before: 'const offRemote=spatial.connect(apply, applyNameAcknowledgement)', after: 'const offRemote=spatial.connect(()=>{}, applyNameAcknowledgement)', test: 'original Desktop spatial and Session subscriptions' },
  'desktop-live-session': { file: 'apps/desktop/src/main/runtime-controller.ts',
    before: 'client.send(SESSION_EVENT_CHANNEL, runtimeEvent)', after: 'if (false) client.send(SESSION_EVENT_CHANNEL, runtimeEvent)', test: 'original Desktop spatial and Session subscriptions' },
  'agent-cannot-reserve': { file: 'packages/core/src/public-rpc-service.ts',
    before: "if (request.operation === 'agent.open' && request.moteMain) {", after: "if (false && request.operation === 'agent.open' && request.moteMain) {", test: 'actual CLI and public schema retain' },
  'default-fallback': { file: 'apps/desktop/src/renderer/src/lib/mote-main-action.ts',
    before: 'const configured = preferences.defaults?.executorId', after: 'const configured = preferences.defaults?.executorId ?? preferences.choices.executors[0]?.id',
    test: 'requires the MOTE configured default' },
  'inspect-replays-create': { file: 'packages/core/src/public-rpc-service.ts',
    before: "reconcileMoteMainSetup(input,method === 'space.mote.dialogue.setup.advance',", after: 'reconcileMoteMainSetup(input,true,',
    test: 'lost original creation reply' },
  'skip-earlier-source': { file: 'packages/core/src/mote-main-setup.ts', before: '    if (old) {', after: '    if (false && old) {',
    test: 'unknown old-source ACK' },
  'stale-cas-overwrite': { file: 'apps/host/src/mote-quick-preferences.ts',
    before: 'if (!isDeepStrictEqual(read.source.resource, baseline.resource) || document?.revision !== baseline.document?.revision || document?.content !== baseline.document?.content || !sameMoteQuickDefaults(read.defaults, baseline.defaults))',
    after: 'if (false)', test: 'later role generation wins CAS' },
  'double-stage-claim': { file: 'packages/core/src/spatial-state.ts',
    before: "if (!input.receipt && record.moteMainFollowUps?.[key]) return { record, claimed: false }",
    after: "if (!input.receipt && record.moteMainFollowUps?.[key]) return { record, claimed: true }", test: 'two original clients share one atomic' },
  'optimistic-binding': { file: 'packages/core/src/mote-main-setup.ts',
    before: "result.binding = saved.status === 'saved' || saved.status === 'unchanged' ? 'confirmed'", after: "result.binding = true ? 'confirmed'", test: 'explicit unknown File write remains unconfirmed' },
  'wrong-host-admission': { file: 'packages/core/src/spatial-agent-open.ts',
    before: 'intent.target.expectedResource.hostId !== input.execution.hostId ||', after: 'false ||', test: 'actual CLI and public schema retain' },
  'cli-drops-original': { file: 'packages/core/src/agentmux-cli-commands.ts',
    before: '...(moteMain ? { moteMain } : {}), content: fork ?', after: '...{}, content: fork ?', test: 'actual CLI and public schema retain' },
  'lost-durable-reference': { file: 'apps/desktop/src/renderer/src/store.ts',
    before: '    moteMainCreationReferences: state.moteMainCreationReferences,', after: '    moteMainCreationReferences: {},', test: 'lost original creation reply' }
}
export function mainRotationMutation() {
  const name = process.env.AGENTMUX_MAIN_ROTATION_MUTANT, change = name && mainRotationVariants[name]
  if (name && !change) throw new Error('Unknown Main rotation mutant')
  return { name: 'loaded-main-rotation-mutant', enforce: 'pre' as const, transform(code: string, id: string) {
    const file = id.split('?')[0]!
    if (!change || !file.endsWith('/' + change.file)) return
    if (code.split(change.before).length !== 2) throw new Error('Main mutation anchor changed: ' + name)
    const output = code.replace(change.before, change.after), trace = process.env.AGENTMUX_MAIN_ROTATION_TRACE
    if (!trace) throw new Error('Actual loaded Source trace is required')
    const sha = (s: string) => createHash('sha256').update(s).digest('hex')
    appendFileSync(trace, JSON.stringify({ mutant: name, file, before: sha(code), after: sha(output), count: 1 }) + '\n')
    return { code: output, map: null }
  } }
}
