import { runA2aProof } from './lib/a2a-proof.mjs'

await runA2aProof({
  name: 'a2a-message-delivery-proof',
  tests: ['packages/core/test/client-agent-message-delivery.test.ts', 'packages/core/test/ctxmux-run-adapter-decoder-seam.test.ts'],
  regressionTests: ['apps/desktop/test/task-region-restart.test.ts', 'apps/desktop/test/first-execution-agent-restore.test.ts', 'apps/desktop/test/first-execution-ipc.test.ts'],
  sourceInputs: ['packages/core/src/client.ts', 'packages/core/src/agent-provider.ts', 'packages/core/src/agent-global-message-queue.ts',
    'packages/core/src/ctxmux-run-adapter.ts', 'packages/core/src/agent-message-render.ts', 'packages/core/src/agent-session-id.ts',
    'packages/core/scripts/verify-a2a-message-delivery.mjs', 'packages/core/scripts/lib/a2a-proof.mjs'],
  environment: ({ url }) => ({ AGENTMUX_TEST_A2A_CLIENT: url('client.js'), AGENTMUX_TEST_A2A_ADAPTER: url('ctxmux-run-adapter.js') }),
  callers: [
    { symbol: 'submitAgentMessage', path: 'apps/desktop/src/main/runtime-controller.ts' },
    { symbol: 'runtime.submitMessage', path: 'apps/desktop/src/main/ipc.ts' },
    { symbol: 'api.sessions.submitMessage', path: 'apps/desktop/src/renderer/src/store.ts' },
    { symbol: 'sessions:submitMessage', path: 'apps/desktop/src/preload/index.ts' },
    { symbol: 'initialMessage', path: 'apps/desktop/src/renderer/src/lib/space-agent-control.ts' },
    { symbol: 'authorizeAgentCaller', path: 'packages/core/src/agentmux.ts' }
  ],
  mutations: [
    { label: 'sender-authority-disconnected', file: 'client.js', before: 'await this.authorizeAgentMessage({ capability:', after: 'if (false) await this.authorizeAgentMessage({ capability:' },
    { label: 'actual-send-source-disconnected', file: 'client.js', before: 'prompt: renderAgentMuxMessageEnvelope(envelope)', after: 'prompt: envelope.body' },
    { label: 'actual-initial-source-disconnected', file: 'client.js', before: 'const originalPrompt = initialEnvelope ? renderAgentMuxMessageEnvelope(initialEnvelope) : input.prompt;', after: 'const originalPrompt = input.prompt;' },
    { label: 'durable-intent-before-input-disconnected', file: 'client.js',
      before: "const queued = await this.messageQueue.append(envelope);\n        if (['delivered', 'accepted', 'replied'].includes(queued.delivery.state))\n            return;\n        if (queued.delivery.state !== 'queued')\n            throw new AgentMuxError('This message has a final delivery outcome.', 'AGENT_DELIVERY_STATE_INVALID');\n        const originalCondition = await this.messageQueue.preparePrompt(envelope.messageId, async () => condition);",
      after: 'const originalCondition = condition;' },
    { label: 'current-authority-replaced-by-cache', file: 'client.js',
      before: "const session = (await loadAgentSessions(this.store)).find((candidate) => candidate.agentSessionId === agentSessionId && candidate.hostId === 'local');",
      after: 'const session = this.registry.get(agentSessionId);' },
    { label: 'uncertain-first-input-falsely-confirmed', file: 'client.js', before: "const promptConfirmed = existing.creation.initialPrompt === 'confirmed';", after: 'const promptConfirmed = true;' },
    { label: 'original-first-run-backfilled-after-resume', file: 'client.js', before: 'if (!originalCreation)', after: 'if (false)' },
    { label: 'human-launch-bytes-trimmed', file: 'agent-provider.js', before: "const prompt = context.prompt.trim() ? context.prompt : '';", after: 'const prompt = context.prompt.trim();' },
    { label: 'first-dispatch-run-condition-disconnected', file: 'agent-global-message-queue.js',
      before: 'message.envelope.recipientRunId === null && message.promptCondition', after: 'false' },
    { label: 'unsupported-event-fabricates-exit', file: 'ctxmux-run-adapter.js', before: 'if (event.type !== "exited" && event.type !== "interrupted")', after: 'if (false)' },
    { label: 'unauthorized-message-pauses-healthy-progress', file: '../../apps/desktop/src/main/ipc.ts',
      projectTests: ['apps/desktop/test/first-execution-ipc.test.ts'],
      before: "    await args.runtime.submitMessage(session, message)\n    pauseUserProgress(session, 'Paused for your message.')",
      after: "    pauseUserProgress(session, 'Paused for your message.')\n    await args.runtime.submitMessage(session, message)" }
  ]
})
