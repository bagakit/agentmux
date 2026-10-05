import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from 'node:crypto'
import { link, lstat, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AgentMuxError } from './errors.js'
import { durableWriteFile } from './durable-write.js'
import { parseAgentMuxCreationAdmission, parseAgentMuxCreationOrigin, parseAgentMuxCreationTrust, parseAgentMuxCreationTrustInput,
  type AgentMuxCreationAdmission, type AgentMuxCreationAuthorityIdentity, type AgentMuxCreationOrigin,
  type AgentMuxCreationSource, type AgentMuxCreationTarget, type AgentMuxCreationTrust, type AgentMuxCreationTrustInput, type AgentMuxCreationUserPrincipal } from './agent-creation-admission.js'

const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const failure = (message: string, code: string): never => { throw new AgentMuxError(message, code) }
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

/** Canonical JSON intent hash; text bytes and array order are never normalized. */
export function agentCreationIntentDigest(value: unknown): string {
  const seen = new Set<object>()
  const canonical = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (item && typeof item === 'object' && !seen.has(item) &&
      (Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)) {
      seen.add(item)
      try {
        if (Array.isArray(item)) {
          if (Array.from({ length: item.length }, (_, index) => Object.hasOwn(item, index)).includes(false)) {
            return failure('Agent creation intent cannot contain sparse arrays.', 'AGENT_CREATION_INTENT_INVALID')
          }
          return item.map(canonical)
        }
        return Object.fromEntries(Object.keys(item).sort().filter(key => (item as Record<string, unknown>)[key] !== undefined)
          .map(key => [key, canonical((item as Record<string, unknown>)[key])]))
      } finally { seen.delete(item) }
    }
    return failure('Agent creation intent must contain finite JSON values.', 'AGENT_CREATION_INTENT_INVALID')
  }
  return hash(JSON.stringify(canonical(value)))
}

function publicKey(value: unknown): { key: KeyObject; encoded: string; fingerprint: string } {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/u.test(value)) return failure('Invalid Agent creation public key.', 'AGENT_CREATION_AUTHORITY_INVALID')
  try {
    const bytes = Buffer.from(value, 'base64url')
    const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' })
    const encoded = key.export({ format: 'der', type: 'spki' }).toString('base64url')
    if (key.asymmetricKeyType !== 'ed25519' || encoded !== value) throw new Error('Noncanonical key')
    return { key, encoded, fingerprint: hash(bytes) }
  } catch { return failure('Invalid Agent creation public key.', 'AGENT_CREATION_AUTHORITY_INVALID') }
}

/** Publish a complete immutable identity/pin without replacing a concurrent winner. */
async function publishFirst(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.pending`
  try {
    await durableWriteFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, requireDirectorySync: true })
    try { await link(temporary, path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const directory = await open(dirname(path), 'r')
    try { await directory.sync() } finally { await directory.close() }
  } finally { await unlink(temporary).catch(error => { if (!absent(error)) throw error }) }
}

/** One Runtime's lazy signing identity and explicit immutable source pins; no message queue lives here. */
export class AgentMuxCreationAuthority {
  private readonly identityPath: string
  private readonly trustDirectory: string
  private readonly runtimeId: string
  constructor(options: { stateDirectory: string; runtimeId: string }) {
    this.identityPath = join(options.stateDirectory, 'agent-creation-identity.json')
    this.trustDirectory = join(options.stateDirectory, 'agent-creation-trusted-sources')
    this.runtimeId = options.runtimeId
    if (!options.runtimeId || options.runtimeId.length > 256 || options.runtimeId.trim() !== options.runtimeId || /[\u0000-\u001f\u007f]/u.test(options.runtimeId)) {
      failure('Agent creation authority needs its original Runtime identity.', 'AGENT_CREATION_AUTHORITY_INVALID')
    }
  }
  private async loadIdentity(): Promise<{ identity: AgentMuxCreationAuthorityIdentity; privateKey: KeyObject }> {
    let raw: string
    try { raw = await readFile(this.identityPath, 'utf8') }
    catch (error) {
      if (!absent(error)) throw error
      const pair = generateKeyPairSync('ed25519')
      await publishFirst(this.identityPath, { schema: 'agentmux.agent-creation-authority.v1', runtimeId: this.runtimeId,
        publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
        privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url') })
      raw = await readFile(this.identityPath, 'utf8')
    }
    try {
      const attributes = await lstat(this.identityPath)
      if (!attributes.isFile() || (attributes.mode & 0o077) !== 0) throw new Error('Unprotected identity')
      const p = JSON.parse(raw) as Record<string, unknown>
      if (!p || typeof p !== 'object' || Object.keys(p).length !== 4 || p.schema !== 'agentmux.agent-creation-authority.v1' ||
        p.runtimeId !== this.runtimeId || typeof p.privateKey !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/u.test(p.privateKey)) throw new Error('Invalid identity')
      const pub = publicKey(p.publicKey)
      const privateKey = createPrivateKey({ key: Buffer.from(p.privateKey, 'base64url'), format: 'der', type: 'pkcs8' })
      if (privateKey.asymmetricKeyType !== 'ed25519' || privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url') !== p.privateKey ||
        createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64url') !== pub.encoded) throw new Error('Mismatched identity')
      return { identity: { runtimeId: this.runtimeId, publicKey: pub.encoded, fingerprint: pub.fingerprint }, privateKey }
    } catch { return failure('The original Agent creation identity cannot be verified. Its file was retained; restore that identity before creating a new attestation.', 'AGENT_CREATION_AUTHORITY_INVALID') }
  }
  async identity(): Promise<AgentMuxCreationAuthorityIdentity> { return (await this.loadIdentity()).identity }
  private trustPath(sourceRuntimeId: string): string { return join(this.trustDirectory, hash(sourceRuntimeId) + '.json') }
  private async readTrust(path: string): Promise<AgentMuxCreationTrust> {
    try {
      const trust = parseAgentMuxCreationTrust(JSON.parse(await readFile(path, 'utf8')))
      const pub = publicKey(trust.publicKey)
      if (trust.targetRuntimeId !== this.runtimeId || trust.fingerprint !== pub.fingerprint || path !== this.trustPath(trust.sourceRuntimeId)) throw new Error('Wrong trust scope')
      return trust
    } catch (error) {
      if (absent(error)) throw error
      return failure('The original Agent creation source pin cannot be verified. Its file was retained.', 'AGENT_CREATION_TRUST_INVALID')
    }
  }
  async trust(input: AgentMuxCreationTrustInput, principal: AgentMuxCreationUserPrincipal): Promise<AgentMuxCreationTrust> {
    if (!principal || principal.kind !== 'user') failure('Only the authenticated user can pin an Agent creation source.', 'AGENT_CREATION_TRUST_PERMISSION_REQUIRED')
    input = parseAgentMuxCreationTrustInput(input)
    const pub = publicKey(input.publicKey)
    const target = await this.identity()
    if (input.targetRuntimeId !== target.runtimeId || input.targetKeyFingerprint !== target.fingerprint) {
      failure('The target identity changed since approval. Review its current identity before trusting a source.', 'AGENT_CREATION_TARGET_MISMATCH')
    }
    const requested = parseAgentMuxCreationTrust({ sourceRuntimeId: input.sourceRuntimeId, publicKey: pub.encoded,
      fingerprint: pub.fingerprint, targetRuntimeId: this.runtimeId, registeredAt: Date.now(), registeredBy: principal })
    const path = this.trustPath(requested.sourceRuntimeId)
    let retained: AgentMuxCreationTrust
    try { retained = await this.readTrust(path) }
    catch (error) {
      if (!absent(error)) throw error
      await publishFirst(path, requested)
      retained = await this.readTrust(path)
    }
    if (retained.publicKey !== requested.publicKey) failure('This source Runtime already has another pinned key. The original pin was retained.', 'AGENT_CREATION_SOURCE_KEY_CONFLICT')
    return retained
  }
  async listTrusted(): Promise<AgentMuxCreationTrust[]> {
    let names: string[]
    try { names = await readdir(this.trustDirectory) } catch (error) { if (absent(error)) return []; throw error }
    return await Promise.all(names.filter(name => name.endsWith('.json')).sort().map(name => this.readTrust(join(this.trustDirectory, name))))
  }
  /** The caller's Core must authenticate source Session/Run before invoking this signing primitive. */
  async attest(source: Omit<AgentMuxCreationSource, 'runtimeId'>, target: AgentMuxCreationTarget): Promise<AgentMuxCreationAdmission> {
    const { identity, privateKey } = await this.loadIdentity()
    const admission = parseAgentMuxCreationAdmission({ schema: 'agentmux.agent-creation-admission.v1',
      source: { runtimeId: identity.runtimeId, agentSessionId: source.agentSessionId, runId: source.runId }, target, signature: 'A'.repeat(86) })
    const { signature: _, ...payload } = admission
    return { ...payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64url') }
  }
  async verify(value: AgentMuxCreationAdmission, target: AgentMuxCreationTarget): Promise<AgentMuxCreationOrigin> {
    const admission = parseAgentMuxCreationAdmission(value)
    if (target.runtimeId !== this.runtimeId || admission.target.runtimeId !== target.runtimeId || admission.target.intentDigest !== target.intentDigest) {
      failure('The signed creation intent belongs to another target or configuration.', 'AGENT_CREATION_TARGET_MISMATCH')
    }
    let trust: AgentMuxCreationTrust
    try { trust = await this.readTrust(this.trustPath(admission.source.runtimeId)) }
    catch (error) { if (absent(error)) failure('This Agent creation source has not been explicitly trusted by the target user.', 'AGENT_CREATION_SOURCE_UNTRUSTED'); throw error }
    const { signature, ...payload } = admission
    const bytes = Buffer.from(signature, 'base64url')
    if (bytes.toString('base64url') !== signature || !verify(null, Buffer.from(JSON.stringify(payload)), publicKey(trust.publicKey).key, bytes)) {
      failure('The Agent creation source signature could not be verified.', 'AGENT_CREATION_ADMISSION_INVALID')
    }
    return parseAgentMuxCreationOrigin({ source: admission.source, proofFingerprint: agentCreationIntentDigest(admission),
      verifiedBy: { runtimeId: admission.source.runtimeId, keyFingerprint: trust.fingerprint }, delegatedBy: trust })
  }
}
