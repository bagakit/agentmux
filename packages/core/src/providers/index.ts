import { createHash, randomBytes } from 'node:crypto'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import { antigravityProvider } from '@agentmux/providers/antigravity/provider'
import { createAntigravityAcpProbe } from '@agentmux/providers/antigravity/acp-probe'
import { ACP_ACTOR_ID, ACP_ACTOR_LIFECYCLE, ACP_ACTOR_TOKEN, ANTIGRAVITY_ACP_ACTOR_PROTOCOL } from '@agentmux/providers/antigravity/acp-actor'
import { antigravityAcpActor, antigravityAcpFraming } from './antigravity-acp-owner.js'
import { mintObjectId } from '../object-id.js'
import { formatHookToolOutput } from '../hook-tool-outcome.js'
import { antigravityNativeHistory } from '@agentmux/providers/antigravity/native-history'
import { antigravityNativeSession } from '@agentmux/providers/antigravity/native-session'
import { AgentMuxError } from '../errors.js'
import { nativeProcessBirth, nativeProcessFiles } from '../agent-native-process.js'
import { observeNativeJsonlHistory } from '../native-history-source-observer.js'
import { NativeJsonlHistoryReader, readNativeHistoryBytes } from '../native-jsonl-history-reader.js'
import { isNativeText, nativeJsonStringify, nativeTextConcat, nativeTextHasSpeech, nativeTextJoin, nativeTextBase64, nativeTextTrim, type NativeText } from '../native-history-value.js'
import { nativeTextBetween } from '../native-history-source.js'
import type { AgentProviderSessionHistoryContext, AgentProviderSessionHistoryObservation, AgentProviderSessionHistoryObservationContext, AgentSessionHistoryItem } from '../types.js'
import { executionEnvironmentValue, executionHomeDirectory, executionPath, executionTemporaryDirectory } from './execution-environment.js'
import { catalog, hookCommandTimeout, hookToolFields, inspectHookDisableSetting, runScopedHookCommand } from './shared.js'
import { createClaudeProvider } from './claude.js'
import { createCodexProvider } from './codex.js'
import { copilotProvider } from '@agentmux/providers/copilot/provider'
import { normalizeNativeSessionId } from '../agent-native-locator.js'
import { createCursorProvider } from './cursor-adapter.js'
import { droidProvider } from '@agentmux/providers/droid/provider'
import { droidNativeHistory } from '@agentmux/providers/droid/native-history'
import { geminiProvider } from '@agentmux/providers/gemini/provider'
import { grokProvider } from '@agentmux/providers/grok/provider'
import { observeGrokSessionHistory, readGrokSessionHistoryPage, readGrokConversationChanges, readGrokSessionHistoryRecord, grokRecoveryFiles,
  observeGrokSessionStatus, readGrokPromptExecutionEvidence } from './grok-history.js'
import { readGrokInputInitialization } from '@agentmux/providers/grok/input-initialization'
import { createHermesProvider } from './hermes.js'
import { kimiProvider } from '@agentmux/providers/kimi/provider'
import { kimiNativeHistory } from '@agentmux/providers/kimi/native-history'
import { createOpenCodeProvider } from './opencode.js'
import { createPiProvider } from './pi.js'
import { traexProvider } from '@agentmux/providers/traex/provider'
import { discoverAppServerNativeSession, readAppServerSessionHistoryPage } from './app-server.js'

export type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

const historyServices = { AgentMuxError, NativeJsonlHistoryReader, isNativeText, nativeJsonStringify, nativeTextConcat }

const ACP_LAUNCH_OPTION = { id: 'interaction', choiceId: 'acp' } as const

function createAntigravityProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  const { catalog: seed, planLocalHooks, ...provider } = antigravityProvider({
    formatHookToolOutput, hookToolFields, hookCommandTimeout, runScopedHookCommand
  })
  const { assertAntigravityHistorySource, readAntigravitySessionHistoryPage } =
    antigravityNativeHistory<NativeText, AgentProviderSessionHistoryContext, AgentSessionHistoryItem>({
      ...historyServices, nativeTextHasSpeech, nativeTextTrim, nativeTextBetween
    })
  const { discoverAntigravityNativeSession, observeAntigravitySessionHistory } =
    antigravityNativeSession<AgentProviderSessionHistoryObservation, AgentProviderSessionHistoryObservationContext>({
      AgentMuxError, nativeProcessBirth, nativeProcessFiles, observeNativeJsonlHistory, assertAntigravityHistorySource
    })
  return defineAgentProvider({
    ...provider,
    catalog: catalog(seed),
    probeAcp: createAntigravityAcpProbe(antigravityAcpFraming),
    async prepareManagedLaunch(plan, lifecycleOperationId, context) {
      const original = context.originalResume
      const acp = context.launchOptions?.[ACP_LAUNCH_OPTION.id] === ACP_LAUNCH_OPTION.choiceId
      const originalAcp = original?.launchOptions?.[ACP_LAUNCH_OPTION.id] === ACP_LAUNCH_OPTION.choiceId
      if (context.kind === 'resume' && acp !== originalAcp) throw new AgentMuxError(
        'The structured and terminal launch choices belong to their original conversation. Keep this original Session and its execution choice.',
        'AGENT_ACP_RESUME_SOURCE_UNCONFIRMED')
      if (!acp) return { plan }
      if (context.kind === 'fork') throw new AgentMuxError('The original ACP conversation has no confirmed fork capability.', 'AGENT_FORK_UNSUPPORTED')
      const origin = original
      if (context.kind === 'resume' && (origin?.nativeHandle.kind !== 'provider' || origin.nativeHandle.providerId !== 'antigravity')) throw new AgentMuxError(
        'This resume target has no confirmed original Antigravity ACP execution context.', 'AGENT_ACP_RESUME_SOURCE_UNCONFIRMED')
      const actor = { protocolId: ANTIGRAVITY_ACP_ACTOR_PROTOCOL, actorId: mintObjectId(), lifecycleOperationId,
        token: randomBytes(32).toString('hex'), launch: { command: plan.command, args: [...context.invocationArgs] } }
      return { nativeActor: actor, managedHooks: false, promptDelivery: 'post-launch', plan: { ...plan, command: process.execPath,
        args: [fileURLToPath(new URL('./antigravity-acp-owner.js', import.meta.url)), JSON.stringify({ ...actor.launch, cwd: context.workspacePath,
          ...(origin ? { resumeSessionId: origin.nativeHandle.sessionId } : {}) })],
        env: { ...plan.env, ELECTRON_RUN_AS_NODE: '1', [ACP_ACTOR_TOKEN]: actor.token, [ACP_ACTOR_ID]: actor.actorId, [ACP_ACTOR_LIFECYCLE]: lifecycleOperationId } } }
    },
    managedAcp: {
      protocolId: ANTIGRAVITY_ACP_ACTOR_PROTOCOL,
      launchOption: ACP_LAUNCH_OPTION,
      async prepareInput({ nativeActor, processId, signal }, plan) {
        const { actorId, lifecycleOperationId, token } = nativeActor
        const identity = { actorId, lifecycleOperationId, processId }
        const assertCurrent = async (): Promise<void> => {
          signal.throwIfAborted()
          const snapshot = await antigravityAcpActor.inspect(identity, token, signal)
          if (snapshot.state !== 'ready' || snapshot.sessionId !== plan.threadId) throw new AgentMuxError(
            'The original native ACP session could not confirm its input endpoint.', 'AGENT_ACP_ACTOR_UNCONFIRMED')
          if (snapshot.activePromptId !== undefined) throw new AgentMuxError(
            'The current ACP turn is still active.', 'AGENT_ACP_PROMPT_BUSY')
        }
        return { plan, assertCurrent, dispose() {},
          async send(prompt, { clientCorrelation, ...frozen }) {
            if (JSON.stringify(frozen) !== JSON.stringify(plan) || !clientCorrelation) throw new AgentMuxError(
              'The prepared ACP request does not match the original input claim.', 'AGENT_PROMPT_INPUT_UNCONFIRMED')
            const requestId = `acp-prompt-${createHash('sha256').update(clientCorrelation).digest('hex')}`
            return await antigravityAcpActor.submitPrompt(identity, token, { sessionId: plan.threadId, requestId, prompt }, signal)
          }
        }
      },
      async interrupt({ nativeActor, processId, signal }, nativeSessionId, expectedRequestId) {
        const { actorId, lifecycleOperationId, token } = nativeActor
        const identity = { actorId, lifecycleOperationId, processId }
        const snapshot = await antigravityAcpActor.inspect(identity, token, signal)
        if (snapshot.state !== 'ready' || snapshot.sessionId !== nativeSessionId) throw new AgentMuxError(
          'The original ACP cancellation target could not be confirmed.', 'AGENT_ACP_CANCEL_UNCONFIRMED')
        const requestId = expectedRequestId ?? snapshot.activePromptId
        if (requestId === undefined) throw new AgentMuxError('The original ACP session has no active prompt.',
          'AGENT_ACP_TURN_NOT_ACTIVE', undefined, { disposition: 'not_applied', confirmedInputBytes: 0 })
        await antigravityAcpActor.cancelPrompt(identity, token, { sessionId: nativeSessionId, requestId }, signal)
      },
      async attach({ nativeActor, processId, signal, waitForReady }) {
        const { actorId, lifecycleOperationId, token } = nativeActor
        const observe = () => antigravityAcpActor.inspect({ actorId, lifecycleOperationId, processId }, token, signal)
        let snapshot
        for (;;) {
          try { snapshot = await observe() }
          catch (error) {
            if (!waitForReady || signal.aborted) throw error
            await wait(100, undefined, { signal })
            continue
          }
          if (snapshot.state !== 'initializing' || !waitForReady) break
          await wait(100, undefined, { signal })
        }
        if (snapshot.state !== 'ready') throw new AgentMuxError(snapshot.state === 'initializing' ? 'The original ACP initialization is still pending.' :
          snapshot.state === 'authentication-required' ? `Antigravity requires authentication at ${snapshot.stage}.` : `The original ACP step ${snapshot.stage} is unconfirmed.`,
          snapshot.state === 'authentication-required' ? 'AGENT_ACP_AUTHENTICATION_REQUIRED' : 'AGENT_ACP_ACTOR_UNCONFIRMED')
        return { adapterId: 'antigravity', sessionId: snapshot.sessionId,
          onEvent(listener) { listener({ type: 'native-session', sessionId: snapshot.sessionId }); return () => {} },
          async respondPermission() { throw new AgentMuxError('This ACP actor has no pending permission request.', 'UNKNOWN_AGENT_INTERACTION') },
          async close() {} }
      }
    },
    planManagedHooks: ({ env, workspacePath }) => planLocalHooks(executionPath(executionHomeDirectory(env), workspacePath)),
    discoverNativeSession: discoverAntigravityNativeSession,
    readSessionHistoryPage: readAntigravitySessionHistoryPage,
    observeSessionHistory: observeAntigravitySessionHistory
  })
}

const hookServices = { formatHookToolOutput, hookCommandTimeout, hookToolFields, runScopedHookCommand,
  executionEnvironmentValue, executionHomeDirectory, executionPath }

/** Composition-only list. Provider-specific definitions live in their own modules. */
export function createBuiltInAgentProviders(defineAgentProvider: ProviderFactory): readonly AgentProvider[] {
  const gemini = geminiProvider({ ...hookServices, executionTemporaryDirectory })
  const copilot = copilotProvider({ ...hookServices, normalizeNativeSessionId })
  const grok = grokProvider({ ...hookServices, normalizeNativeSessionId })
  const kimi = kimiProvider(hookServices)
  const { hookDisableKey, ...droid } = droidProvider(hookServices)
  const { readKimiSessionHistoryPage } = kimiNativeHistory<NativeText, AgentProviderSessionHistoryContext, AgentSessionHistoryItem>({
    ...historyServices, readNativeHistoryBytes
  })
  const { readDroidSessionHistoryPage, readDroidSessionHistoryRecord } =
    droidNativeHistory<NativeText, AgentProviderSessionHistoryContext, AgentSessionHistoryItem>({
      ...historyServices, nativeTextJoin, nativeTextHasSpeech, nativeTextBase64
    })
  return [
    createCodexProvider(defineAgentProvider),
    createClaudeProvider(defineAgentProvider),
    defineAgentProvider({ ...traexProvider, catalog: catalog(traexProvider.catalog),
      discoverNativeSession: context => discoverAppServerNativeSession(context, 'traex'),
      readSessionHistoryPage: readAppServerSessionHistoryPage, observeSessionHistory: observeNativeJsonlHistory }),
    createHermesProvider(defineAgentProvider),
    createPiProvider(defineAgentProvider),
    defineAgentProvider({ ...grok, catalog: catalog(grok.catalog),
      readSessionHistoryPage: readGrokSessionHistoryPage,
      recoveryFiles: grokRecoveryFiles,
      readSessionHistoryRecord: readGrokSessionHistoryRecord,
      observeSessionHistory: observeGrokSessionHistory,
      readConversationChanges: readGrokConversationChanges,
      readInputInitialization: readGrokInputInitialization,
      observeSessionStatus: observeGrokSessionStatus,
      readPromptExecutionEvidence: readGrokPromptExecutionEvidence }),
    defineAgentProvider({ ...gemini, catalog: catalog(gemini.catalog) }),
    createAntigravityProvider(defineAgentProvider),
    createCursorProvider(defineAgentProvider),
    defineAgentProvider({ ...kimi, catalog: catalog(kimi.catalog), readSessionHistoryPage: readKimiSessionHistoryPage }),
    defineAgentProvider({ ...droid, catalog: catalog(droid.catalog),
      readSessionHistoryPage: readDroidSessionHistoryPage, readSessionHistoryRecord: readDroidSessionHistoryRecord,
      inspectHookActivation: context => inspectHookDisableSetting(context, hookDisableKey) }),
    defineAgentProvider({ ...copilot, catalog: catalog(copilot.catalog) }),
    createOpenCodeProvider(defineAgentProvider)
  ]
}

export { createClaudeProvider } from './claude.js'
export { createCodexProvider } from './codex.js'
export { createHermesProvider } from './hermes.js'
export { createOpenCodeProvider } from './opencode.js'
export { createPiProvider } from './pi.js'
