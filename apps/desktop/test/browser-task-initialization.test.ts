// @vitest-environment happy-dom
import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { createWorkspaceLayout } from '@agentmux/layout'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner'
import { captureExecutorInvocation } from '../../../packages/core/src/agent-executor-invocation'
import { RuntimeController } from '../src/main/runtime-controller'
import { sessionInputWriteResult, unwrapSessionInputWriteResult } from '../src/shared/session-input-result'
import { api } from '../src/renderer/src/lib/api'
import { createBrowserAgent } from '../src/renderer/src/lib/browser-agent-creation'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab, type BrowserWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'

const initial = useAppStore.getState(), launcher = useLauncherState.getState()
const closes: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
  useAppStore.setState(initial, true); useLauncherState.setState(launcher, true)
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})

it.each(['directory-trust', 'authentication'] as const)('Browser creation keeps its task out of native %s and retains its original input', async reason => {
  const f = await rpcOwnerFixture(['recipient'], undefined, () => ({ providerId: 'grok', executorId: 'grok' }))
  closes.push(f.close)
  const command = join(f.root, 'native-inspect')
  await writeFile(command, `#!${process.execPath}\nconsole.log(JSON.stringify({cwd:process.cwd(),projectTrusted:false}));\n`)
  await chmod(command, 0o700)
  const previous = (await f.store.readMetadata('recipient'))!
  const invocation = captureExecutorInvocation('grok', 'grok', 'browser-create', 'b'.repeat(64), { env: { HOME: f.root, GROK_HOME: f.root } })!
  await f.store.compareAndSwapMetadata(previous, { ...previous,
    creation: { createOperationId: 'browser-create', createdRun: previous.run, initialPrompt: 'not-requested',
      intentDigest: 'b'.repeat(64), executorInvocationDigest: invocation.digest }, executorInvocation: invocation.value })
  const inner = f.client as any
  await inner.registry.refresh('recipient', previous.run)
  inner.kernel.status = vi.fn(async (id: string) => ({ ...f.run(id), program: command, pid: 21001 }))
  if (reason === 'authentication') {
    // A second Provider protocol shape; the client never learns its machine fields.
    const provider = f.client.providers.get('grok'), account = { account: { state: 'login-required' } }
    f.client.providers.replace({ ...provider, readInputInitialization: async () => ({ state: 'pending',
      reason: account.account.state === 'login-required' ? 'authentication' : 'directory-trust' }) })
  }
  const dispose = await useAppStore.getState().initialize(); dispose()
  useAppStore.setState(initial, true)
  const session = { ...composerSession('recipient', 'grok'), workspacePath: f.root }
  const source = { displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab', regionId: 'browser-region' }
  const browser: BrowserWorkbenchSurface = { kind: 'browser', id: 'browser', browserId: 'browser', regionId: source.regionId,
    workspaceId: 'workspace', navigationId: 'navigation', mode: 'normal', profileId: 'profile', url: 'https://example.invalid/', title: 'Original page',
    driving: false, loading: false, canGoBack: false, canGoForward: false, viewport: 'responsive', error: null, appLinkPrompt: null,
    control: { owner: 'human', agent: null, revision: 1, activeOperationId: null, inputIsolation: 'inactive' } }
  useAppStore.setState({ config: { ...composerConfig, workspaces: [{ ...composerConfig.workspaces[0]!, path: f.root }],
    executors: { grok: { providerId: 'grok', command, args: [], env: {}, injectAgentMuxGuide: false } } },
    sessions: [session], tabs: { tab: createWorkbenchTab('tab', browser) }, layouts: { workspace: createWorkspaceLayout('group', ['tab']) },
    agentSteerQueues: {}, agentSteerInFlight: {}, agentSteerInFlightPhase: {}, spatialRequests: {}, executorDetections: {}, hostExecutorInventories: {},
    agentComposerDrafts: { recipient: 'Independent unsent draft' }, error: null })
  useLauncherState.setState({ executors: { workspace: 'grok' } })
  const execute = vi.fn(async (request, _signal, options) => {
    const report = { operation: 'agent.open', requestId: request.requestId,
      agent: { agentSessionId: session.id, hostId: 'local', runId: session.control.run.runId, cwd: f.root }, issues: [] }
    if (request.operation === 'space.inspect') return { operation: 'space.inspect', request: { report } }
    useAppStore.setState(state => ({ spatialRequests: { ...state.spatialRequests,
      [request.requestId]: { purpose: options.purpose, browserAgent: options.browserAgent, agentSessionId: session.id } },
      tabs: { tab: createWorkbenchTab('tab', { ...browser, agentCreationRequestId: request.requestId }) } }))
    return report
  })
  useAppStore.setState({ executeControl: execute } as never)
  vi.spyOn(api.browser, 'returnControl').mockResolvedValue({ ...browser, id: browser.browserId,
    control: { ...browser.control!, owner: 'agent', agent: { hostId: 'local', agentSessionId: session.id }, revision: 2, inputIsolation: 'isolated' } } as never)
  vi.spyOn(api.sessions, 'refresh').mockResolvedValue(session)
  vi.spyOn(api.sessions, 'inspectInput').mockImplementation(async (_control, key) => f.client.inspectAgentInput({ key }))
  const runtime = Object.create(RuntimeController.prototype) as RuntimeController
  Object.assign(runtime, { configuredClient: () => f.client,
    trackHostOperation: (_host: string, call: () => Promise<unknown>) => call() })
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (control, prompt, operationId, binding, choice, authorHuman, agentMuxNote) =>
    unwrapSessionInputWriteResult(structuredClone(await sessionInputWriteResult(() => runtime.submitPrompt(
      control, prompt, operationId, binding, undefined, choice, authorHuman, agentMuxNote)))))

  const result = await createBrowserAgent('browser', source)
  expect(result.kind).toBe('input-unconfirmed')
  expect(submit).toHaveBeenCalledOnce()
  const entry = useAppStore.getState().agentSteerQueues.recipient![0]!
  const key = { kind: 'prompt' as const, agentSessionId: session.id, expectedRun: session.control.run, submissionId: entry.operationId }
  await inner.inputWaitingRecipients.get(session.id)?.pending
  expect(inner.kernel.input).not.toHaveBeenCalled(); expect(f.rawInput).not.toHaveBeenCalled()
  await vi.waitFor(async () => expect((await f.client.inspectAgentInput({ key }))?.control.waiting?.failure?.message).toContain(`pending (${reason})`))
  expect(inner.kernel.input).not.toHaveBeenCalled(); expect(f.rawInput).not.toHaveBeenCalled()
  expect(entry.text).toContain('接管并查看用户指定的 Browser')
  expect(entry.inputReceipt?.key).toEqual(key)
  expect(useAppStore.getState().agentComposerDrafts.recipient).toBe('Independent unsent draft')
  await expect(createBrowserAgent('browser', source)).resolves.toMatchObject({ kind: 'input-unconfirmed' })
  expect(submit).toHaveBeenCalledOnce()
  expect(inner.kernel.input).not.toHaveBeenCalled()
  // An independent, explicitly chosen terminal action stays usable on this same healthy Run.
  await f.client.submitAgentPrompt({ agentSessionId: session.id, expectedRun: session.control.run, operationId: 'deliberate-terminal',
    prompt: 'Independent terminal action', admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', authorHuman: true })
  expect(inner.kernel.input).toHaveBeenCalled()
  expect((await f.client.inspectAgentInput({ key }))?.key).toEqual(key)
  const manualWrites = vi.mocked(inner.kernel.input).mock.calls.length
  const current = (await f.store.readMetadata(session.id))!, at = current.updatedAt + 1
  await f.store.compareAndSwapMetadata(current, { ...current,
    nativeHandle: { kind: 'provider', providerId: 'grok', sessionId: 'original-native' },
    nativeBinding: { source: 'native-hook', run: current.run, observedAt: at }, updatedAt: at })
  await inner.registry.refresh(session.id, current.run); inner.publishSession(inner.registry.get(session.id))
  await vi.waitFor(async () => expect((await f.client.inspectAgentInput({ key }))?.status).toBe('terminal-confirmed'))
  const sent = (await f.client.inspectAgentInput({ key }))!
  expect(sent.admission!.admission!.intent!.message!.userContent).toBe(entry.text)
  expect(inner.kernel.input).toHaveBeenCalledTimes(manualWrites + 1)
  await f.client.rejoinAgentInputWaiting({ ref: sent.ref })
  expect(inner.kernel.input).toHaveBeenCalledTimes(manualWrites + 1)
  expect(submit).toHaveBeenCalledOnce()
})
