import { fixturePath as _hygiene_fixturePath } from "../../scripts/lib/fixture-values.mjs"
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentMuxClient, type AgentMuxSessionQuestionReplyInput } from '../../../../packages/core/dist/client.js';
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../../../../packages/core/dist/agent-session-store.js';
import { agentPromptCondition } from '../../../../packages/core/dist/agent-prompt-condition.js';
import { codexQuestionRequest } from '../../../../packages/core/dist/providers/codex-question.js';
import { AgentTerminalScreen } from '../../../../packages/core/dist/agent-terminal-screen.js';
import type { AgentMuxAgentSessionRegistry } from '../../../../packages/core/dist/agent-session-registry.js';
import type { CtxmuxAdapterRun } from '../../../../packages/core/dist/ctxmux-run-adapter.js';
import type { AgentScreenEvidenceStore } from '../../../../packages/core/dist/screen-evidence.js';
import type { AgentMuxAgentSession } from '../../../../packages/core/dist/types.js';
export const source = {
  providerId: 'codex',
  nativeSessionId: 'question-native-source'
};
export const nativeQuestion = {
  type: 'agentMessage',
  id: 'native-async-call',
  phase: 'final_answer',
  delivery: 'async',
  text: 'Exact original question summary',
  questions: [{
    title: 'Choose a direction\n保留正文',
    options: ['Keep original', 'Revise']
  }, {
    title: 'Free text answer'
  }]
};
export const request = codexQuestionRequest(nativeQuestion)!;
const answers = [{
  questionId: request.questions[0]!.id,
  answer: 'Keep original'
}];
export const raw = '<send_user_message_question_reply>\n' + JSON.stringify(answers.map(answer => ({
  answer: answer.answer, question: request.questions[0]!.prompt.replace(/\r?\n/g, ' '), questionItemId: answer.questionId
}))) + '\n</send_user_message_question_reply>';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(closes.splice(0).map(close => close()));
});
type NativeRequest = {
  method: string;
  params: Record<string, unknown>;
};
export async function fixture(mode = 'normal') {
  const directory = await mkdtemp(_hygiene_fixturePath("tmp/amux-question-test-"));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const callsPath = join(directory, 'calls.jsonl'),
    script = join(directory, 'native.mjs');
  const entries = [{
    turnId: 'question-turn',
    item: {
      type: 'userMessage',
      id: 'before-question',
      content: [{
        type: 'text',
        text: 'before'
      }]
    }
  }, {
    turnId: 'question-turn',
    item: mode === 'malformed-options' ? {
      ...nativeQuestion,
      questions: [{
        title: 'Original invalid options',
        options: ['Keep', 4]
      }]
    } : mode === 'malformed-title' ? {
      ...nativeQuestion,
      questions: [{
        title: '',
        options: ['Keep']
      }]
    } : mode === 'malformed-questions' ? {
      ...nativeQuestion,
      questions: 'not-a-question-array'
    } : nativeQuestion
  }, ...(mode === 'unanswered' ? [] : [{
    turnId: 'answer-turn',
    item: {
      type: 'userMessage',
      id: 'exact-answer-record',
      content: [{
        type: 'text',
        text: raw
      }]
    }
  }])];
  await writeFile(script, `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const entries=${JSON.stringify(entries)}, mode=${JSON.stringify(mode)}
createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);appendFileSync(${JSON.stringify(callsPath)},JSON.stringify(request)+'\\n')
 if(request.id===undefined)return
 let result
 if(request.method==='initialize')result={userAgent:'controlled-question-owner'}
 else if(request.method==='thread/read')result={thread:{id:${JSON.stringify(source.nativeSessionId)},historyMode:'paginated'}}
 else if(request.method==='thread/items/list'){
  if(request.params.turnId){
   if(request.params.sortDirection==='desc')result={data:[entries[0]],nextCursor:null}
   else result={data:[mode==='wrong-record'?{...entries[1],item:{...entries[1].item,id:'another-real-question'}}:entries[1]],nextCursor:null}
  }else result={data:entries.slice().reverse(),nextCursor:null}
 }
 if(mode==='delayed'&&request.method==='thread/items/list'&&request.params.sortDirection==='asc'){
  writeFileSync(${JSON.stringify(join(directory, 'ready'))},'ready')
  const timer=setInterval(()=>{if(existsSync(${JSON.stringify(join(directory, 'release'))})){clearInterval(timer);process.stdout.write(JSON.stringify({id:request.id,result})+'\\n')}},5)
 }else process.stdout.write(JSON.stringify({id:request.id,result})+'\\n')
})`);
  const store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json'));
  await store.compareAndSwap(null, {
    kind: 'agent',
    agentSessionId: 'question-session',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: workspace,
    run: {
      runId: 'question-run'
    },
    retiredRuns: [],
    hookBindingId: 'question-binding',
    hookToken: 'question-token',
    createdAt: 1,
    updatedAt: 1,
    nativeHandle: {
      kind: 'provider',
      providerId: 'codex',
      sessionId: source.nativeSessionId
    },
    semanticStatus: {
      state: 'done',
      source: 'native-hook',
      observedAt: 1,
      stateEnteredAt: 1
    }
  });
  const client = new AgentMuxClient({
    store
  });
  type Internals = {
    connected: boolean;
    registry: AgentMuxAgentSessionRegistry;
    screenEvidence: AgentScreenEvidenceStore;
    serializeAgentInput<T>(session: AgentMuxAgentSession, operation: (session: AgentMuxAgentSession, run: CtxmuxAdapterRun) => Promise<T>, observation?: AbortController): Promise<T>;
    kernel: {
      isConnected(): boolean;
      identity(): {
        daemonInstanceId: string;
      };
      status(runId: string): Promise<CtxmuxAdapterRun>;
      input(runId: string, input: {
        operationId: string;
        expectedByte: number;
        data: string | Uint8Array;
      }): Promise<{
        run: CtxmuxAdapterRun;
        appliedByteRange: {
          startByte: number;
          endByte: number;
        };
      }>;
    };
  };
  const inner = client as unknown as Internals;
  await inner.registry.load('local');
  inner.connected = true;
  inner.kernel.isConnected = () => true;
  inner.kernel.identity = () => ({
    daemonInstanceId: 'question-private-daemon'
  });
  let cursor = 0;
  const run = (runId: string): CtxmuxAdapterRun => ({
    nativeService: null,
    runId,
    lifecycleOperationId: null,
    program: 'codex',
    args: [],
    workspacePath: workspace,
    pid: 42,
    state: {
      type: 'running'
    },
    cols: 120,
    rows: 40,
    latestOutputBytes: 0,
    firstAvailableByte: 0,
    acceptedInputBytes: cursor
  });
  inner.kernel.status = async id => run(id);
  const writes: Array<{
    runId: string;
    data: string | Uint8Array;
  }> = [];
  const accepted = new Map<string, {
    run: CtxmuxAdapterRun;
    appliedByteRange: {
      startByte: number;
      endByte: number;
    };
  }>();
  inner.kernel.input = async (runId, input) => {
    const prior = accepted.get(input.operationId);
    if (prior) return prior;
    writes.push({
      runId,
      data: input.data
    });
    cursor = input.expectedByte + Buffer.byteLength(input.data);
    const receipt = {
      run: run(runId),
      appliedByteRange: {
        startByte: input.expectedByte,
        endByte: cursor
      }
    };
    accepted.set(input.operationId, receipt);
    return receipt;
  };
  const screen = new AgentTerminalScreen(120, 40);
  if (mode === 'expanded' || mode === 'expanded-second') {
    const dataBytes = Buffer.from(mode === 'expanded-second' ? '\u001b[32;1H2 of 2\u001b[40;1Henter submit   ctrl+] skip   shift+→ prev question' : '\u001b[40;1Henter submit   ctrl+] skip   shift+→ main prompt');
    await screen.write({
      startByte: 0,
      endByte: dataBytes.byteLength,
      dataBytes
    });
  }
  vi.spyOn(inner.screenEvidence, 'wait').mockImplementation(async (_session, _byte, _after, predicate) => {
    predicate(screen);
    return 1;
  });
  closes.push(async () => {
    screen.dispose();
  });
  closes.push(async () => {
    await client.dispose();
    await rm(directory, {
      recursive: true,
      force: true
    });
  });
  const invocation = {
    commandOverride: process.execPath,
    args: [script]
  };
  const input: AgentMuxSessionQuestionReplyInput = {
    ...agentPromptCondition(client.agentSession('question-session')),
    ...invocation,
    agentSessionId: 'question-session',
    source,
    turnId: 'question-turn',
    recordId: nativeQuestion.id,
    answers,
    operationId: 'question-reply-operation',
    authorHuman: true,
    sourceDevice: {
      hostId: 'local',
      deviceId: 'device-private',
      name: 'Private device'
    }
  };
  return {
    client,
    store,
    inner,
    writes,
    input,
    directory,
    invocation,
    beginWorking: async () => {
      await client.submitAgentPrompt({ ...agentPromptCondition(client.agentSession('question-session')), agentSessionId: 'question-session', operationId: 'original-active-turn', prompt: 'Original active request' });
      const previous = (await loadAgentSessions(store))[0]!;
      await store.compareAndSwap(previous, { ...previous, updatedAt: previous.updatedAt + 1, semanticStatus: { state: 'working', source: 'native-hook', observedAt: previous.updatedAt + 1, stateEnteredAt: previous.updatedAt + 1 } });
      await inner.registry.load('local');
      return agentPromptCondition(client.agentSession('question-session'));
    },
    waitNative: async () => {
      await vi.waitFor(async () => expect(await readFile(join(directory, 'ready'), 'utf8')).toBe('ready'), {
        timeout: 5000,
        interval: 5
      });
    },
    releaseNative: async () => {
      await writeFile(join(directory, 'release'), 'release');
    },
    calls: async (): Promise<NativeRequest[]> => (await readFile(callsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
    alias: async (agentSessionId: string) => {
      const previous = (await loadAgentSessions(store))[0]!;
      const reservation = {
        kind: 'stop' as const,
        reservationId: 'alias-retire',
        ownerId: 'private-owner',
        ownerPid: process.pid,
        agentSessionId: previous.agentSessionId,
        expectedRun: previous.run,
        operationId: 'alias-retire-operation',
        expiresAt: Date.now() + 60000,
        stopOperation: {
          daemonInstance: 'private-unconnected',
          operationKey: 'alias-stop',
          runId: previous.run.runId
        }
      };
      await store.reserveLifecycle(reservation);
      await store.commitLifecycle(reservation, null);
      await store.compareAndSwap(null, {
        ...previous,
        agentSessionId,
        run: {
          runId: 'alias-run'
        },
        hookBindingId: 'alias-binding',
        hookToken: 'alias-token',
        updatedAt: previous.updatedAt + 1
      });
      await inner.registry.load('local');
      return await client.sessionHistoryPage(agentSessionId, invocation);
    },
    replace: async (newSource = 'new-native', newRun = 'question-run') => {
      const previous = (await loadAgentSessions(store))[0]!;
      await store.compareAndSwap(previous, {
        ...previous,
        nativeHandle: {
          kind: 'provider',
          providerId: 'codex',
          sessionId: newSource
        },
        run: {
          runId: newRun
        },
        updatedAt: previous.updatedAt + 1
      });
      await inner.registry.load('local');
    }
  };
}
