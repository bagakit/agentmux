import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { parseFocusTaskReference, parseFocusParams, type AgentMuxFocusTaskReference } from '../src/focus-control.js'
import { focusTaskReadInputs, focusReadCommand, focusTaskHandoffNote } from '../src/focus-task-guidance.js'
import { agentMuxModuleSkill, agentMuxCliModuleCatalog } from '../src/agentmux-cli-module-skills.js'
import { guideSharedFocusTaskHandoff } from '../src/generated/agentmux-guides.js'
import { ObjectCliProbe } from './helpers/object-cli-rpc.js'

const scope = { kind: 'project' as const, hostId: 'original-host', projectSpaceId: 'original-project' }
const member = (contextId: string) => ({ hostId: scope.hostId, contextId })
const task: AgentMuxFocusTaskReference = { scope, selection: { kind: 'members', references: [member('context-original')] } }
const page = { schemaVersion: 1, source: { clientId: 'original-client', rendererId: 'original-renderer', documentGeneration: 1 },
  readAt: 1, status: 'observed', items: [], nextCursor: null,
  coverage: { complete: true, total: 0, selected: 0, returned: 0, sourceStatuses: [] }, issues: [] }
const probe = new ObjectCliProbe(request => {
  if (request.method === 'focus.ls') return { ...page, items: [{ scope, name: 'Original project', identityStatus: 'confirmed', memberCount: 1 }],
    coverage: { ...page.coverage, total: 1, selected: 1, returned: 1 } }
  if (request.method === 'focus.read') return { ...page, scope: request.params.scope, selection: request.params.selection, status: 'unconfirmed',
    issues: [{ code: 'MEMBER_UNCONFIRMED', message: 'Original selected member is not currently observed.' }] }
  throw Error('Unexpected public method ' + request.method)
})
let root = '', executable = ''
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
beforeAll(async () => {
  await probe.start(); root = await mkdtemp(join(tmpdir(), 'focus-cli-')); executable = join(root, 'original cli')
  await writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(process.env.AGENTMUX_FOCUS_TEST_CLI!)} --endpoint ${quote('unix:' + probe.socketPath)} "$@"\n`, { mode: 0o700 })
})
afterAll(async () => { await probe.stop(); if (root) await rm(root, { recursive: true, force: true }) })
function run(args: string[], input = '', shell = false) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(shell ? '/bin/sh' : process.execPath, shell ? ['-c', args[0]!] : [process.env.AGENTMUX_FOCUS_TEST_CLI!, '--endpoint', 'unix:' + probe.socketPath, ...args],
      { env: probe.environment({ AGENTMUX_CLI: executable }), stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(Error('Private Focus CLI exceeded its test deadline')) }, 15000)
    child.stdout.setEncoding('utf8').on('data', data => { stdout += data }); child.stderr.setEncoding('utf8').on('data', data => { stderr += data })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) }); child.stdin.on('error', () => {}); child.stdin.end(input)
  })
}

it('keeps every logical reference in exact bounded reads without collapsing Hosts or mutating the task', () => {
  const input: AgentMuxFocusTaskReference = { scope, selection: { kind: 'members', references: [
    ...Array.from({ length: 600 }, (_, i) => member('context-' + i)), member('context-1'), { hostId: 'other-host', contextId: 'context-1' }
  ] } }
  const before = structuredClone(input), normalized = parseFocusTaskReference(input), reads = focusTaskReadInputs(input)
  expect(reads.map(read => read.selection.kind === 'members' ? read.selection.references.length : -1)).toEqual([256, 256, 89])
  expect(reads.flatMap(read => read.selection.kind === 'members' ? read.selection.references : [])).toEqual(normalized.selection.kind === 'members' ? normalized.selection.references : [])
  expect(reads.every(read => JSON.stringify(read.scope) === JSON.stringify(scope))).toBe(true); expect(input).toEqual(before)
  expect(() => parseFocusParams('focus.read', input)).toThrowError(/at most 256/)
})

it('keeps an explicit empty cohort distinct from all and never guesses an unconfirmed Collection identity', () => {
  const collection = { kind: 'collection' as const, hostId: 'original-host', categorySpaceIds: [] }
  expect(focusTaskReadInputs({ scope: collection, selection: { kind: 'members', references: [] } })).toEqual([{ scope: collection, selection: { kind: 'members', references: [] } }])
  expect(focusTaskReadInputs({ scope, selection: { kind: 'all' } })).toEqual([{ scope, selection: { kind: 'all' } }])
})

it('formats hostile reference data as exact stdin for the real CLI without shell interpretation', async () => {
  const input = { scope: { ...scope, projectSpaceId: "project'$(printf INJECTED)\n`printf LOST`" },
    selection: { kind: 'members' as const, references: [member('context" $HOME \\ ; | end')] }, limit: 1, cursor: "cursor'$(printf WRONG)" }
  const before = probe.requests.length, result = await run([focusReadCommand(input)], '', true)
  expect(result.code, result.stderr).toBe(0)
  expect(probe.requests.slice(before)).toHaveLength(1)
  expect(probe.requests.at(-1)?.params).toEqual(parseFocusParams('focus.read', input))
  expect(JSON.parse(result.stdout).result.selection).toEqual(input.selection)
})

it('hands off same-source guidance and every exact batch without a wire envelope or card snapshot', () => {
  const input = { scope, selection: { kind: 'members' as const, references: Array.from({ length: 257 }, (_, i) => member('reference-' + i)) } }
  const note = focusTaskHandoffNote(input)
  expect(note.startsWith(guideSharedFocusTaskHandoff.text)).toBe(true)
  const commands = note.split('\n').filter(line => line.startsWith("printf '%s'"))
  expect(commands).toEqual(focusTaskReadInputs(input).map(focusReadCommand)); expect(commands).toHaveLength(2)
  expect(note).not.toContain('<amux>'); expect(note).not.toContain('cardFacts'); expect(note).toContain('not a Dispatch')
  expect(() => focusTaskHandoffNote({ ...task, cards: [] } as AgentMuxFocusTaskReference)).toThrow()
})

it('discovers the registered Focus module through actual CLI directory, local skill and leaf help without RPC', async () => {
  const before = probe.requests.length
  const directory = await run(['--skill']), skill = await run(['focus', '--skill']), help = await run(['focus', 'read', '--help'])
  for (const output of [directory, skill, help]) expect(output.code, output.stderr).toBe(0)
  expect(directory.stdout).toContain('amux focus --skill'); expect(skill.stdout.trim()).toBe(agentMuxModuleSkill('focus')!.trim())
  expect(skill.stdout).toContain('256 exact references'); expect(skill.stdout).toContain('amux focus read --input FILE|-')
  expect(help.stdout).toContain('scope'); expect(help.stdout).toContain('members'); expect(help.stdout).toContain('Module guide (local, read-only): amux focus --skill')
  expect(agentMuxCliModuleCatalog().find(entry => entry.root === 'focus')?.summary).toBe('Read current Focus groups and exact selected members')
  expect(probe.requests).toHaveLength(before)
})

it('routes actual list flags and exact read file/stdin to the original public methods', async () => {
  const before = probe.requests.length, path = join(root, 'exact-read.json')
  await writeFile(path, JSON.stringify(task))
  for (const output of [await run(['focus', 'ls', '--limit', '1', '--cursor', 'original-cursor']),
    await run(['focus', 'read', '--input', path]), await run(['focus', 'read', '--input', '-'], JSON.stringify(task))]) {
    expect(output.code, output.stderr).toBe(0); expect(JSON.parse(output.stdout).ok).toBe(true)
  }
  expect(probe.requests.slice(before).map(({ method, params }) => ({ method, params }))).toEqual([
    { method: 'focus.ls', params: { limit: 1, cursor: 'original-cursor' } },
    { method: 'focus.read', params: task }, { method: 'focus.read', params: task }
  ])
})

it('rejects malformed scopes, forged card facts and oversized individual reads before any RPC', async () => {
  const before = probe.requests.length
  const invalid = [{ ...task, scope: { kind: 'project', hostId: 'original-host' } }, { ...task, facts: [] },
    { ...task, selection: { kind: 'members', references: Array.from({ length: 257 }, (_, i) => member('member-' + i)) } }]
  for (const input of invalid) {
    const result = await run(['focus', 'read', '--input', '-'], JSON.stringify(input))
    expect(result.code).toBe(1); expect(JSON.parse(result.stderr).ok).toBe(false)
  }
  expect(probe.requests).toHaveLength(before)
})

it('returns original unconfirmed read coverage and issues without inventing a healthy Agent control reference', async () => {
  const result = await run(['focus', 'read', '--input', '-'], JSON.stringify(task))
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).result).toMatchObject({ status: 'unconfirmed', ...task, items: [],
    coverage: { complete: true, returned: 0 }, issues: [{ code: 'MEMBER_UNCONFIRMED' }] })
})
