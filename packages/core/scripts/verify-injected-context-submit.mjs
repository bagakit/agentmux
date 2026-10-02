import { runA2aProof } from './lib/a2a-proof.mjs'

await runA2aProof({
  name: 'injected-context-submit-proof',
  tests: ['packages/core/test/agent-injected-context-submit.test.ts', 'packages/core/test/agent-injected-context-resume.test.ts'],
  regressionTests: ['packages/core/test/client-submit-prompt-run-binding.test.ts', 'packages/core/test/cancelled-turn-prompt-admission.test.ts',
    'apps/desktop/test/task-region-restart.test.ts', 'apps/desktop/test/first-execution-agent-restore.test.ts', 'apps/desktop/test/first-execution-ipc.test.ts'],
  sourceInputs: ['packages/core/src/client.ts', 'packages/core/src/types.ts', 'packages/core/src/prompt-submission.ts',
    'packages/core/src/agent-session-store.ts', 'packages/core/src/agent-outbound-message.ts', 'packages/core/src/agent-provider.ts',
    'packages/core/src/hosted-client.ts', 'packages/core/src/hosted-runtime-service.ts',
    'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/ipc.ts',
    'apps/desktop/src/preload/index.ts', 'apps/desktop/src/shared/contracts.ts',
    'packages/core/scripts/verify-injected-context-submit.mjs', 'packages/core/scripts/lib/a2a-proof.mjs'],
  environment: ({ url }) => ({ AGENTMUX_TEST_INJECTED_CONTEXT_CLIENT: url('client.js') }),
  callers: [
    { symbol: 'client.submitAgentPrompt', path: 'apps/desktop/src/main/runtime-controller.ts' },
    { symbol: 'runtime.submitPrompt', path: 'apps/desktop/src/main/ipc.ts' },
    { symbol: 'sessions:submitPrompt', path: 'apps/desktop/src/preload/index.ts' },
    { symbol: 'this.client[invocation.method]', path: 'packages/core/src/hosted-runtime-service.ts' }
  ],
  mutations: [
    { label: 'native-resume-body-trimmed', file: 'agent-provider.js', before: 'const resumePrompt = context.prompt?.trim() ? context.prompt : undefined;', after: 'const resumePrompt = context.prompt?.trim() || undefined;' },
    { label: 'message-provenance-not-frozen', file: 'prompt-submission.js', before: 'message: structuredClone(message)', after: 'message: undefined' },
    { label: 'same-wire-provenance-conflict-ignored', file: 'prompt-submission.js',
      before: 'promptMessageIdentity(previous.intent.message) !== promptMessageIdentity(message)', after: 'false' },
    { label: 'unknown-source-misreported-as-conflict', file: 'prompt-submission.js',
      before: 'previous.intent.message === undefined && message !== undefined', after: 'false' },
    { label: 'user-content-promoted-by-timeline', file: 'client.js',
      before: "if (message.systemContext)\n            await this.recordMessageAfterSideEffect(session, `system-context:${operationId}`, 'AgentMux context', message.systemContext, now, 'agentmux', { status });",
      after: "if (message.systemContext || message.userContent)\n            await this.recordMessageAfterSideEffect(session, `system-context:${operationId}`, 'AgentMux context', message.systemContext || message.userContent, now, 'agentmux', { status });" },
    { label: 'preload-platform-context-disconnected', file: '../../apps/desktop/src/preload/index.ts',
      projectTests: ['apps/desktop/test/first-execution-ipc.test.ts'],
      before: "ipcRenderer.invoke('sessions:submitPrompt', session, prompt, operationId, condition, choice, authorHuman, agentMuxNote)",
      after: "ipcRenderer.invoke('sessions:submitPrompt', session, prompt, operationId, condition, choice, authorHuman, undefined)" },
    { label: 'foreign-platform-context-trusted', file: '../../apps/desktop/src/main/ipc.ts',
      projectTests: ['apps/desktop/test/first-execution-ipc.test.ts'],
      before: '    if (agentMuxNote !== undefined) assertManualPromptSenderTrusted(event.sender, args.window.webContents)\n    if (authorHuman === true)',
      after: '    if (authorHuman === true)' }
  ]
})
