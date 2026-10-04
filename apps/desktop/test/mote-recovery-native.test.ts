// @vitest-environment node
import { expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile, symlink, chmod, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture'

it('original public continuity keeps durable SID/native handle after private owner and native process restart, with one resumed Run', async () => {
  const repository = resolve(import.meta.dirname, '../../..')
  await mkdir(join(repository, 'packages/core/.tmp'), { recursive: true })
  const directory = await mkdtemp(join(repository, 'packages/core/.tmp/mote-recovery-native-'))
  const require = createRequire(join(repository, 'apps/desktop/package.json'))
  const { build } = createRequire(require.resolve('vite'))('esbuild')
  await mkdir(join(directory, 'compiled')); await symlink(join(repository, 'packages/core/vendor'), join(directory, 'vendor'))
  const entry = join(directory, 'compiled/owner.mjs'), out = process.env.MOTE_RECOVERY_NATIVE_RECEIPT
  const old = process.env.AGENTMUX_TEST_OWNER_ENTRY
  let scope: Awaited<ReturnType<typeof headlessFixture>> | undefined
  try {
    await build({ entryPoints: [join(repository, 'packages/core/test/fixtures/headless-runtime-worker.mjs')], outfile: entry,
      bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'error',
      plugins: [{ name: 'exact-original-core-source', setup(plugin) { plugin.onResolve({ filter: /^\.\.\/\.\.\/dist\/index\.js$/ }, () => ({ path: join(repository, 'packages/core/src/index.ts') })) } }] })
    process.env.AGENTMUX_TEST_OWNER_ENTRY = entry
    scope = await headlessFixture()
    const client = await scope.client(), command = join(scope.root, 'native-fixture.mjs')
    // The existing fixture CLI predates process-witness admission. Hold an actual
    // private main record open, so the original Provider discovers the real PID/FD.
    await writeFile(command, '#!/usr/bin/env node\n' + `import * as nativeFixtureFs from 'node:fs';import {join as nativeFixtureJoin} from 'node:path';
const nativeFixtureId='native-'+process.env.AGENTMUX_AGENT_SESSION_ID,nativeFixturePath=nativeFixtureJoin(process.env.AGENTMUX_STATE_DIRECTORY,'rollout-'+nativeFixtureId+'.jsonl');
if(!nativeFixtureFs.existsSync(nativeFixturePath))nativeFixtureFs.writeFileSync(nativeFixturePath,JSON.stringify({type:'session_meta',payload:{id:nativeFixtureId,source:'cli'}})+'\\n');nativeFixtureFs.openSync(nativeFixturePath,'a+');
const nativeFixtureTurn='private-fixture-turn-'+process.pid;let nativeFixtureOrdinal=nativeFixtureFs.readFileSync(nativeFixturePath,'utf8').trim().split('\\n').length;
` + (await readFile(join(repository, 'packages/core/test/fixtures/fake-codex-cli.mjs'), 'utf8')).replace(/^#!.*\n/, '').replace('const request = async (body) => {', `const request = async (body) => { if(body.eventName==='SessionStart'||body.eventName==='Stop')nativeFixtureFs.appendFileSync(nativeFixturePath,JSON.stringify({type:'event_msg',ordinal:++nativeFixtureOrdinal,timestamp:new Date().toISOString(),payload:{type:body.eventName==='SessionStart'?'task_started':'task_complete',thread_id:nativeFixtureId,turn_id:nativeFixtureTurn}})+'\\n'); body = {...body,payload:{...body.payload,hook_event_name:body.eventName,turn_id:nativeFixtureTurn}};`))
    await chmod(command, 0o700)
    const original = await client.createAgent({ providerId: 'codex', executorId: 'codex', workspacePath: scope.root,
      commandOverride: command, injectAgentMuxGuide: false, createOperationId: 'mote-original-private-create' })
    await client.reattachAgent(original.agentSessionId, 0, 'terminal')
    const native = await until(() => client.agentSession(original.agentSessionId), s => Boolean(s.nativeHandle) && s.semanticStatus?.state === 'done', 'original native identity and completed turn')
    const transcript = await readFile(native.nativeHandle!.kind === 'provider' ? native.nativeHandle!.transcriptPath! : '', 'utf8')
    const owner = client.runtimeOwnerIdentity()!
    await scope.restartNativeDaemon(); await scope.restart()
    await until(() => client.runtimeOwnerIdentity(), s => s.availability === 'connected' && s.ownerInstanceId !== owner.ownerInstanceId, 'reconnected private owner')
    const saved = await client.agentSession(original.agentSessionId)
    expect(saved.agentSessionId).toBe(original.agentSessionId); expect(saved.nativeHandle).toEqual(native.nativeHandle)
    const request = { agentSessionId: original.agentSessionId, expectedRun: original.run, commandOverride: command, env: {}, operationId: 'mote-private-native-continuity' }
    const results = await Promise.all([client.ensureAgentContinuity(request), client.ensureAgentContinuity(request)])
    const current = await client.agentSession(original.agentSessionId)
    if (out) await writeFile(out, JSON.stringify({ passed: false, phase: 'continuity-response', results, current }, null, 2))
    expect(results[0]?.kind).toBe('resumed')
    expect(results[1]).toMatchObject({ kind: 'conflict', reason: 'session-run-changed',
      agentSessionId: original.agentSessionId, previousRun: original.run, currentRun: current.run })
    expect((await readFile(current.nativeHandle!.kind === 'provider' ? current.nativeHandle!.transcriptPath! : '', 'utf8')).startsWith(transcript)).toBe(true)
    expect(current.nativeHandle).toEqual(native.nativeHandle); expect(current.agentSessionId).toBe(original.agentSessionId)
    expect((await client.listRuns()).filter(run => run.agentSessionId === original.agentSessionId && run.state === 'running')).toHaveLength(1)
    expect(current.run.runId).not.toBe(original.run.runId)
    if (out) await writeFile(out, JSON.stringify({ passed: true, boundary: 'Private original Core/Hosted/native ctxmux process restart and fixture CLI; no models/auth/live user Runs.', originalSid: original.agentSessionId, nativeHandle: native.nativeHandle, originalRun: original.run, resumedRun: current.run, ownerRestarted: true, nativeDaemonRestarted: true, calls: 2, originalContinuationOperationIds: 1, results: results.map(r => r.kind), runningRuns: 1, originalTranscriptPrefixRetained: true, duplicateOldRunReceipt: 'session-run-changed' }, null, 2))
  } finally {
    if (old === undefined) delete process.env.AGENTMUX_TEST_OWNER_ENTRY; else process.env.AGENTMUX_TEST_OWNER_ENTRY = old
    await scope?.cleanup(); await rm(directory, { recursive: true, force: true })
  }
}, 90_000)
