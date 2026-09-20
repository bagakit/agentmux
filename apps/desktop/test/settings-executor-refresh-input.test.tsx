// @vitest-environment happy-dom
import { act } from 'react'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { AgentProviderRegistry } from '@agentmux/core'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AppConfig, ExecutorDetection, ExecutorDetectionInput } from '../src/shared/contracts'
import { AgentSettingsPane } from '../src/renderer/src/components/settings/AgentSettingsPane'
import { WorkspaceSettingsPane } from '../src/renderer/src/components/settings/WorkspaceSettingsPane'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { BoardDiscussionCanvas } from '../src/renderer/src/components/BoardDiscussionCanvas'
import type { BoardRow } from '../src/renderer/src/lib/project-board'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { executorDetectionKey, useAppStore, type ExecutorDetectionState } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM(), detectExecutors = useAppStore.getState().detectExecutors
const config: AppConfig = { ...composerConfig,
  hosts: [composerConfig.hosts[0]!, { id: 'remote', kind: 'ssh', label: 'Saved remote', hostname: 'saved.invalid', user: 'authored', port: 2222, identityFile: '/literal/key' }],
  executors: { ...composerConfig.executors, review: { ...composerConfig.executors.codex!, label: 'Review', providerId: 'claude', command: 'claude' } },
  workspaces: [...composerConfig.workspaces, { ...composerConfig.workspaces[0]!, id: 'remote-project', hostId: 'remote' }] }
const savedInput = (executorId = 'codex', hostId = 'local'): ExecutorDetectionInput => ({
  executorId, providerId: config.executors[executorId]!.providerId, command: config.executors[executorId]!.command,
  host: structuredClone(config.hosts.find(host => host.id === hostId)!)
})
function ready(input = savedInput()): ExecutorDetectionState {
  return { state: 'ready', input, result: { input, executable: input.command, availability: 'available' } }
}
function seed() {
  return Object.fromEntries(config.hosts.flatMap(host => Object.keys(config.executors).map(id => [executorDetectionKey(host.id, id), ready(savedInput(id, host.id))])))
}
const onSave = vi.fn(async () => {})
beforeEach(() => {
  useAppStore.setState({ config, executorDetections: seed(), activeWorkspaceId: 'workspace', hostChecks: {},
    providerCatalog: new AgentProviderRegistry().catalog(),
    detectExecutors: vi.fn(async () => {}), checkHost: vi.fn(async () => {}), prewarmTerminal: vi.fn(async () => {}), warmTerminal: null })
  onSave.mockClear()
})
const card = () => dom.container.querySelector<HTMLDetailsElement>('#executor-settings-codex')!
const status = () => card().querySelector('.check-pill')?.textContent
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function list() {
  const result = await useAppStore.getState().executeControl({ schemaVersion: 1, requestId: 'aggregate', operation: 'list.agents' })
  expect(result.operation).toBe('list.agents')
  if (result.operation !== 'list.agents') throw new Error('wrong operation')
  return result.agents.map(agent => [agent.executorId, agent.availability])
}

it('actual Agent Command keeps the editor connected, open and focused at every character; stale Available never decorates the draft', async () => {
  await dom.render(<AgentSettingsPane config={config} onSave={onSave} />)
  expect(status()).toBe('Available'); expect(dom.container.querySelectorAll('.agent-settings-card')).toHaveLength(2)
  const editor = card(), launch = editor.querySelector<HTMLDetailsElement>('.settings-launch-config')!
  await act(async () => { editor.open = true; launch.open = true })
  const input = [...launch.querySelectorAll<HTMLInputElement>('input')].find(node => node.value === 'codex')!
  expect(input).not.toBeUndefined(); input.focus()
  for (const value of ['codexx', 'codexxy', 'codexxyz']) {
    await fill(input, value)
    expect(status()).toBe('Not checked'); expect(document.activeElement).toBe(input)
    expect(input.isConnected).toBe(true); expect(input.value).toBe(value)
    expect(card()).toBe(editor); expect(editor.open).toBe(true); expect(launch.open).toBe(true)
  }
  expect(useAppStore.getState().executorDetections[executorDetectionKey('local', 'codex')]!.state).toBe('ready')
  expect(dom.container.textContent).toContain('Checks use saved commands. Save a changed command before refreshing.')
  const refresh = dom.container.querySelector<HTMLButtonElement>('[aria-label="Refresh saved executor availability"]')!
  expect(refresh.title).toBe('Refresh saved commands')
  vi.mocked(useAppStore.getState().detectExecutors).mockClear()
  await act(async () => refresh.click())
  expect(useAppStore.getState().detectExecutors).toHaveBeenCalledExactlyOnceWith('local')
  expect(useAppStore.getState().config!.executors.codex!.command).toBe('codex')
  expect(status()).toBe('Not checked')
  expect(dom.container.textContent).toContain('Unsaved'); expect(onSave).not.toHaveBeenCalled()
})

it('non-probe label/args/env/avatar changes preserve current checks; command/provider/connection replacements do not', async () => {
  const nonProbe: AppConfig = { ...config,
    hosts: config.hosts.map(host => ({ ...host, label: 'Later label' })),
    executors: { ...config.executors, codex: { ...config.executors.codex!, label: 'Later executor', args: ['--literal'],
      env: { LITERAL: 'later' }, avatar: { tint: '#abcdef' } } } }
  useAppStore.getState().setConfig(nonProbe)
  expect(Object.keys(useAppStore.getState().executorDetections)).toHaveLength(4)
  expect(await list()).toEqual([['codex', 'available'], ['review', 'available']])
  await dom.render(<AgentSettingsPane config={nonProbe} onSave={onSave} />)
  expect(status()).toBe('Available')
  await dom.render(<AgentSettingsPane config={{ ...nonProbe, executors: { ...nonProbe.executors, codex: { ...nonProbe.executors.codex!, command: 'later-command' } } }} onSave={onSave} />)
  expect(status()).toBe('Not checked')
  const changed: AppConfig = { ...config, executors: { ...config.executors, codex: { ...config.executors.codex!, providerId: 'claude' } } }
  await act(async () => useAppStore.getState().setConfig(changed))
  expect(await list()).toEqual([['codex', 'unknown'], ['review', 'available']])
})

it('missing type and unknown read reasons remain distinct and disappear when the draft input changes', async () => {
  const input = savedInput(), cause = { code: 'EXECUTABLE_NOT_FILE', message: 'Owned path is a directory; expected a regular executable file.' }
  useAppStore.setState({ executorDetections: { ...seed(), [executorDetectionKey('local', 'codex')]: {
    state: 'missing', input, result: { input, executable: input.command, availability: 'missing', cause }, detail: `${cause.code}: ${cause.message}` } } })
  await dom.render(<AgentSettingsPane config={config} onSave={onSave} />)
  expect(status()).toBe('Not available'); expect(card().textContent).toContain(cause.message)
  await act(async () => useAppStore.setState({ executorDetections: { ...seed(), [executorDetectionKey('local', 'codex')]: {
    state: 'error', input, result: { input, executable: input.command, availability: 'check-failed', cause: { code: 'EIO', message: 'original I/O reason' } }, detail: 'EIO: original I/O reason' } } }))
  expect(status()).toBe('Check failed'); expect(card().textContent).toContain('EIO: original I/O reason')
  expect(card().querySelector('.agent-settings-fields')!.firstElementChild?.textContent).toBe('EIO: original I/O reason')
  const changed = { ...config, executors: { ...config.executors, codex: { ...config.executors.codex!, command: 'later' } } }
  await dom.render(<AgentSettingsPane config={changed} onSave={onSave} />)
  expect(status()).toBe('Not checked'); expect(card().textContent).not.toContain('original I/O reason')
})

it('actual Workspace, launcher and Board consumers ignore same-ID command replacements; aggregate still uses the best matching Host', async () => {
  const changed = { ...config, executors: { ...config.executors, codex: { ...config.executors.codex!, command: 'later' } } }
  await dom.render(<WorkspaceSettingsPane config={config} onClose={vi.fn()} />)
  const choices = () => [...dom.container.querySelectorAll<HTMLOptionElement>('.workspace-composer__wide select option')].map(option => option.value)
  expect(choices()).toEqual(['none', 'codex', 'review'])
  await dom.render(<WorkspaceSettingsPane config={changed} onClose={vi.fn()} />)
  expect(choices()).toEqual(['none', 'review'])
  await act(async () => useAppStore.setState({ tabs: { launcher: createWorkbenchTab('launcher', { regionId: 'region', kind: 'launcher', workspaceId: 'workspace' }) },
    agentComposerDrafts: { region: 'Preserved launcher draft' } }))
  await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible={false} />)
  const picks = () => [...dom.container.querySelectorAll('.agent-catalog .agent-pick:not(.agent-pick--unavailable) strong')].map(node => node.textContent)
  expect(picks()).toEqual(['Codex', 'Review'])
  await act(async () => useAppStore.setState({ config: changed }))
  expect(picks()).toEqual(['Review']); expect(useAppStore.getState().agentComposerDrafts.region).toBe('Preserved launcher draft')
  const row: BoardRow = { id: 'main', name: 'Main', path: '/repo', workspace: config.workspaces[0]!, kind: 'branch',
    branch: { name: 'main', worktreePath: '/repo', workspaceId: 'workspace', isCurrent: true },
    runsByColumn: { inbox: [], working: [], 'needs-you': [], done: [] }, sessions: [], searchText: 'main' }
  await act(async () => useAppStore.setState({ config }))
  await dom.render(<BoardDiscussionCanvas row={row} anchor={config.workspaces[0]!} onClose={vi.fn()} onOpenBranches={vi.fn()} />)
  const board = () => [...document.querySelectorAll('.discussion-provider-grid button strong')].map(node => node.textContent)
  expect(board()).toEqual(['Codex', 'Review'])
  await act(async () => useAppStore.setState({ config: changed }))
  expect(board()).toEqual(['Review'])
  expect(await list()).toEqual([['codex', 'unknown'], ['review', 'available']])
  const remote = config.hosts[1]!
  const connectionChanged: AppConfig = { ...config, hosts: [config.hosts[0]!, { ...remote, hostname: 'later.invalid' }] }
  await act(async () => useAppStore.setState({ config: connectionChanged, executorDetections: {
    [executorDetectionKey('remote', 'codex')]: ready(savedInput('codex', 'remote')),
    [executorDetectionKey('local', 'review')]: ready(savedInput('review')) } }))
  expect(await list()).toEqual([['codex', 'unknown'], ['review', 'available']])
})

it('real Store lets a new input replace a held check while unrelated tuple checks remain independent and late replies cannot overwrite it', async () => {
  const pending: Array<{ input: ExecutorDetectionInput; resolve(value: ExecutorDetection): void }> = []
  vi.spyOn(api.executors, 'detect').mockImplementation((id, hostId) => new Promise(done => {
    const current = useAppStore.getState().config!
    pending.push({ input: structuredClone({ executorId: id, providerId: current.executors[id]!.providerId, command: current.executors[id]!.command,
      host: current.hosts.find(host => host.id === hostId)! }), resolve: done })
  }))
  useAppStore.setState({ executorDetections: {}, detectExecutors })
  const original = detectExecutors('local')
  expect(pending.map(item => [item.input.executorId, item.input.command])).toEqual([['codex', 'codex'], ['review', 'claude']])
  const changed = { ...config, executors: { ...config.executors, codex: { ...config.executors.codex!, command: 'later' } } }
  useAppStore.getState().setConfig(changed)
  const next = detectExecutors('local')
  expect(pending.map(item => [item.input.executorId, item.input.command])).toEqual([['codex', 'codex'], ['review', 'claude'], ['codex', 'later']])
  pending[2]!.resolve({ input: pending[2]!.input, executable: 'later', availability: 'missing' }); await next
  pending[0]!.resolve({ input: pending[0]!.input, executable: 'codex', availability: 'available' })
  pending[1]!.resolve({ input: pending[1]!.input, executable: 'claude', availability: 'available' }); await original
  expect(useAppStore.getState().executorDetections[executorDetectionKey('local', 'codex')]).toMatchObject({ state: 'missing', input: { command: 'later' } })
  expect(await list()).toEqual([['codex', 'missing'], ['review', 'available']])
})

it('same-ID input A→B→A does not resurrect an older request token or hide the newer failure cause', async () => {
  const replies: Array<(result: ExecutorDetection) => void> = []
  vi.spyOn(api.executors, 'detect').mockImplementation(() => new Promise(done => { replies.push(done) }))
  useAppStore.setState({ executorDetections: { [executorDetectionKey('local', 'review')]: ready(savedInput('review')) }, detectExecutors })
  const old = detectExecutors('local')
  const changed = { ...config, executors: { ...config.executors, codex: { ...config.executors.codex!, command: 'B' } } }
  useAppStore.getState().setConfig(changed); useAppStore.getState().setConfig(config)
  const latest = detectExecutors('local')
  expect(replies).toHaveLength(3)
  replies[2]!({ input: savedInput(), availability: 'check-failed', cause: { code: 'EIO', message: 'latest cause' } }); await latest
  replies[0]!({ input: savedInput(), executable: 'codex', availability: 'available' })
  replies[1]!({ input: savedInput('review'), executable: 'claude', availability: 'available' }); await old
  expect(useAppStore.getState().executorDetections[executorDetectionKey('local', 'codex')]).toMatchObject({ state: 'error', detail: 'EIO: latest cause' })
})

it('all actual production record lookups pass captured-input matching; source discovery must be nonempty', () => {
  const root = resolve(import.meta.dirname, '../src/renderer/src'), reads: Array<{ path: string; guarded: boolean }> = []
  const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter(file => file.isFile() && /\.tsx?$/u.test(file.name))
  expect(files.length).toBeGreaterThan(0)
  for (const file of files) {
    const path = join(file.parentPath, file.name), source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true,
      path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const names = new Set<string>()
    function selectors(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer) &&
        node.initializer.expression.getText(source) === 'useAppStore' && node.initializer.arguments.some(argument => argument.getText(source).includes('.executorDetections'))) names.add(node.name.text)
      ts.forEachChild(node, selectors)
    }
    selectors(source)
    function visit(node: ts.Node) {
      if (ts.isElementAccessExpression(node) && ((ts.isIdentifier(node.expression) && names.has(node.expression.text)) ||
        (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'executorDetections'))) {
        let ancestor: ts.Node | undefined = node.parent, guarded = false
        while (ancestor && !ts.isSourceFile(ancestor)) {
          if (ts.isCallExpression(ancestor) && ancestor.expression.getText(source) === 'currentExecutorDetection') { guarded = true; break }
          ancestor = ancestor.parent
        }
        reads.push({ path, guarded })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  expect(reads.length).toBeGreaterThan(0)
  expect(new Set(reads.map(read => read.path)).size).toBeGreaterThan(1)
  expect(reads.filter(read => !read.guarded)).toEqual([])
})
