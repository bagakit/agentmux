import { fixturePath } from './helpers/fixture-values.js'
import { describe, expect, it, vi } from 'vitest'
import { parseGitParams, parseGitResult, parseGitOpenResult, type AgentMuxRpcGitOwner } from '../src/public-rpc-git.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { parseAgentMuxControlRequest, parseAgentMuxControlReceipt } from '../src/control-codec.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { assertControlResultTarget } from '../src/rpc-business-codec.js'
import { AGENTMUX_CLI_COMMANDS, parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { AGENTMUX_CLI_HELP, AGENTMUX_CLI_SKILL, agentMuxCommandHelp } from '../src/agentmux-cli-help.js'
import type { GitCommitDetailsResult } from '@agentmux/git/types'

const oid = 'a'.repeat(40), parent = 'b'.repeat(40)
const target = { workspaceId: 'original-workspace', expectedResource: { hostId: 'local', workspacePath: fixturePath("original/subfolder") } }
const snapshot = { hostId: 'local', repoPath: fixturePath("original"), commitOid: oid, parentOid: parent }
const details: Extract<GitCommitDetailsResult, { kind: 'ready' }> = { kind: 'ready', snapshot,
  commit: { oid, parents: [parent], subject: 'Full title', message: 'Full title\n\n完整正文\nline two\n', author: 'Author', authoredAt: 1,
    committer: 'Committer', committedAt: 2, refs: [] },
  entries: [{ path: 'new\nname 中文.txt', origPath: 'old name.txt', change: 'renamed' }], warnings: [] }
const input = { kind: 'commit' as const, snapshot, file: { path: details.entries[0]!.path, origPath: details.entries[0]!.origPath } }

describe('public Git target and result contracts', () => {
  it('retains full message and legal newline paths while refusing implicit or unbound reads', () => {
    expect(parseGitResult('git.commit', details, parseGitParams('git.commit', { ...target, oid }))).toBe(details)
    expect(parseGitParams('git.diff', { ...target, input }).input.file.path).toBe('new\nname 中文.txt')
    for (const bad of [{ ...target, oid: 'HEAD' }, { ...target, oid: oid.slice(0, 8) }, { ...target, oid, workspaceId: 'self' },
      { ...target, oid, expectedResource: { hostId: 'local' } }, { ...target, oid, force: true }])
      expect(() => parseGitParams('git.commit', bad)).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
    for (const bad of [
      { ...target, input: { ...input, snapshot: { ...snapshot, hostId: 'another' } } },
      { ...target, input: { ...input, file: { path: '../escape', origPath: null } } },
      { ...target, input: { ...input, file: { path: 'new', origPath: undefined } } }
    ]) expect(() => parseGitParams('git.diff', bad)).toThrow()
  })
  it('rejects a foreign parent, OID or Host and preserves a plain folder result', () => {
    const params = { ...target, oid }
    for (const result of [{ ...details, snapshot: { ...snapshot, hostId: 'other' } },
      { ...details, snapshot: { ...snapshot, commitOid: parent } }, { ...details, snapshot: { ...snapshot, parentOid: null } },
      { ...details, commit: { ...details.commit, parents: [] } }])
      expect(() => parseGitResult('git.commit', result, params)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    const plain = { kind: 'not-a-git-repository' as const, ...target.expectedResource }
    expect(parseGitResult('git.commit', plain, params)).toBe(plain)
    expect(() => parseGitResult('git.commit', { ...plain, workspacePath: fixturePath("other") }, params)).toThrow()
    expect(() => parseRpcNativeResult('git.commit', { ...details, snapshot: { ...snapshot, commitOid: parent } }, params)).toThrow()
  })
  it('binds continuation to the original roots and exact next offset', () => {
    const scope = { hostId: 'local', repoPath: fixturePath("original"), selectedRef: null, roots: [oid], refs: [], checkedAt: 1 }
    const { message: _message, committer: _committer, committedAt: _time, ...historyCommit } = details.commit
    const page = { kind: 'ready', snapshot: scope, commits: [historyCommit], nextCursor: { snapshot: scope, offset: 1 } }
    expect(parseGitResult('git.history', page, target)).toBe(page)
    const next = { ...target, cursor: page.nextCursor }
    expect(parseGitResult('git.history', { ...page, commits: [], nextCursor: null }, next)).toMatchObject({ commits: [] })
    expect(() => parseGitResult('git.history', { ...page, nextCursor: { snapshot: scope, offset: 2 } }, target)).toThrow()
    expect(() => parseGitResult('git.history', { ...page, snapshot: { ...scope, roots: [parent] } }, next)).toThrow()
    expect(() => parseGitParams('git.history', { ...next, ref: 'refs/heads/other' })).toThrow()
  })
  it('uses the existing Control receipt and separates the pinned read from exact placement', () => {
    const request = parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'open-exact', operation: 'open.git', ...target, oid })
    const result = { workspaceId: target.workspaceId, read: { kind: 'ready' as const, snapshot }, presentation: { tabId: 'git-tab', regionId: 'git-region' } }
    expect(parseGitOpenResult(result, { ...target, oid })).toBe(result)
    expect(parseAgentMuxControlReceipt({ schemaVersion: 5, requestId: 'open-exact', ok: true, operation: 'open.git', result })).toMatchObject({ ok: true, result })
    assertControlResultTarget(request, { operation: 'open.git', ...result })
    expect(() => assertControlResultTarget(request, { operation: 'open.git', ...result, workspaceId: 'another' })).toThrow()
    expect(() => parseGitOpenResult({ ...result, presentation: { tabId: 'git-tab' } })).toThrow()
    expect(() => parseAgentMuxControlRequest({ ...request, checkout: true })).toThrow()
  })
  it('delegates to the original owner and keeps malformed result or owner absence explicit', async () => {
    const call = vi.fn(async () => details)
    const service = new AgentMuxRpcService({ git: { call } as AgentMuxRpcGitOwner })
    expect(await service.call('git.commit', { ...target, oid })).toBe(details)
    expect(call).toHaveBeenCalledWith('git.commit', { ...target, oid }, expect.any(Object))
    call.mockResolvedValue({ ...details, snapshot: { ...snapshot, commitOid: parent } })
    await expect(service.call('git.commit', { ...target, oid })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    await expect(new AgentMuxRpcService({}).call('git.history', target)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    const prior = call.mock.calls.length
    await expect(service.call('git.commit', { ...target, oid: 'HEAD' })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    expect(call.mock.calls).toHaveLength(prior)
  })
  it('generates target discovery, required flags and readonly/presentation guidance from registered commands', async () => {
    const args = ['--workspace', target.workspaceId, '--host', 'local', '--workspace-path', target.expectedResource.workspacePath]
    expect((await parseAgentMuxCliInvocation(['git', 'commit', ...args, '--oid', oid])).params).toEqual({ ...target, oid })
    for (const method of ['git.history', 'git.commit', 'git.diff', 'git.open']) {
      expect(AGENTMUX_CLI_COMMANDS.filter(command => command.method === method)).toHaveLength(1)
      expect(agentMuxCommandHelp(method)).toContain('--workspace ID --host ID --workspace-path PATH')
      expect(AGENTMUX_CLI_HELP).toContain('agentmux ' + method.replace('.', ' '))
    }
    expect(AGENTMUX_CLI_SKILL).toContain('Reading never checks out, stages or writes Git')
    expect(agentMuxCommandHelp('git.open')).toContain('read and presentation are separate facts')
    await expect(parseAgentMuxCliInvocation(['git', 'commit', '--oid', oid])).rejects.toThrow()
  })
})
