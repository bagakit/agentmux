import assert from 'node:assert/strict'
import { GUIDE_DOCUMENTS } from '../dist/generated/agentmux-guides-index.js'
import { join } from 'node:path'
import { runA2aProof } from './lib/a2a-proof.mjs'

// Verify the Progress producer first so its private Main/Core seam fails before
// the broader discovery and recovery mutation proof.
await import('../../../apps/desktop/scripts/verify-injected-context-progress.mjs')

// Mutate the exact compiled document consumed by the module, after build-time includes.
function documentMutation(id, before, after) {
  const original = GUIDE_DOCUMENTS[id]
  assert.equal(original.split(before).length, 2, 'Unique authored guide fragment: ' + id)
  return { file: 'generated/agentmux-guides.js',
    before: 'text: ' + JSON.stringify(original),
    after: 'text: ' + JSON.stringify(original.replace(before, after)) }
}

const discovery = ['packages/core/test/agent-messaging-guidance.test.ts']
const context = ['packages/core/test/agent-messaging-context.test.ts']
const continuity = ['packages/core/test/session-continuity-launch-input.test.ts']
const historical = ['packages/core/test/session-continuity-input.test.ts']
const local = ['packages/core/test/agentmux-cli-help.test.ts', 'packages/core/test/agentmux-cli-module-skills.test.ts', 'packages/core/test/agentmux-cli-global-discovery.test.ts']
await runA2aProof({
  name: 'agent-messaging-guidance-proof',
  tests: [...discovery, ...context, ...local],
  regressionTests: ['packages/core/test/agent-creation-delivery-fact.test.ts',
    'packages/core/test/agent-injected-context-resume.test.ts', ...continuity,
    'packages/core/test/durable-direct-resume.test.ts', 'packages/core/test/agent-outbound-message.test.ts', ...historical],
  sourceInputs: ['packages/core/src/agent-messaging-guidance.ts', 'packages/core/src/guide-text.ts', 'packages/core/src/generated/agentmux-guides.ts', 'packages/core/src/generated/agentmux-guides-index.ts', 'packages/core/guides/modules/message.md', 'packages/core/guides/shared/messaging/contract.md', 'packages/core/guides/shared/runtime.md', 'packages/core/guides/shared/spatial.md', 'packages/core/src/client.ts', 'packages/core/src/agent-session-recovery/service.ts', 'packages/core/src/agent-session-recovery/continuity-attempt.ts', 'packages/core/src/agent-session-recovery/lifecycle.ts', 'packages/core/src/agent-session-recovery/reconciliation.ts', 'packages/core/src/agent-session-recovery/ports.ts', 'packages/core/src/agentmux.ts',
    'packages/core/src/control-host.ts', 'packages/core/src/public-rpc-service.ts',
    'packages/core/src/agentmux-cli-help.ts', 'packages/core/src/agentmux-cli-module-skills.ts', 'packages/core/src/agentmux-cli-shared-guides.ts',
    'packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/agentmux-cli-browser-guide.ts',
    'apps/desktop/src/main/runtime-controller.ts', 'apps/host/src/continuous-progress-loop-manager.ts',
    'apps/desktop/scripts/verify-injected-context-progress.mjs',
    'packages/core/src/agent-outbound-message.ts', 'packages/core/src/agent-message-render.ts', 'packages/core/src/agent-session-recovery/input.ts',
    'packages/core/src/agent-session-recovery/continuity-contract.ts', 'packages/core/src/agent-session-recovery/continuity-policy.ts', 'packages/core/src/agent-session-recovery/supervisor.ts', 'packages/core/src/agent-session-store.ts',
    'packages/core/test/helpers/previous-core-wire.ts', 'packages/core/test/helpers/public-rpc-owner.ts',
    'packages/core/scripts/verify-agent-messaging-guidance.mjs', 'packages/core/scripts/lib/a2a-proof.mjs'],
  environment: ({ core, dist, url }) => ({ AGENTMUX_TEST_GUIDANCE_CORE: url('index.js'), AGENTMUX_TEST_GUIDANCE_RENDER: url('agent-message-render.js'),
    AGENTMUX_TEST_GUIDANCE_SERVER: url('control-host.js'),
    AGENTMUX_TEST_GUIDANCE_CLI: join(dist, 'agentmux.js'), AGENTMUX_TEST_OBJECT_CLI: join(dist, 'agentmux.js'),
    AGENTMUX_TEST_GUIDANCE_DAEMON: join(core, 'vendor/ctxmux/darwin-arm64/bin/ctxmuxd') }),
  callers: [
    { symbol: 'client.call(method, invocation.params', path: 'packages/core/src/agentmux.ts' },
    { symbol: 'AGENTMUX_AGENT_MESSAGING_ENTRY', path: 'packages/core/src/agent-outbound-message.ts' },
    { symbol: 'agentMuxCliModuleCatalog()', path: 'packages/core/src/agentmux-cli-help.ts' },
    { symbol: 'guide: guideText(definition.guide,', path: 'packages/core/src/agentmux-cli-module-skills.ts' },
    { symbol: 'AGENTMUX_A2A_REMINDER', path: 'packages/core/src/agent-message-render.ts' },
    { symbol: ': composeAgentLaunchPrompt(originalPrompt,', path: 'packages/core/src/client.ts' },
    { symbol: 'composeAgentResumePrompt(input.prompt, input.agentMuxNote)', path: "packages/core/src/agent-session-recovery/lifecycle.ts" },
    { symbol: 'prepareContinuityLaunchInput(receipt, catalog!', path: "packages/core/src/agent-session-recovery/continuity-attempt.ts" },
    { symbol: 'composeAgentResumePrompt(input.prompt, input.agentMuxNote, inputContext)', path: 'packages/core/src/agent-session-recovery/input.ts' },
    { symbol: 'createContinuityInputDelivery(next.continuity', path: "packages/core/src/agent-session-recovery/lifecycle.ts" },
    { symbol: 'normalizeAgentContinuityOperation(source.continuity)', path: 'packages/core/src/agent-session-store.ts' }
  ],
  mutations: [
    { label: 'actual-launch-guide-disconnected', file: 'client.js',
      before: 'composeAgentLaunchPrompt(originalPrompt, forkSource ? true : input.injectAgentMuxGuide,', after: 'composeAgentLaunchPrompt(originalPrompt, false,', tests: context },
    { label: 'actual-base-skill-contract-disconnected', file: 'agentmux-cli-module-skills.js',
      before: "return guideText(guideIndex, { 'module-directory': directory }) + '\\n';", after: "return 'No module directory.';", tests: discovery },
    { label: 'actual-message-module-contract-disconnected', file: 'agentmux-cli-module-skills.js',
      before: 'guide: guideText(definition.guide, {', after: "guide: root === 'message' ? 'No collaboration contract.' : guideText(definition.guide, {", tests: discovery },
    { label: 'actual-total-and-object-help-contract-disconnected', file: 'agentmux-cli-help.js',
      before: 'const selected = entries(path);', after: 'const selected = [];', tests: discovery },
    { label: 'actual-reminder-receiver-contract-disconnected', file: 'agent-messaging-guidance.js',
      before: "guideText(guideSharedMessagingReminder)", after: "'No responsibility guidance.'", tests: context },
    { label: 'actual-context-falsely-confirmed-without-content', file: 'client.js',
      before: "agentMuxContext: composed.systemContext && inputConfirmed ? 'confirmed' : 'unconfirmed'", after: "agentMuxContext: 'confirmed'", tests: context },
    { label: 'actual-resume-guide-disconnected', file: 'agent-outbound-message.js',
      before: "return composeAgentPrompt(prompt, [AGENTMUX_AGENT_MESSAGING_ENTRY, agentMuxNote?.trim() ? agentMuxNote : undefined].filter(Boolean).join('\\n\\n'), inputContext);",
      after: 'return composeAgentPrompt(prompt, agentMuxNote, inputContext);', tests: context },
    { label: 'actual-frozen-resume-wire-discarded', file: "agent-session-recovery/lifecycle.js",
      before: 'const composed = frozenInput ? { text: frozenInput.prompt, systemContext: frozenInput.message.systemContext }',
      after: 'const composed = false && frozenInput ? { text: frozenInput.prompt, systemContext: frozenInput.message.systemContext }', tests: context },
    { label: 'actual-post-launch-input-preaccepted-before-admission', file: "agent-session-recovery/lifecycle.js",
      before: "persisted && carried?.delivery === 'launch' && carried.state === 'launch-carried' && carried.key", after: 'persisted && carried?.key', tests: continuity },
    { label: 'actual-automatic-platform-context-not-frozen', file: 'agent-session-recovery/input.js',
      before: 'const systemContext = composeAgentResumePrompt(inputs.continuation, reminder).systemContext;', after: 'const systemContext = undefined;', tests: context },
    { label: 'actual-automatic-platform-context-not-dispatched', file: 'agent-session-recovery/input.js',
      before: 'agentMuxNote: recoverySystemContext(delivery)', after: 'agentMuxNote: delivery.reminder.selected ? delivery.reminder.text : undefined', tests: context },
    { label: 'actual-automatic-receipt-matches-wrong-platform-context', file: 'agent-session-recovery/input.js',
      before: 'composeAgentPrompt(delivery.continuation.text, recoverySystemContext(delivery))',
      after: 'composeAgentPrompt(delivery.continuation.text, delivery.reminder.selected ? delivery.reminder.text : undefined)', tests: context },
    { label: 'actual-historical-automatic-context-recomputed', file: 'agent-session-recovery/input.js',
      before: 'return delivery.systemContext ?? (delivery.reminder.selected ? delivery.reminder.text : undefined);',
      after: 'return composeAgentResumePrompt(delivery.continuation.text, delivery.reminder.selected ? delivery.reminder.text : undefined).systemContext;', tests: context },
    { label: 'actual-frozen-platform-context-validation-removed', file: 'agent-session-recovery/continuity-contract.js',
      before: "delivery.systemContext !== undefined && typeof delivery.systemContext !== 'string' ||", after: '', tests: context },
    { label: 'actual-original-recovery-root-replaced-by-observation', file: "agent-session-recovery/continuity-attempt.js",
      before: "const retained = current && supervisor.retainedAutomaticIntent(current, input);",
      after: 'const retained = undefined;', tests: historical },
    { label: 'actual-launch-browser-preference-removed', file: 'agent-outbound-message.js',
      before: 'guideText(guideSharedRuntime, { \'self-context-verb\': AGENTMUX_SELF_CONTEXT_VERB, \'goal-skill-entry\': AGENTMUX_GOAL_SKILL_ENTRY })', after: 'guideText(guideSharedRuntime, { \'self-context-verb\': AGENTMUX_SELF_CONTEXT_VERB, \'goal-skill-entry\': AGENTMUX_GOAL_SKILL_ENTRY }).replace("browser --skill first", "choose a Browser")', tests: discovery },
    { label: 'actual-skill-browser-preference-removed',
      ...documentMutation('modules/space', "prefer AgentMux's embedded Browser and public CLI", 'choose a Browser'), tests: discovery },
    { label: 'actual-launch-browser-nearby-region-removed', file: 'agent-outbound-message.js',
      before: 'guideText(guideSharedRuntime, { \'self-context-verb\': AGENTMUX_SELF_CONTEXT_VERB, \'goal-skill-entry\': AGENTMUX_GOAL_SKILL_ENTRY })', after: 'guideText(guideSharedRuntime, { \'self-context-verb\': AGENTMUX_SELF_CONTEXT_VERB, \'goal-skill-entry\': AGENTMUX_GOAL_SKILL_ENTRY }).replace("read space --skill", "choose any available Region")', tests: discovery },
    { label: 'actual-skill-browser-nearby-region-removed',
      ...documentMutation('modules/space', 'prefer a directional Region in that same Tab', 'choose any available Region'), tests: discovery }
  ]
})
