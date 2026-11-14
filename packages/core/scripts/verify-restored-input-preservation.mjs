#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim()
const evidence = resolve(process.env.AGENTMUX_RESTORED_INPUT_EVIDENCE ?? join(dirname(common), '.local/reliability-fixes/core/restored-inputs'),
  new Date().toISOString().replaceAll(/[:.]/gu, '-') + '-' + process.pid)
await mkdir(evidence, { recursive: true, mode: 0o700 })
const digest = value => createHash('sha256').update(value).digest('hex')
const queuePath = 'packages/core/src/agent-global-message-queue.ts', journalPath = 'packages/core/src/agent-message-journal.ts'
const sourcePaths = ['packages/core/src/agent-message-envelope.ts','packages/core/src/agent-message-notifications.ts','packages/core/src/agent-message-route.ts','packages/core/src/agent-message-broadcast.ts',queuePath, journalPath, 'packages/core/src/storage-recovery.ts', 'packages/core/src/session-input-restoration.ts', 'packages/core/src/agent-input-epoch.ts', 'packages/core/src/agent-session-database.ts', 'packages/core/src/agent-session-registry.ts', 'packages/core/src/public-rpc.ts', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/rpc-native-codec.ts', 'packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/hosted-client-contract.ts',
  'packages/core/src/agent-session-store.ts', 'packages/core/src/agent-prompt-condition.ts', 'packages/core/src/client.ts', 'packages/core/src/client-contract.ts', 'packages/core/src/agent-input-submit.ts', 'packages/core/src/types.ts', 'packages/core/src/prompt-submission.ts',
  'packages/core/test/queue-restoration-publication.test.ts', 'packages/core/test/restored-input-preservation.test.ts', 'packages/core/test/agent-global-message-queue.test.ts',
  'packages/core/test/helpers/prompt-receipt-process.ts', 'packages/core/test/helpers/prompt-receipt-reader.mjs', 'packages/core/test/helpers/prompt-receipt-source-loader.mjs',
  'packages/core/test/vitest.restored-input-preservation.config.mts', 'packages/core/test/tsconfig.restored-input-preservation.json',
  'packages/core/scripts/verify-restored-input-preservation.mjs']
const sources = new Map(await Promise.all(sourcePaths.map(async path => [path, await readFile(join(root, path), 'utf8')])))
const receipt = { kind: 'agentmux.restored-input-preservation.v1', root, startedAt: new Date().toISOString(),
  scope: 'Original Session/Queue owners prepare isolated snapshots; real Client consumers, controlled Native bytes, cold SDK/UnixRPC/source CLI and Queue reader. No production namespace or real Native connection.',
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceHashes: Object.fromEntries([...sources].map(([path, source]) => [path, digest(source)])), tests: [], mutations: [] }
async function save(name, value) { const path = join(evidence, name); await writeFile(path, value, { mode: 0o600 }); await chmod(path, 0o600); return path }
async function run(label, args, overrides = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(AGENTMUX_|CTXMUX_)/u.test(name)))
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }) })
  })
  await save(label + '.log', result.output); return result
}
async function tests(label, pattern) {
  const results = join(evidence, label + '.private.json'), loads = await save(label + '-loads.private.ndjson', '')
  const result = await run(label, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'packages/core/test/vitest.restored-input-preservation.config.mts',
    '--reporter=json', '--outputFile', results, ...(pattern ? ['-t', pattern] : [])],
  { AGENTMUX_RECEIPT_SOURCE_LOADS: loads, AGENTMUX_TEST_RECEIPT_SOURCE_LOADS: loads })
  await chmod(results, 0o600)
  const parsed = JSON.parse(await readFile(results, 'utf8'))
  const failures = parsed.testResults.flatMap(suite => suite.assertionResults ?? []).filter(assertion => assertion.status === 'failed')
  const loaded = (await readFile(loads, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  for (const item of loaded) {
    if (!item.path.startsWith(join(root, 'packages/core/src/')) || digest(await readFile(item.path)) !== item.sha256) throw Error('Loaded Core source changed or escaped the candidate: ' + item.path)
  }
  const required = pattern ? [queuePath, journalPath] : [queuePath, journalPath, 'packages/core/src/session-input-restoration.ts', 'packages/core/src/agent-input-epoch.ts', 'packages/core/src/agent-session-database.ts', 'packages/core/src/agent-session-registry.ts', 'packages/core/src/public-rpc.ts', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/rpc-native-codec.ts', 'packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/hosted-client-contract.ts', 'packages/core/src/agent-session-store.ts', 'packages/core/src/agent-prompt-condition.ts', 'packages/core/src/client.ts', 'packages/core/src/agentmux.ts']
  for (const path of required) if (!loaded.some(item => item.path === join(root, path))) throw Error('Actual owner was not consumed: ' + path)
  return { code: result.code, total: parsed.numTotalTests, passed: parsed.numPassedTests, failed: parsed.numFailedTests,
    runtimeErrors: parsed.numRuntimeErrorTestSuites ?? 0, failures: failures.map(value => ({ name: value.fullName, messages: value.failureMessages })),
    results, loads }
}
function green(result) { if (result.code !== 0 || result.total !== 45 || result.passed !== 45 || result.failed !== 0 || result.runtimeErrors) throw Error('Message source gate was not a nonempty 45/45 pass: ' + JSON.stringify(result)) }
function replace(source, from, to) { if (source.split(from).length !== 2) throw Error('Mutation anchor changed: ' + from); return source.replace(from, to) }
const epochPath='packages/core/src/agent-prompt-condition.ts', restorePath='packages/core/src/session-input-restoration.ts'
const mutations = [
  {id:'namespace-gap-blocks-healthy-metadata',path:'packages/core/src/agent-session-store.ts',pattern:'v3 input namespace keeps',edit:s=>replace(s,"if(createsInput)throw new AgentMuxError('The original input namespace is unconfirmed.","if(true)throw new AgentMuxError('The original input namespace is unconfirmed.")},
  {id:'namespace-gap-blocks-lifecycle-observation',path:'packages/core/src/agent-session-registry.ts',pattern:'v3 input namespace keeps',edit:s=>replace(s,'        const previous=await this.store.readMetadata(reservation.agentSessionId)','        await this.store.readInputEpoch()\n        const previous=await this.store.readMetadata(reservation.agentSessionId)')},
  {id:'future-uses-only-session-epoch',path:'packages/core/src/agent-session-store.ts',pattern:'v3 input namespace keeps',edit:s=>replace(s,'try{namespace=readInputNamespace(db)}catch{throw', 'try{namespace={}}catch{throw')},
  {id:'mutable-live-shares-candidate-inode',path:journalPath,pattern:'cold-process retry',edit:s=>replace(s,'try{await link(publication,path);', 'try{await link(member.file,path);')},
  {id:'invalidate-original-legacy-route',path:'packages/core/src/public-rpc-service.ts',pattern:'original pre-epoch remote route',edit:s=>replace(s,'threadId, correlationId, replyTo, ...(p.recipientInputEpoch===undefined?{}:{recipientInputEpoch:p.recipientInputEpoch}),','threadId, correlationId, replyTo, recipientInputEpoch:p.recipientInputEpoch??null,')},
  {id:'visible-cut-false-durable-ack',path:'packages/core/src/agent-session-store.ts',pattern:'original durability ACK',edit:s=>replace(s,'if(current.inputEpoch===namespace.inputEpoch){this.dirty=true;result=','if(current.inputEpoch===namespace.inputEpoch){result=')},
  {id:'old-journal-reader-accepted',path:queuePath,pattern:'restored v2',edit:s=>replace(s,"this.db.exec('PRAGMA user_version=2')","void 0 /* old reader still accepts held journal */")},
  {id:'publish-unheld-candidate',path:journalPath,pattern:'plain unheld backup',edit:s=>replace(s,"if(!hold||hold.operationId!==member.operationId||hold.sourceSHA256!==member.originalSHA256||candidate.prepare('SELECT MAX(sequence) AS n FROM records').get()?.n!==hold.sequence||Number(candidate.prepare('PRAGMA user_version').get()?.user_version)!==2)","if(false)")},
  {id:'publish-without-original-mutex',path:journalPath,pattern:'active lawful writer',edit:s=>replace(s,"mutex.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')","mutex.exec('PRAGMA busy_timeout=0')")},
  {id:'forget-frozen-peer-epoch',path:'packages/core/src/agent-message-envelope.ts',pattern:'two signed peers',edit:s=>replace(s,"...(source.recipientInputEpoch===undefined?{}:{recipientInputEpoch:optionalInputEpoch(source.recipientInputEpoch).inputEpoch}),","/* regression: recipient cut lost before signing */")},
  {id:'freshen-old-notify-request',path:'packages/core/src/client.ts',pattern:'two signed peers|actual Unix RPC',edit:s=>replace(s,'      assertAgentInputEpoch(session,input)\n      notification =','      /* regression: old notify gets new condition */\n      notification =')},
  {id:'accept-peer-from-prior-cut',path:queuePath,pattern:'two signed peers',edit:s=>s.replaceAll("AND (SELECT json_extract(r.json,'$.envelope.recipientInputEpoch') FROM records r WHERE r.sequence=a2a_message_notifications.message_sequence) IS ?","AND (? IS NULL OR 1=1)").replace("if(!input.messageIds && (original.input_epoch??undefined)!==condition.inputEpoch)this.refuseRestoredInput()","void 0 /* old reference requalifies */")},
  {id:'rollback-current-input-cut',path:'packages/core/src/agent-input-epoch.ts',pattern:'original live Store',edit:s=>replace(s,"if(current.inputEpoch!==value.inputEpoch) throw","if(false) throw")},
  {id:'rehold-later-independent-input',path:'packages/core/src/agent-session-store.ts',pattern:'original live Store',edit:s=>replace(s,'if(current.inputEpoch===namespace.inputEpoch){this.dirty=true;result=', 'if(false){this.dirty=true;result=')},
  {id:'missing-namespace-write',path:restorePath,pattern:'reads a restored namespace',edit:s=>replace(s,'writeInputNamespace(db,namespace)','void 0 /* regression: no original namespace cut */')},
  {id:'legacy-reader-can-write',path:restorePath,pattern:'stages the full',edit:s=>replace(s,"db.exec('PRAGMA user_version=3')","void 0 /* regression: old binary still accepts restored control data */")},
  {id:'forget-namespace-format',path:'packages/core/src/agent-input-epoch.ts',pattern:'reads a restored namespace',edit:s=>replace(s,"if(!marked && !present && Number(db.prepare('PRAGMA user_version').get()?.user_version)<3)return {}","if(!marked && !present)return {}")},
  {id:'forget-memory-lifecycle-cut',path:'packages/core/src/agent-session-store.ts',pattern:'Memory lifecycle commits',edit:s=>replace(s,'ordinaryInputEpoch(epochOwner, {','ordinaryInputEpoch(undefined, {')},
  {id:'lost-input-epoch',path:restorePath,pattern:'stages the full|cut-external old Client',edit:s=>replace(s,'next={...raw,...namespace}','next={...raw}')},
  {id:'drop-frozen-epoch',path:epochPath,pattern:'freezes epoch',edit:s=>replace(s,'return { expectedRun: { ...session.run }, afterSubmissionId, ...optionalInputEpoch(session.inputEpoch) }','return { expectedRun: { ...session.run }, afterSubmissionId }')},
  {id:'accept-earlier-cut',path:epochPath,pattern:'cut-external old Client',edit:s=>replace(s,'if (session.inputEpoch !== binding.inputEpoch)','if (false)')},
  {id:'restart-prepared-initial',path:restorePath,pattern:'initial/future recipes',edit:s=>replace(s,"next.initialInput={...next.initialInput,state:'unknown'}","void 0 /* regression: prepared initial remains live */")},
  {id:'reactivate-old-future',path:restorePath,pattern:'initial/future recipes',edit:s=>replace(s,'JSON.stringify({...intent,active:false})','JSON.stringify({...intent,active:true})')},
  {id:'continue-held-gate',path:queuePath,pattern:'actual Client cold waiting|holds original journal',edit:s=>replace(s,'if (this.inputRestorationHeld(ref.key)) this.refuseRestoredInput()','void 0 /* regression: old dispatch gate resumes */')},
  {id:'forget-journal-hold',path:queuePath,pattern:'actual Client cold waiting|holds original journal',edit:s=>replace(s,"await this.appendRecord({kind:'restored-input-hold',sequence:this.nextSequence,operationId,throughSequence,sourceSHA256,sourceMutexSHA256})","void 0 /* regression: candidate has no durable original hold */")}
]
const asset = join(root, 'packages/core/dist/agent-global-message-queue.js')
let previousAsset
try { previousAsset = await readFile(asset) } catch (error) { if (error.code !== 'ENOENT') throw error }
try {
  await mkdir(dirname(asset), { recursive: true })
  // Existing cross-process regressions import their package entry. This explicit
  // test-only bridge binds that entry to this worktree's source, with no build.
  await writeFile(asset, "import {register} from 'node:module';register(new URL('../test/helpers/prompt-receipt-source-loader.mjs',import.meta.url),import.meta.url);const {DurableAgentMuxMessageQueue}=await import('../src/agent-global-message-queue.ts');export {DurableAgentMuxMessageQueue};\n", { mode: 0o600 })
  const types = await run('types', ['node_modules/typescript/bin/tsc', '--project', 'packages/core/test/tsconfig.restored-input-preservation.json', '--pretty', 'false'])
  if (types.code !== 0) throw Error('Narrow restored-input type check failed.')
  const baseline = await tests('baseline'); green(baseline); receipt.tests.push(baseline); console.log('baseline: 45/45 source-bound restored-input and Queue regression tests passed')
  for (const mutation of mutations) {
    const path = join(root, mutation.path), original = sources.get(mutation.path)
    if (await readFile(path, 'utf8') !== original) throw Error('Candidate changed before mutation: ' + path)
    try {
      const modified = mutation.edit(original); await writeFile(path, modified)
      const result = await tests('mutation-' + mutation.id, mutation.pattern)
      if (result.code === 0 || result.failed < 1 || result.runtimeErrors || !result.failures.length ||
        result.failures.some(value => !value.messages.some(message => /AssertionError|expected |promise resolved|promise rejected .*instead of resolving/isu.test(message)))) throw Error('No business assertion rejected mutation: ' + mutation.id)
      receipt.mutations.push({ id: mutation.id, mutantSHA256: digest(modified), ...result }); console.log('mutation ' + mutation.id + ': business assertion rejected')
    } finally { await writeFile(path, original) }
  }
  const restored = await tests('restored'); green(restored); receipt.tests.push(restored)
  for (const [path, source] of sources) if (await readFile(join(root, path), 'utf8') !== source) throw Error('Source was not restored: ' + path)
  receipt.verdict = 'pass'; console.log('restored: 45/45; ' + mutations.length + '/' + mutations.length + ' causal mutations rejected')
} catch (error) { receipt.verdict = 'fail'; receipt.failure = error.stack ?? String(error); process.exitCode = 1; console.error(receipt.failure) }
finally {
  for (const path of [queuePath, journalPath,epochPath,restorePath,'packages/core/src/agent-input-epoch.ts','packages/core/src/agent-session-store.ts','packages/core/src/agent-message-envelope.ts','packages/core/src/client.ts','packages/core/src/public-rpc-service.ts','packages/core/src/agent-session-registry.ts']) if (await readFile(join(root, path), 'utf8') !== sources.get(path)) await writeFile(join(root, path), sources.get(path))
  if (previousAsset) await writeFile(asset, previousAsset); else await rm(asset, { force: true })
  receipt.endedAt = new Date().toISOString()
  console.log('evidence: ' + await save('verification.private.json', JSON.stringify(receipt, null, 2) + '\n'))
}
