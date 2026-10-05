import { fixturePath } from './helpers/fixture-values.js'
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as originalAuthority from '../src/agent-creation-authority.js'
import { parseAgentMuxCreationAdmission, parseAgentMuxCreationOrigin, parseAgentMuxCreationTrust } from '../src/agent-creation-admission.js'

const { AgentMuxCreationAuthority, agentCreationIntentDigest }: typeof originalAuthority = process.env.AGENTMUX_TEST_CREATION_AUTHORITY_ENTRY
  ? await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_CREATION_AUTHORITY_ENTRY) : originalAuthority

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'amx-creation-authority-'))
  directories.push(directory)
  const sourceDirectory = join(directory, 'source'), targetDirectory = join(directory, 'target')
  const source = new AgentMuxCreationAuthority({ stateDirectory: sourceDirectory, runtimeId: 'source-runtime' })
  const target = new AgentMuxCreationAuthority({ stateDirectory: targetDirectory, runtimeId: 'target-runtime' })
  const intent = { agentSessionId: 'new-session', createOperationId: 'create-once', workspacePath: fixturePath("remote/project"),
    executorId: 'registered-wrapper', configRevision: 'frozen-revision', prompt: 'Original task\nSecond line\n',
    launchOptions: { permission: 'ask' }, cols: 100, rows: 40 }
  const destination = { runtimeId: 'target-runtime', intentDigest: agentCreationIntentDigest(intent) }
  const sender = { agentSessionId: 'source-session', runId: 'source-run' }
  const targetBinding = async () => { const identity = await target.identity(); return { targetRuntimeId: identity.runtimeId, targetKeyFingerprint: identity.fingerprint } }
  return { targetBinding, source, target, sourceDirectory, targetDirectory, intent, destination, sender }
}

describe('Runtime-scoped Agent creation authority', () => {
  it('rejects a target Runtime or key change between review and approval without publishing a pin', async () => {
    const f = await fixture(), source = await f.source.identity(), binding = await f.targetBinding()
    const input = { ...binding, sourceRuntimeId: source.runtimeId, publicKey: source.publicKey }
    for (const wrong of [{ ...input, targetRuntimeId: 'another-target' }, { ...input, targetKeyFingerprint: '0'.repeat(64) }]) {
      await expect(f.target.trust(wrong, { kind: 'user', id: 'user' })).rejects.toMatchObject({ code: 'AGENT_CREATION_TARGET_MISMATCH' })
      expect(await f.target.listTrusted()).toEqual([])
    }
    await expect(f.target.trust({ sourceRuntimeId: source.runtimeId, publicKey: source.publicKey } as never,
      { kind: 'user', id: 'user' })).rejects.toMatchObject({ code: 'AGENT_CREATION_PROVENANCE_INVALID' })
    const other = new AgentMuxCreationAuthority({ stateDirectory: join(f.targetDirectory, '..', 'replacement'), runtimeId: 'target-runtime' })
    await other.identity()
    const replacement = await readFile(join(f.targetDirectory, '..', 'replacement', 'agent-creation-identity.json'))
    await writeFile(join(f.targetDirectory, 'agent-creation-identity.json'), replacement)
    await expect(f.target.trust(input, { kind: 'user', id: 'user' })).rejects.toMatchObject({ code: 'AGENT_CREATION_TARGET_MISMATCH' })
    expect(await f.target.listTrusted()).toEqual([])
    expect(await readFile(join(f.targetDirectory, 'agent-creation-identity.json'))).toEqual(replacement)
  })
  it('is lazy and publishes one protected signing identity across concurrent owners', async () => {
    const f = await fixture()
    expect(await readdir(join(f.sourceDirectory, '..'))).toEqual([])
    expect(await f.target.listTrusted()).toEqual([])
    const identities = await Promise.all(Array.from({ length: 8 }, () =>
      new AgentMuxCreationAuthority({ stateDirectory: f.sourceDirectory, runtimeId: 'source-runtime' }).identity()))
    expect(identities.every(identity => JSON.stringify(identity) === JSON.stringify(identities[0]))).toBe(true)
    expect(Object.keys(identities[0]!).sort()).toEqual(['fingerprint', 'publicKey', 'runtimeId'])
    expect((await stat(join(f.sourceDirectory, 'agent-creation-identity.json'))).mode & 0o777).toBe(0o600)
    expect(await readdir(f.sourceDirectory)).toEqual(['agent-creation-identity.json'])
  })

  it('requires an explicit user pin and preserves verified source and delegator across reloads', async () => {
    const f = await fixture()
    const admission = await f.source.attest(f.sender, f.destination)
    await expect(f.target.verify(admission, f.destination)).rejects.toMatchObject({ code: 'AGENT_CREATION_SOURCE_UNTRUSTED' })
    const identity = await f.source.identity()
    const trust = await f.target.trust({ ...await f.targetBinding(), sourceRuntimeId: identity.runtimeId, publicKey: identity.publicKey }, { kind: 'user', id: 'target-user' })
    const reloaded = new AgentMuxCreationAuthority({ stateDirectory: f.targetDirectory, runtimeId: 'target-runtime' })
    const origin = await reloaded.verify(admission, f.destination)
    expect(origin).toEqual({ source: { runtimeId: 'source-runtime', ...f.sender },
      proofFingerprint: agentCreationIntentDigest(admission), verifiedBy: { runtimeId: 'source-runtime', keyFingerprint: identity.fingerprint }, delegatedBy: trust })
    expect(origin.delegatedBy).toMatchObject({ targetRuntimeId: 'target-runtime', registeredBy: { kind: 'user', id: 'target-user' } })
    expect(await reloaded.listTrusted()).toEqual([trust])
    expect(await f.source.attest(f.sender, f.destination)).toEqual(admission)
    expect(JSON.stringify(origin)).not.toContain('privateKey')
  })

  it('rejects tampered source, target and signature before returning provenance', async () => {
    const f = await fixture(), identity = await f.source.identity()
    await f.target.trust({ ...await f.targetBinding(), sourceRuntimeId: identity.runtimeId, publicKey: identity.publicKey }, { kind: 'user', id: 'target-user' })
    const admission = await f.source.attest(f.sender, f.destination)
    for (const source of [{ ...admission.source, agentSessionId: 'forged-author' }, { ...admission.source, runId: 'other-run' }]) {
      await expect(f.target.verify({ ...admission, source }, f.destination)).rejects.toMatchObject({ code: 'AGENT_CREATION_ADMISSION_INVALID' })
    }
    await expect(f.target.verify({ ...admission, source: { ...admission.source, runtimeId: 'untrusted-runtime' } }, f.destination))
      .rejects.toMatchObject({ code: 'AGENT_CREATION_SOURCE_UNTRUSTED' })
    await expect(f.target.verify({ ...admission, signature: 'A'.repeat(86) }, f.destination)).rejects.toMatchObject({ code: 'AGENT_CREATION_ADMISSION_INVALID' })
    await expect(f.target.verify(admission, { ...f.destination, runtimeId: 'other-runtime' })).rejects.toMatchObject({ code: 'AGENT_CREATION_TARGET_MISMATCH' })
    await expect(f.target.verify({ ...admission, target: { ...f.destination, runtimeId: 'other-runtime' } }, f.destination))
      .rejects.toMatchObject({ code: 'AGENT_CREATION_TARGET_MISMATCH' })
    for (const change of [{ configRevision: 'new-command' }, { prompt: 'Original task\nSecond line' }, { executorId: 'other-executor' },
      { workspacePath: fixturePath("other") }, { createOperationId: 'another-operation' }, { agentSessionId: 'other-target' }, { launchOptions: { permission: 'auto' } }]) {
      await expect(f.target.verify(admission, { ...f.destination, intentDigest: agentCreationIntentDigest({ ...f.intent, ...change }) }))
        .rejects.toMatchObject({ code: 'AGENT_CREATION_TARGET_MISMATCH' })
    }
  })

  it('retains the first user receipt and rejects a replacement key without rewriting it', async () => {
    const f = await fixture(), identity = await f.source.identity()
    const request = { ...await f.targetBinding(), sourceRuntimeId: identity.runtimeId, publicKey: identity.publicKey }
    const first = await f.target.trust(request, { kind: 'user', id: 'original-user' })
    const directory = join(f.targetDirectory, 'agent-creation-trusted-sources')
    const path = join(directory, (await readdir(directory))[0]!)
    const original = await readFile(path)
    const contenders = await Promise.all(Array.from({ length: 6 }, () =>
      new AgentMuxCreationAuthority({ stateDirectory: f.targetDirectory, runtimeId: 'target-runtime' }).trust(request, { kind: 'user', id: 'later-user' })))
    expect(contenders).toEqual(Array(6).fill(first))
    const otherKey = (await f.target.identity()).publicKey
    await expect(f.target.trust({ ...request, publicKey: otherKey }, { kind: 'user', id: 'later-user' }))
      .rejects.toMatchObject({ code: 'AGENT_CREATION_SOURCE_KEY_CONFLICT' })
    expect(await readFile(path)).toEqual(original)
  })

  it('rejects a device before creating a trust directory and refuses malformed keys', async () => {
    const f = await fixture(), identity = await f.source.identity()
    await expect(f.target.trust({ targetRuntimeId: 'target-runtime', targetKeyFingerprint: 'a'.repeat(64), sourceRuntimeId: identity.runtimeId, publicKey: identity.publicKey }, { kind: 'device', id: 'forged-user' } as never))
      .rejects.toMatchObject({ code: 'AGENT_CREATION_TRUST_PERMISSION_REQUIRED' })
    await expect(stat(f.targetDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(f.target.trust({ targetRuntimeId: 'target-runtime', targetKeyFingerprint: 'a'.repeat(64), sourceRuntimeId: identity.runtimeId, publicKey: 'not-an-ed25519-key' }, { kind: 'user', id: 'target-user' }))
      .rejects.toMatchObject({ code: 'AGENT_CREATION_AUTHORITY_INVALID' })
    await expect(stat(f.targetDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('pins exactly one key when conflicting first registrations race', async () => {
    const f = await fixture(), firstKey = (await f.source.identity()).publicKey, secondKey = (await f.target.identity()).publicKey
    const secondTarget = new AgentMuxCreationAuthority({ stateDirectory: f.targetDirectory, runtimeId: 'target-runtime' })
    const results = await Promise.allSettled([
      f.target.trust({ ...await f.targetBinding(), sourceRuntimeId: 'source-runtime', publicKey: firstKey }, { kind: 'user', id: 'first-user' }),
      secondTarget.trust({ ...await f.targetBinding(), sourceRuntimeId: 'source-runtime', publicKey: secondKey }, { kind: 'user', id: 'second-user' })
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'AGENT_CREATION_SOURCE_KEY_CONFLICT' }) })
    ])
    const winner = results.find(result => result.status === 'fulfilled')
    expect(await f.target.listTrusted()).toEqual([winner!.status === 'fulfilled' ? winner!.value : undefined])
    expect((await readdir(join(f.targetDirectory, 'agent-creation-trusted-sources'))).filter(name => name.endsWith('.pending'))).toEqual([])
  })

  it('keeps corrupt key bytes, Runtime mismatches and insecure permissions intact', async () => {
    const f = await fixture()
    await f.source.identity()
    const path = join(f.sourceDirectory, 'agent-creation-identity.json'), original = await readFile(path)
    const wrongRuntime = new AgentMuxCreationAuthority({ stateDirectory: f.sourceDirectory, runtimeId: 'replacement-runtime' })
    await expect(wrongRuntime.identity()).rejects.toMatchObject({ code: 'AGENT_CREATION_AUTHORITY_INVALID' })
    expect(await readFile(path)).toEqual(original)
    await chmod(path, 0o644)
    await expect(f.source.identity()).rejects.toMatchObject({ code: 'AGENT_CREATION_AUTHORITY_INVALID' })
    expect(await readFile(path)).toEqual(original)
    await chmod(path, 0o600)
    await writeFile(path, '{corrupt original key')
    await expect(f.source.attest(f.sender, f.destination)).rejects.toMatchObject({ code: 'AGENT_CREATION_AUTHORITY_INVALID' })
    expect(await readFile(path, 'utf8')).toBe('{corrupt original key')
  })

  it('preserves invalid trust bytes and never silently recreates a damaged pin', async () => {
    const f = await fixture(), identity = await f.source.identity()
    const request = { ...await f.targetBinding(), sourceRuntimeId: identity.runtimeId, publicKey: identity.publicKey }
    await f.target.trust(request, { kind: 'user', id: 'target-user' })
    const directory = join(f.targetDirectory, 'agent-creation-trusted-sources'), path = join(directory, (await readdir(directory))[0]!)
    await writeFile(path, '{damaged pin')
    await expect(f.target.listTrusted()).rejects.toMatchObject({ code: 'AGENT_CREATION_TRUST_INVALID' })
    await expect(f.target.trust(request, { kind: 'user', id: 'replacement-user' })).rejects.toMatchObject({ code: 'AGENT_CREATION_TRUST_INVALID' })
    expect(await readFile(path, 'utf8')).toBe('{damaged pin')
  })

  it('does not accept a disk pin copied from another target Runtime', async () => {
    const f = await fixture(), identity = await f.source.identity()
    await f.target.trust({ ...await f.targetBinding(), sourceRuntimeId: identity.runtimeId, publicKey: identity.publicKey }, { kind: 'user', id: 'target-user' })
    const wrongRuntime = new AgentMuxCreationAuthority({ stateDirectory: f.targetDirectory, runtimeId: 'replacement-runtime' })
    await expect(wrongRuntime.listTrusted()).rejects.toMatchObject({ code: 'AGENT_CREATION_TRUST_INVALID' })
  })

  it('uses exact JSON intent, rejects non-JSON values, and only parses correlated durable origins', async () => {
    expect(agentCreationIntentDigest({ b: ['two', 'one'], a: 'line\n', optional: undefined })).toBe(agentCreationIntentDigest({ a: 'line\n', b: ['two', 'one'] }))
    expect(agentCreationIntentDigest('line\n')).not.toBe(agentCreationIntentDigest('line'))
    expect(agentCreationIntentDigest(['one', 'two'])).not.toBe(agentCreationIntentDigest(['two', 'one']))
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    for (const value of [cyclic, { invalid: Infinity }, [undefined], new Array(1), new Date(), { bigint: 1n }]) {
      expect(() => agentCreationIntentDigest(value)).toThrowError(expect.objectContaining({ code: 'AGENT_CREATION_INTENT_INVALID' }))
    }
    const f = await fixture(), identity = await f.source.identity()
    const trust = await f.target.trust({ ...await f.targetBinding(), sourceRuntimeId: identity.runtimeId, publicKey: identity.publicKey }, { kind: 'user', id: 'target-user' })
    const admission = await f.source.attest(f.sender, f.destination), origin = await f.target.verify(admission, f.destination)
    expect(parseAgentMuxCreationTrust(trust)).toEqual(trust)
    expect(parseAgentMuxCreationAdmission(admission)).toEqual(admission)
    expect(parseAgentMuxCreationOrigin(origin)).toEqual(origin)
    for (const value of [{ ...origin, verifiedAuthor: true }, { ...origin, source: { ...origin.source, runtimeId: 'another-runtime' } },
      { ...origin, verifiedBy: { ...origin.verifiedBy, keyFingerprint: '0'.repeat(64) } }]) {
      expect(() => parseAgentMuxCreationOrigin(value)).toThrowError(expect.objectContaining({ code: 'AGENT_CREATION_PROVENANCE_INVALID' }))
    }
  })
})
