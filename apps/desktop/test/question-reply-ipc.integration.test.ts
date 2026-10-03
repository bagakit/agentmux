// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { assertManualPromptSenderTrusted } from '../src/main/ipc-sender-trust';
import type { AgentMuxPreloadApi, AgentSessionControl, SessionQuestionReplyInput } from '../src/shared/contracts';
const transport = vi.hoisted(() => ({
  invoke: vi.fn(),
  exposed: undefined as unknown
}));
vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: transport.invoke,
    on: vi.fn(),
    removeListener: vi.fn()
  },
  contextBridge: {
    exposeInMainWorld: (_name: string, value: unknown) => {
      transport.exposed = value;
    }
  },
  webFrame: {
    setZoomFactor: vi.fn()
  }
}));
afterEach(() => {
  vi.restoreAllMocks();
  transport.invoke.mockReset();
  vi.resetModules();
});
const control: AgentSessionControl = {
  kind: 'agent',
  hostId: 'local',
  agentSessionId: 'actual-target',
  run: {
    runId: 'actual-run'
  }
};
const input: SessionQuestionReplyInput = {
  source: {
    providerId: 'codex',
    nativeSessionId: 'opaque-source'
  },
  turnId: 'original-turn',
  recordId: 'original-record',
  answers: [{
    questionId: 'opaque-question-id',
    answer: '原始答案'
  }],
  operationId: 'actual-operation',
  expectedRun: {
    runId: 'actual-run'
  },
  afterSubmissionId: null
};
/** Execute the exact new registration expression with its actual trust function. Unrelated Electron owners are not started. */
function registeredReply(trusted: object) {
  const path = resolve(process.cwd(), 'apps/desktop/src/main/ipc.ts'),
    source = readFileSync(path, 'utf8');
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  let expression: ts.CallExpression | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'handleWithEvent' && ts.isStringLiteral(node.arguments[0]!) && node.arguments[0]!.text === 'sessions:replyQuestion') expression = node;
    ts.forEachChild(node, visit);
  }
  visit(tree);
  expect(expression, 'actual registered Main question capability').toBeDefined();
  const code = source.slice(expression!.getStart(tree), expression!.getEnd());
  const compiled = ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None
    }
  }).outputText;
  let handler: ((event: {
    sender: object;
  }, control: AgentSessionControl, input: SessionQuestionReplyInput) => Promise<unknown>) | undefined;
  const runtime = {
      replyQuestion: vi.fn().mockResolvedValue({
        outcome: 'submitted'
      })
    },
    pause = vi.fn(),
    config = {
      test: 'unchanged config'
    };
  new Function('handleWithEvent', 'args', 'config', 'assertManualPromptSenderTrusted', 'pauseUserProgress', compiled)((_channel: string, fn: typeof handler) => {
    handler = fn;
  }, {
    window: {
      webContents: trusted
    },
    runtime
  }, config, assertManualPromptSenderTrusted, pause);
  expect(handler).toBeDefined();
  return {
    handler: handler!,
    runtime,
    pause,
    config
  };
}
it('exact Main question registration forwards only after original trusted sender validation', async () => {
  const trusted = {},
    h = registeredReply(trusted);
  await expect(h.handler({
    sender: trusted
  }, control, input)).resolves.toEqual({
    outcome: 'submitted'
  });
  expect(h.runtime.replyQuestion).toHaveBeenCalledExactlyOnceWith(control, input, h.config);
  expect(h.pause).toHaveBeenCalledExactlyOnceWith(control, 'Paused for your question reply.');
});
it('an untrusted sender cannot reply or pause healthy progress through the new handler', async () => {
  const h = registeredReply({});
  await expect(h.handler({
    sender: {}
  }, control, input)).rejects.toThrow('Untrusted');
  expect(h.runtime.replyQuestion).not.toHaveBeenCalled();
  expect(h.pause).not.toHaveBeenCalled();
});
it('actual preload capability preserves control, opaque question identity and native receipt through its one registered channel', async () => {
  transport.invoke.mockResolvedValue({
    outcome: 'submitted'
  });
  const descriptor = Object.getOwnPropertyDescriptor(process, 'contextIsolated');
  Object.defineProperty(process, 'contextIsolated', {
    value: true,
    configurable: true
  });
  try {
    await import('../src/preload/index');
    const api = transport.exposed as AgentMuxPreloadApi;
    await expect(api.sessions.replyQuestion(control, input)).resolves.toEqual({
      outcome: 'submitted'
    });
    expect(transport.invoke).toHaveBeenCalledExactlyOnceWith('sessions:replyQuestion', control, input);
  } finally {
    if (descriptor) Object.defineProperty(process, 'contextIsolated', descriptor);else Reflect.deleteProperty(process, 'contextIsolated');
  }
});
