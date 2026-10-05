import { fixturePath as reshapeFixturePath } from './helpers/fixture-values.js'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectManagedHookContent, renderMergedHookContent, type AgentHookMergeStrategy } from '../src/hook-config-merge.js'
import { AgentManagedHookInstaller } from '../src/managed-hook-installer.js'
import { createCodexManagedHookPlan } from '../src/providers/codex.js'
import { createHermesManagedHookPlan } from '../src/providers/hermes.js'

const nested = { type: 'command', command: ("node '" + reshapeFixturePath("owned/agentmux-hook.js") + "'"), timeout: 10 }
const definition = { matcher: '*', hooks: [nested] }
const owned = JSON.stringify({ description: 'bridge', hooks: { Stop: [definition] } })
const wrapped = { kind: 'json-managed-events' } as const
const rootStrategy = { kind: 'json-root-managed-events' } as const
const yamlStrategy = { kind: 'yaml-managed-events' } as const
const approvalStrategy = { kind: 'json-managed-approvals' } as const
const mention = { type: 'command', command: "printf '%s\\n' '{}' # agentmux-hook.js documentation", timeout: 5 }
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('current Hook declaration presence preserves shared content', () => {
  it.each([wrapped, rootStrategy])('preserves marker mentions, old paths and foreign mixed leaves for $kind', strategy => {
    const original = { Stop: [{ matcher: '*', hooks: [mention] }, { hooks: [{ ...nested, command: ("node " + reshapeFixturePath("old/agentmux-hook.js")) }] }],
      Legacy: [{ hooks: [mention] }], Future: { native: 'unknown-shape' } }
    const current = JSON.stringify(strategy === wrapped ? { description: 'user label', hooks: original } : { hooksDisabled: true, ...original })
    const content = strategy === wrapped ? owned : JSON.stringify({ Stop: [definition] })
    const first = renderMergedHookContent(current, content, strategy)
    const parsed = JSON.parse(first), events = strategy === wrapped ? parsed.hooks : parsed
    expect(events.Stop.slice(0, 2)).toEqual(original.Stop)
    expect(events.Stop.at(-1)).toEqual(definition)
    expect(events.Legacy).toEqual(original.Legacy)
    expect(events.Future).toEqual(original.Future)
    if (strategy === wrapped) expect(parsed.description).toBe('user label')
    else { expect(parsed.hooksDisabled).toBe(true); expect(parsed).not.toHaveProperty('hooks') }
    expect(renderMergedHookContent(first, content, strategy)).toBe(first)
    expect(inspectManagedHookContent(first, content, strategy)).toEqual({ present: true, current: true })
  })

  it('leaves a same-scope mixed container byte-identical without a duplicate leaf', () => {
    const mixed = { ...definition, hooks: [mention, nested, { type: 'prompt', prompt: 'foreign native hook' }] }
    const current = JSON.stringify({ description: 'my label', hooks: { Stop: [mixed] } })
    expect(renderMergedHookContent(current, owned, wrapped)).toBe(current)
    expect(inspectManagedHookContent(current, owned, wrapped)).toEqual({ present: true, current: true })
    expect(JSON.parse(current).hooks.Stop[0].hooks).toHaveLength(3)
  })

  it.each([
    ['event', { Other: [definition] }],
    ['matcher', { Stop: [{ ...definition, matcher: 'Bash' }] }],
    ['wrapper property', { Stop: [{ ...definition, userSetting: true }] }],
    ['leaf timeout', { Stop: [{ ...definition, hooks: [{ ...nested, timeout: 5 }] }] }],
    ['leaf type', { Stop: [{ ...definition, hooks: [{ ...nested, type: 'another-native-kind' }] }] }],
    ['wrapper command', { Stop: [{ ...definition, hooks: [{ ...nested, command: `sh -c ${JSON.stringify(nested.command)}` }] }] }]
  ])('requires exact %s before declaring current; never deletes the original', (_name, hooks) => {
    const current = JSON.stringify({ hooks })
    expect(inspectManagedHookContent(current, owned, wrapped)).toEqual({ present: false, current: false })
    const merged = JSON.parse(renderMergedHookContent(current, owned, wrapped))
    for (const [event, original] of Object.entries(hooks)) expect(merged.hooks[event].slice(0, original.length)).toEqual(original)
    expect(merged.hooks.Stop.at(-1)).toEqual(definition)
  })

  it('preserves declared command order and multiplicity inside a mixed container', () => {
    const other = { ...nested, command: ("node " + reshapeFixturePath("owned/other-hook.js")) }
    const content = JSON.stringify({ hooks: { Stop: [{ hooks: [nested, other, nested] }] } })
    const present = JSON.stringify({ hooks: { Stop: [{ hooks: [nested, mention, other, nested] }] } })
    expect(renderMergedHookContent(present, content, wrapped)).toBe(present)
    const wrongOrder = JSON.stringify({ hooks: { Stop: [{ hooks: [other, nested] }] } })
    expect(inspectManagedHookContent(wrongOrder, content, wrapped)).toEqual({ present: false, current: false })
  })

  it('preserves YAML comments, unknown nodes and marker mentions; exact declaration is a no-op', () => {
    const current = '# keep\nsecret: private-fixture\nhooks:\n  Stop:\n    - command: "printf agentmux-hook.js" # foreign note\n      timeout: 5\n  Legacy:\n    - command: old/agentmux-hook.js\n  Future:\n    native: unknown\n'
    const content = JSON.stringify({ hooks: { Stop: [{ command: nested.command, timeout: 10 }] } })
    const first = renderMergedHookContent(current, content, yamlStrategy)
    const before = parseDocument(current).toJS(), after = parseDocument(first).toJS()
    expect(after.hooks.Stop[0]).toEqual(before.hooks.Stop[0])
    expect(after.hooks.Legacy).toEqual(before.hooks.Legacy)
    expect(after.hooks.Future).toEqual(before.hooks.Future)
    expect(first).toContain('# foreign note'); expect(first).toContain('# keep'); expect(after.secret).toBe(before.secret)
    expect(after.hooks.Stop.at(-1)).toEqual({ command: nested.command, timeout: 10 })
    expect(renderMergedHookContent(first, content, yamlStrategy)).toBe(first)
    expect(inspectManagedHookContent(first, content, yamlStrategy)).toEqual({ present: true, current: true })
  })

  it('keeps approvals and their timestamps; only an exact event/command pair satisfies the plan', () => {
    const pair = { event: 'Stop', command: nested.command }, content = JSON.stringify({ approvals: [pair] })
    const original = [{ ...pair, event: 'Other', approved_at: 'user-time' }, { event: 'Stop', command: mention.command, approved_at: 'foreign-time' }]
    const current = JSON.stringify({ userMetadata: true, approvals: original })
    expect(inspectManagedHookContent(current, content, approvalStrategy)).toEqual({ present: false, current: false })
    const first = renderMergedHookContent(current, content, approvalStrategy)
    expect(JSON.parse(first).approvals).toEqual([...original, pair])
    const withMetadata = JSON.stringify({ approvals: [{ ...pair, approved_at: 'native-time', extra: 'user' }] })
    expect(renderMergedHookContent(withMetadata, content, approvalStrategy)).toBe(withMetadata)
    expect(inspectManagedHookContent(withMetadata, content, approvalStrategy)).toEqual({ present: true, current: true })
  })

  it.each([
    'hooks:\n  Stop:\n    - !user-native {command: owned}\n',
    'hooks:\n  Stop:\n    - command: !user-native owned\n',
    'user_command: &user_command owned\nhooks:\n  Stop:\n    - command: *user_command\n'
  ])('preserves opaque YAML nodes without counting their decoded shape as a declaration', current => {
    const content = JSON.stringify({ hooks: { Stop: [{ command: 'owned' }] } })
    expect(inspectManagedHookContent(current, content, yamlStrategy)).toEqual({ present: false, current: false })
    const first = renderMergedHookContent(current, content, yamlStrategy)
    expect(parseDocument(first).toJS().hooks.Stop).toHaveLength(2)
    expect(first).toContain(current.includes('!user-native') ? '!user-native' : '*user_command')
    expect(renderMergedHookContent(first, content, yamlStrategy)).toBe(first)
  })

  it.each([
    ['{"hooks":[]}', wrapped, owned],
    ['{"hooks":{"Stop":{"unknown":true}}}', wrapped, owned],
    ['hooks: [unknown]\n', yamlStrategy, JSON.stringify({ hooks: { Stop: [{ command: 'owned' }] } })],
    ['hooks:\n  Stop:\n    unknown: true\n', yamlStrategy, JSON.stringify({ hooks: { Stop: [{ command: 'owned' }] } })],
    ['{"approvals":{"unknown":true}}', approvalStrategy, JSON.stringify({ approvals: [{ event: 'Stop', command: 'owned' }] })]
  ])('refuses an ambiguous selected native container without converting it to empty: %s', (current, strategy, content) => {
    expect(() => renderMergedHookContent(current, content, strategy as AgentHookMergeStrategy)).toThrowError(expect.objectContaining({ code: 'HOOK_TARGET_UNPARSEABLE' }))
    expect(() => inspectManagedHookContent(current, content, strategy as AgentHookMergeStrategy)).toThrowError(expect.objectContaining({ code: 'HOOK_TARGET_UNPARSEABLE' }))
  })

  it.each(['codex', 'hermes'] as const)('real Installer consumes the %s Provider plan while keeping foreign content and no-write repeats', async provider => {
    const root = await mkdtemp(join(tmpdir(), 'amx-hook-preserve-')); roots.push(root)
    const plan = provider === 'codex' ? createCodexManagedHookPlan(root) : createHermesManagedHookPlan({ HERMES_HOME: root })
    const original = new Map<string, unknown>()
    for (const mutation of plan.mutations) {
      await mkdir(join(mutation.path, '..'), { recursive: true })
      if (mutation.merge?.kind === 'yaml-managed-events') {
        const text = '# user note\nsecret: fixture-secret\nhooks:\n  pre_tool_call:\n    - command: "printf agentmux-hook.js"\n      timeout: 5\n'; original.set(mutation.path, parseDocument(text).toJS()); await writeFile(mutation.path, text)
      } else {
        const body = mutation.merge?.kind === 'json-managed-approvals' ? { approvals: [{ event: 'pre_tool_call', command: mention.command, approved_at: 'user' }] }
          : { userLabel: true, hooks: { Stop: [{ hooks: [mention] }] } }
        original.set(mutation.path, body); await writeFile(mutation.path, JSON.stringify(body))
      }
    }
    const installer = new AgentManagedHookInstaller(join(root, 'receipts'))
    expect((await installer.inspect(plan)).status).toBe('not_installed')
    const receipt = await installer.ensure(plan); expect(receipt?.entries.length).toBe(plan.mutations.length)
    expect((await installer.inspect(plan)).status).toBe('installed')
    const before = await Promise.all(plan.mutations.map(async m => ({ bytes: await readFile(m.path), mtime: (await stat(m.path)).mtimeMs })))
    expect(await installer.ensure(plan)).toBeNull()
    expect(await Promise.all(plan.mutations.map(async m => ({ bytes: await readFile(m.path), mtime: (await stat(m.path)).mtimeMs })))).toEqual(before)
    for (const mutation of plan.mutations) {
      const text = await readFile(mutation.path, 'utf8'), parsed = mutation.merge?.kind === 'yaml-managed-events' ? parseDocument(text).toJS() : JSON.parse(text)
      if (mutation.merge?.kind === 'yaml-managed-events') { expect(parsed.hooks.pre_tool_call[0]).toEqual((original.get(mutation.path) as any).hooks.pre_tool_call[0]); expect(text).toContain('# user note') }
      else if (mutation.merge?.kind === 'json-managed-approvals') expect(parsed.approvals[0]).toEqual((original.get(mutation.path) as any).approvals[0])
      else expect(parsed.hooks.Stop[0]).toEqual((original.get(mutation.path) as any).hooks.Stop[0])
    }
  })
})
