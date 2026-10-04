import { fixturePath as upstreamFixturePath, fixtureDisplayPath as upstreamFixtureDisplayPath } from './helpers/fixture-values.js'
import { expect, it } from 'vitest'
import { AgentTerminalScreen } from '../src/agent-terminal-screen.js'
import { AgentProviderRegistry, defineAgentProvider, type AgentProviderDefinition } from '../src/agent-provider.js'
import { inspectCodexPromptExecution } from '../src/providers/codex-prompt-execution.js'

async function frame(body: string, cols = 80, rows = 24, cursorRow = 18) {
 const screen = new AgentTerminalScreen(cols, rows)
 const bytes = Buffer.from(`\x1b[?2026h\x1b[2J${body}\x1b[${cursorRow};3H\x1b[?2026l`)
 await screen.write({startByte: 0, endByte: bytes.length, dataBytes: bytes})
 return screen
}
const composer = '\x1b[18;1H› \x1b[2mAsk Codex to do anything\x1b[22m'
const footer = ("\u001b[20;1Hprobe default · " + (upstreamFixtureDisplayPath("probe")) + "\u001b[21;3Htab\u001b[2m to queue message\u001b[22m")
const working = '\x1b[15;1H• Working (10s • esc to interrupt)' + composer + footer
it.each([
 ['native queue', working.replace('[15;', '[13;') + '\x1b[15;1H\x1b[2m• \x1b[22mMessages to be submitted after next tool call\x1b[16;1H\x1b[2m  ↳ RETAIN_NATIVE_QUEUE\x1b[22m'],
 ['no eight spare rows', working.replace('[15;', '[7;').replaceAll('[18;', '[10;').replaceAll('[20;', '[12;').replaceAll('[21;', '[13;')],
 ['remapped interrupt', working.replace('esc', 'f12')]
])('steers the empty regular composer while preserving %s', async (_name, body) => {
 const screen = await frame(body, 80, 24, _name === 'no eight spare rows' ? 10 : 18)
 try { expect(inspectCodexPromptExecution(screen.snapshot(), 'native-steer')).toBe('interruptible') }
 finally { screen.dispose() }
})
it('does not impose Escape viewport dimensions on a complete narrow composer', async () => {
 const screen = await frame('\x1b[3;1H• Working (esc to interrupt)\x1b[6;1H› \x1b[2mAsk\x1b[22m\x1b[8;1H? for shortcuts', 40, 10, 6)
 try {
  expect(inspectCodexPromptExecution(screen.snapshot(), 'native-steer')).toBe('interruptible')
  expect(inspectCodexPromptExecution(screen.snapshot())).toBe('unavailable')
 } finally { screen.dispose() }
})
it.each([
 ['historical status', working.replace('[15;', '[5;')],
 ['rejected compact steer', working.replace('[15;', '[13;') + '\x1b[15;1H\x1b[2m• \x1b[22mMessages to be submitted at end of turn\x1b[16;1H\x1b[2m  ↳ REJECTED\x1b[22m'],
 ['user text resembling preview', working.replace('[15;', '[13;') + '\x1b[15;1H• Messages to be submitted after next tool call\x1b[16;1H  ↳ USER_TEXT'],
 ['review', working.replace('Working', 'Review')],
 ['compact', working.replace('Working', 'Compacting')],
 ['native draft after cursor', working + '\x1b[18;3HKEEP_NATIVE_DRAFT'],
 ['modal', working + '\x1b[19;1H1. Approve request'],
 ['startup queue', composer + footer],
 ['unknown footer', working + '\x1b[22;1HUNKNOWN']
])('does not steer a %s pane', async (_name, body) => {
 const screen = await frame(body)
 try { expect(inspectCodexPromptExecution(screen.snapshot(), 'native-steer')).toBe('unavailable') }
 finally { screen.dispose() }
})
it('validates a generic native-steer contribution at definition and runtime without changing default', () => {
 const original = new AgentProviderRegistry().get('codex')
 const { providerFork: _fork, ...capabilities } = original.catalog.capabilities
 const definition: AgentProviderDefinition = {catalog: {...original.catalog, capabilities, id: 'generic-steer', hookStrategy: {kind: 'none'}},
  hook: {rules: []}, buildArgs: (_, args) => [...args], terminalPromptRender: original.terminalPromptRender!,
  planPromptInput: prompt => ({kind: 'render-then-submit',payload: prompt,renderedText: prompt,submit: '\r'}),
  inspectPromptExecution: () => 'interruptible', readPromptExecutionEvidence: async () => ({sourceId: 'source',id: 'working',state: 'working'}),
  verifyPromptExecutionTransport: async () => true}
 const provider = defineAgentProvider(definition)
 expect(provider.planPromptInput('body', {execution: 'immediate'})).toEqual(provider.planPromptInput('body'))
 const {verifyPromptExecutionTransport: _verify, ...withoutTransport}=definition
 expect(() => defineAgentProvider(withoutTransport)).toThrow(/inconsistent/)
 expect(() => defineAgentProvider({...definition, planPromptInput: prompt => ({kind: 'render-then-submit',payload: prompt,renderedText: prompt,submit: '\r',prepare: {interrupt: '\x1b',endEvent: 'stop'}})})).toThrow(/inconsistent/)
 expect(() => defineAgentProvider({...definition, catalog: {...definition.catalog,capabilities: {...definition.catalog.capabilities,promptExecution: {immediate: 'interrupt-before-input'}}}})).toThrow(/inconsistent/)
})
