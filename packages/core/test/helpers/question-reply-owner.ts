import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { expect, vi } from 'vitest'
import type { AgentProvider, AgentProviderPreparedNativeInput } from '../../src/agent-provider.js'
import type { AgentMuxSessionQuestionReplyInput } from '../../src/client.js'
import { prepareCodexNativeInput } from '../../src/providers/codex-native-input.js'
import { agentPromptCondition } from '../../src/agent-prompt-condition.js'
import { AgentMuxFileAgentSessionStore } from '../../src/agent-session-store.js'
import { rpcOwnerFixture } from './public-rpc-owner.js'
import { savedQuestionSource as source, savedQuestionTurn, savedQuestionId,
  savedQuestionEvent, savedQuestionJsonl } from './codex-saved-question.js'

/** Real Provider exact-record reader and codec; only Runtime process status is a port. */
export async function questionReplyOwner(options: { nativeProtocol?: boolean; outcome?: 'admitted' | 'unknown' | 'not-applied'; ownerModule?: Parameters<typeof rpcOwnerFixture>[1] } = {}) {
  const f = await rpcOwnerFixture(['question-session'], options.ownerModule, root => ({
    nativeHandle: { kind: 'provider', providerId: source.providerId, sessionId: source.nativeSessionId, transcriptPath: join(root, 'native.jsonl') } }))
  const header = savedQuestionJsonl([{ type: 'session_meta', payload: { id: source.nativeSessionId, cwd: f.root } }])
  await writeFile(join(f.root, 'native.jsonl'), header + savedQuestionJsonl([savedQuestionEvent()]))
  const actor = { protocolId: 'codex-app-server-v2-0.163', actorId: 'original-actor', lifecycleOperationId: 'original-lifecycle', token: 'a'.repeat(64), launch: { command: 'codex', args: [] } }
  const original = (await f.store.readMetadata('question-session'))!
  await f.store.compareAndSwap(original, { ...original, nativeActor: actor }); await f.inner.registry.load('local')
  const input: AgentMuxSessionQuestionReplyInput = { ...agentPromptCondition(f.client.agentSession('question-session')),
    agentSessionId: 'question-session', source, turnId: savedQuestionTurn, recordId: `codex-record:${Buffer.byteLength(header)}`,
    answers: [{ questionId: savedQuestionId, answer: 'Keep the original work', prompt: 'Untrusted caller display' }], operationId: 'original-question-reply' }
  const key = { kind: 'prompt' as const, agentSessionId: input.agentSessionId, expectedRun: input.expectedRun, submissionId: input.operationId }
  const send = vi.fn<AgentProviderPreparedNativeInput['send']>(async (_prompt, plan) => {
    const persisted = await new AgentMuxFileAgentSessionStore(f.store.path).readPromptAdmission(input.agentSessionId, input.expectedRun, input.operationId)
    expect(persisted?.admission?.intent?.plan).toEqual(plan)
    expect(persisted?.admission?.inputKey).toEqual(key)
    expect(persisted?.admission?.intent?.message?.questionReply).toEqual({ source, turnId: input.turnId, recordId: input.recordId, questionIds: input.answers.map(answer => answer.questionId) })
    expect(persisted?.admission?.intent?.admissionIntent).toEqual({ kind: 'exact-condition', condition: { expectedRun: input.expectedRun, afterSubmissionId: input.afterSubmissionId } })
    if (options.outcome === 'unknown') throw new Error('Native acknowledgement unavailable after dispatch')
    if (options.outcome === 'not-applied') return { outcome: 'not-applied', errorCode: -32602 }
    return { outcome: 'admitted', turnId: 'reply-native-turn' }
  })
  let pid = 1234, stop = async () => {}
  const requests = async (): Promise<Array<{ method: string; params?: Record<string, any> }>> => options.nativeProtocol
    ? (await readFile(join(f.root, 'requests.ndjson'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  if (options.nativeProtocol) {
    f.client.providers.get('codex').prepareNativeInput = prepareCodexNativeInput
    const script = join(f.root, 'native-actor.cjs')
    await writeFile(script, `const {WebSocketServer}=require(process.argv[2]);const {appendFileSync}=require('node:fs');
const source=JSON.parse(process.argv[3]),log=process.argv[4],token=process.argv[5];
const server=new WebSocketServer({port:0,host:'127.0.0.1'});
server.on('listening',()=>process.stdout.write('ready\\n'));
server.on('connection',(ws,req)=>{if(req.headers.authorization!=='Bearer '+token){ws.close();return}
ws.on('message',bytes=>{const request=JSON.parse(String(bytes));appendFileSync(log,JSON.stringify(request)+'\\n');
if(!Object.hasOwn(request,'id'))return;
let result={};if(request.method==='thread/read')result={thread:{id:source.nativeSessionId,canAcceptDirectInput:true}};
if(request.method==='turn/start')result={turn:{id:'reply-native-turn'}};
ws.send(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));});});`)
    const child = spawn(process.execPath, [script, createRequire(import.meta.url).resolve('ws'), JSON.stringify(source), join(f.root, 'requests.ndjson'), actor.token], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    await once(child.stdout, 'data'); pid = child.pid!
    stop = async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'close'); child.kill('SIGTERM'); await exited } }
  } else {
    const provider = f.client.providers.get('codex') as AgentProvider
    provider.prepareNativeInput = vi.fn(async (context, selected) => {
      expect(context.nativeActor).toEqual(actor)
      expect(selected).toEqual(source)
      return { plan: { kind: 'native-rpc', protocolId: actor.protocolId, sourceId: JSON.stringify([source.providerId, source.nativeSessionId]),
        actorId: actor.actorId, threadId: source.nativeSessionId, operation: 'start-or-steer' }, assertCurrent: vi.fn(async () => {}), send, dispose: vi.fn() }
    })
  }
  f.inner.kernel.status = vi.fn(async (runId: string) => ({ ...f.run(runId), pid }))
  const originalClose = f.close
  return { ...f, input, key, send, requests, actor, async close() { await stop(); await originalClose() } }
}
