import { mintObjectId } from './object-id.js'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'
import { link, lstat, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AgentMuxError } from './errors.js'
import { durableWriteFile } from './durable-write.js'
import { immutableIdentityFile } from './immutable-identity-file.js'
import { parseHostRouteEnvelope, parseHostRouteCall, parseHostRouteExecutionAuthorization, type HostRouteExecutionAuthorization, type HostRouteEnvelope, type HostRouteIdentity, type HostRouteStatement, type HostRouteCall } from './host-route.js'
import { assertExecutionChild, assertExecutionParent } from './host-route-execution.js'
import { parseMessageProvenance, parseMessageReadAuthority, parseRecipientInboxReceipt, type AgentMuxMessageParticipant, type AgentMuxMessageProvenance, type AgentMuxMessageReadAuthority, type AgentMuxMessageTrust, type AgentMuxRecipientInboxReceipt } from './agent-message-federation.js'
import { parseAgentMuxCreationAdmission, parseAgentMuxCreationOrigin, parseAgentMuxCreationTrust, parseAgentMuxCreationTrustInput,
  type AgentMuxCreationAdmission, type AgentMuxCreationAuthorityIdentity, type AgentMuxCreationOrigin,
  type AgentMuxCreationSource, type AgentMuxCreationTarget, type AgentMuxCreationTrust, type AgentMuxCreationTrustInput, type AgentMuxCreationUserPrincipal } from './agent-creation-admission.js'

const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const failure = (message: string, code: string, cause?: unknown): never => {
  const error = new AgentMuxError(message, code)
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause })
  throw error
}
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

/** Pure validation of the retained signer. Reading a witness grants no signing authority. */
export function parseOriginalCreationIdentity(bytes: string) {
  const p = JSON.parse(bytes) as Record<string, unknown>
  if (!p || typeof p !== 'object' || Object.keys(p).length !== 4 || p.schema !== 'agentmux.agent-creation-authority.v1' ||
    typeof p.runtimeId !== 'string' || !p.runtimeId || typeof p.privateKey !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/u.test(p.privateKey))
    throw new AgentMuxError('The original Agent creation identity cannot be verified.', 'AGENT_CREATION_AUTHORITY_INVALID')
  const pub = publicKey(p.publicKey)
  const privateKey = createPrivateKey({ key: Buffer.from(p.privateKey, 'base64url'), format: 'der', type: 'pkcs8' })
  if (privateKey.asymmetricKeyType !== 'ed25519' || privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url') !== p.privateKey ||
    createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64url') !== pub.encoded)
    throw new AgentMuxError('The original Agent creation key pair does not match.', 'AGENT_CREATION_AUTHORITY_INVALID')
  return { schema: 'agentmux.agent-creation-authority.v1' as const, runtimeId: p.runtimeId, publicKey: pub.encoded, privateKey: p.privateKey }
}

/** Target-host receipt only; it grants no Agent authorship or source-message trust. */
export function verifyAgentMessageInboxReceipt(value: AgentMuxRecipientInboxReceipt): AgentMuxRecipientInboxReceipt {
  const receipt = parseRecipientInboxReceipt(value), key = publicKey(receipt.publicKey)
  const { signature, ...payload } = receipt, bytes = Buffer.from(signature, 'base64url')
  if (key.fingerprint !== receipt.keyFingerprint || bytes.toString('base64url') !== signature ||
    !verify(null, Buffer.from(JSON.stringify(payload)), key.key, bytes)) failure('The exact recipient Core inbox receipt signature is invalid.', 'AGENT_MESSAGE_RECEIPT_INVALID')
  return receipt
}

/** Publish a complete immutable identity/pin without replacing a concurrent winner. */
async function publishFirst(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${mintObjectId()}.pending`
  try {
    await durableWriteFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, requireDirectorySync: true })
    try { await link(temporary, path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const directory = await open(dirname(path), 'r')
    try { await directory.sync() } finally { await directory.close() }
  } finally { await unlink(temporary).catch(error => { if (!absent(error)) throw error }) }
}

function hostRouteEndorsementPayload(envelope: HostRouteEnvelope, index: number) {
  return { schema: 'agentmux.host-route-endorsement.v1', purpose: 'host-route',
    statementDigest: agentCreationIntentDigest(envelope.statement),
    previousDigest: agentCreationIntentDigest({ statement: envelope.statement, signature: envelope.signature, endorsements: envelope.endorsements.slice(0, index) }),
    index, from: index === 0 ? envelope.statement.route.source : envelope.statement.route.hops[index - 1]!.target,
    target: envelope.statement.route.hops[index]!.target }
}
/** Verify the complete original statement and every narrowing hop before owner dispatch. */
export function verifyHostRouteSignatures(value: HostRouteEnvelope, receiver: HostRouteIdentity): HostRouteEnvelope {
  const envelope = parseHostRouteEnvelope(value), { statement } = envelope
  const nodes = [statement.route.source, ...statement.route.hops.map(hop => hop.target)]
  const keys = nodes.map(node => {
    const key = publicKey(node.publicKey)
    if (key.fingerprint !== node.fingerprint) failure('The adopted Runtime key fingerprint changed.', 'HOST_ROUTE_KEY_MISMATCH')
    return key
  })
  const signature = (payload: unknown, text: string, index: number) => {
    const bytes = Buffer.from(text, 'base64url')
    if (bytes.toString('base64url') !== text || !verify(null, Buffer.from(agentCreationIntentDigest(payload)), keys[index]!.key, bytes))
      failure('The exact original route signature is invalid.', 'HOST_ROUTE_SIGNATURE_INVALID')
  }
  const length = envelope.endorsements.length
  if (!length || length >= nodes.length || agentCreationIntentDigest(nodes[length]) !== agentCreationIntentDigest(receiver) ||
    (!statement.authorization && agentCreationIntentDigest(statement.actor.source) !== agentCreationIntentDigest(statement.route.source)))
    failure('This route statement names another original actor, target or request.', 'HOST_ROUTE_TARGET_MISMATCH')
  if (statement.authorization) verifyHostRouteExecutionAuthorization(statement.authorization)
  signature(statement, envelope.signature, 0)
  for (let index = 0; index < length; index++) {
    const item = envelope.endorsements[index]!, payload = hostRouteEndorsementPayload(envelope, index)
    if (item.index !== index || item.previousDigest !== payload.previousDigest)
      failure('The original route endorsement chain changed.', 'HOST_ROUTE_SIGNATURE_INVALID')
    signature(payload, item.signature, index)
  }
  return envelope
}

export function verifyHostRouteEnvelope(value: HostRouteEnvelope, call: HostRouteCall, receiver: HostRouteIdentity, stream: boolean): HostRouteEnvelope {
  const envelope = verifyHostRouteSignatures(value, receiver)
  parseHostRouteCall(call, stream)
  if (envelope.statement.method !== call.method || envelope.statement.paramsDigest !== agentCreationIntentDigest(call.params))
    failure('This route statement names another original request.', 'HOST_ROUTE_TARGET_MISMATCH')
  assertExecutionChild(envelope.statement, call, stream)
  return envelope
}
export function verifyHostRouteExecutionAuthorization(value: HostRouteExecutionAuthorization): HostRouteExecutionAuthorization {
  const authorization = parseHostRouteExecutionAuthorization(value)
  const { signature, ...payload } = authorization, key = publicKey(authorization.coordinator.publicKey), bytes = Buffer.from(signature, 'base64url')
  if (key.fingerprint !== authorization.coordinator.fingerprint || bytes.toString('base64url') !== signature ||
    !verify(null, Buffer.from(agentCreationIntentDigest(payload)), key.key, bytes))
    failure('The original execution admission signature is invalid.', 'HOST_ROUTE_SIGNATURE_INVALID')
  if (authorization.parent) verifyHostRouteSignatures(authorization.parent, authorization.coordinator)
  assertExecutionParent(authorization)
  return authorization
}

/** One Runtime's lazy signing identity and explicit immutable source pins; no message queue lives here. */
export class AgentMuxCreationAuthority {
  private readonly identityPath: string
  private readonly trustDirectory: string
  private readonly messageTrustDirectory: string
  /** Original Runtime address, available independently of lazy signing material. */
  readonly runtimeId: string
  private readonly recoveryIdentity: (() => Promise<{ runtimeId: string; publicKey: string; privateKey: string } | null>) | undefined
  private readonly requireOriginalIdentity: boolean
  constructor(options: { stateDirectory: string; runtimeId: string;
    /** Original namespace bootstrap custody; never a public signer/import port. */
    recoveryIdentity?: () => Promise<{ runtimeId: string; publicKey: string; privateKey: string } | null>
    requireOriginalIdentity?: boolean }) {
    this.identityPath = join(options.stateDirectory, 'agent-creation-identity.json')
    this.trustDirectory = join(options.stateDirectory, 'agent-creation-trusted-sources')
    this.messageTrustDirectory = join(options.stateDirectory, 'agent-message-trusted-sources')
    this.runtimeId = options.runtimeId
    this.recoveryIdentity = options.recoveryIdentity
    this.requireOriginalIdentity = options.requireOriginalIdentity ?? false
    if (!options.runtimeId || options.runtimeId.length > 256 || options.runtimeId.trim() !== options.runtimeId || /[\u0000-\u001f\u007f]/u.test(options.runtimeId)) {
      failure('Agent creation authority needs its original Runtime identity.', 'AGENT_CREATION_AUTHORITY_INVALID')
    }
  }
  private async loadIdentity(): Promise<{ identity: AgentMuxCreationAuthorityIdentity; privateKey: KeyObject }> {
    try {
      const expected = await this.recoveryIdentity?.()
      const parse = (bytes: string) => {
        const value = parseOriginalCreationIdentity(bytes)
        if (value.runtimeId !== this.runtimeId || expected && (value.runtimeId !== expected.runtimeId || value.publicKey !== expected.publicKey || value.privateKey !== expected.privateKey))
          throw new Error('Original namespace signing binding changed')
        return value
      }
      const value = await immutableIdentityFile(this.identityPath, {
        parse,
        recover: async () => {
          return expected ? parse(JSON.stringify({ schema: 'agentmux.agent-creation-authority.v1', ...expected })) : null
        },
        create: () => {
          const pair = generateKeyPairSync('ed25519')
          return { schema: 'agentmux.agent-creation-authority.v1' as const, runtimeId: this.runtimeId,
            publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
            privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url') }
        },
        encode: value => JSON.stringify(value) + '\n',
        priorIdentity: async () => {
          if (this.requireOriginalIdentity) return true
          // Durable adopted source pins cannot be reassigned to a newly minted
          // signer just because one private file disappeared.
          for (const directory of [this.trustDirectory, this.messageTrustDirectory]) {
            try { if ((await readdir(directory)).length) return true }
            catch (error) { if (!absent(error)) throw error }
          }
          return false
        },
        onRecoveryIssue: issue => process.emitWarning('The original signing identity remains usable, but its recovery copy is unavailable. Retry this owner recovery without replacing the key.', { code: issue.code })
      })
      const pub = publicKey(value.publicKey)
      const privateKey = createPrivateKey({ key: Buffer.from(value.privateKey, 'base64url'), format: 'der', type: 'pkcs8' })
      return { identity: { runtimeId: this.runtimeId, publicKey: pub.encoded, fingerprint: pub.fingerprint }, privateKey }
    } catch (error) { return failure('The original Agent creation identity cannot be verified. Its file was retained; restore that identity before creating a new attestation.', 'AGENT_CREATION_AUTHORITY_INVALID', error) }
  }
  async identity(): Promise<AgentMuxCreationAuthorityIdentity> { return (await this.loadIdentity()).identity }
  /** Private composition locations; no source bytes or signing grants cross RPC. */
  recoveryPaths(): readonly string[] { return [this.identityPath, this.identityPath + '.original', this.trustDirectory, this.messageTrustDirectory] }
  /** One exact routed call purpose, independent from creation/message trust. */
  async attestHostRoute(statement: HostRouteStatement): Promise<HostRouteEnvelope> {
    const { identity, privateKey } = await this.loadIdentity()
    const envelope = parseHostRouteEnvelope({ statement, signature: 'unsigned', endorsements: [] })
    if (agentCreationIntentDigest(identity) !== agentCreationIntentDigest(envelope.statement.route.source) ||
      (!envelope.statement.authorization && agentCreationIntentDigest(identity) !== agentCreationIntentDigest(envelope.statement.actor.source)))
      return failure('A route source must be this actual ingress Core identity.', 'HOST_ROUTE_SOURCE_MISMATCH')
    if (envelope.statement.authorization) {
      const authorization = verifyHostRouteExecutionAuthorization(envelope.statement.authorization)
      if (agentCreationIntentDigest(authorization.coordinator) !== agentCreationIntentDigest(identity)) return failure('Only the original admission owner can sign this child.', 'HOST_ROUTE_SOURCE_MISMATCH')
    }
    envelope.signature = sign(null, Buffer.from(agentCreationIntentDigest(envelope.statement)), privateKey).toString('base64url')
    return envelope
  }
  /** Fixed-purpose assertion from the original admission, not a public signer. */
  async attestHostRouteExecution(value: Omit<HostRouteExecutionAuthorization, 'signature' | 'coordinator'>): Promise<HostRouteExecutionAuthorization> {
    const { identity, privateKey } = await this.loadIdentity()
    const authorization = parseHostRouteExecutionAuthorization({ ...value, coordinator: identity, signature: 'unsigned' })
    if (authorization.parent) verifyHostRouteSignatures(authorization.parent, identity)
    assertExecutionParent(authorization)
    const { signature: _unsigned, ...payload } = authorization
    return { ...authorization, signature: sign(null, Buffer.from(agentCreationIntentDigest(payload)), privateKey).toString('base64url') }
  }
  /** Append only this Core's next exact configured hop; never sign arbitrary bytes. */
  async endorseHostRoute(value: HostRouteEnvelope): Promise<HostRouteEnvelope> {
    const { identity, privateKey } = await this.loadIdentity(), envelope = parseHostRouteEnvelope(value)
    const index = envelope.endorsements.length, from = index === 0 ? envelope.statement.route.source : envelope.statement.route.hops[index - 1]?.target
    if (!from || agentCreationIntentDigest(from) !== agentCreationIntentDigest(identity) || !envelope.statement.route.hops[index])
      return failure('This Core is not the next adopted delegator.', 'HOST_ROUTE_SOURCE_MISMATCH')
    const payload = hostRouteEndorsementPayload(envelope, index)
    return { ...envelope, endorsements: [...envelope.endorsements, { index, previousDigest: payload.previousDigest,
      signature: sign(null, Buffer.from(agentCreationIntentDigest(payload)), privateKey).toString('base64url') }] }
  }
  private trustPath(sourceRuntimeId: string): string { return join(this.trustDirectory, hash(sourceRuntimeId) + '.json') }
  private async readTrust(path: string): Promise<AgentMuxCreationTrust> {
    try {
      const trust = parseAgentMuxCreationTrust(JSON.parse(await readFile(path, 'utf8')))
      const pub = publicKey(trust.publicKey)
      if (trust.targetRuntimeId !== this.runtimeId || trust.fingerprint !== pub.fingerprint || path !== this.trustPath(trust.sourceRuntimeId)) throw new Error('Wrong trust scope')
      return trust
    } catch (error) {
      if (absent(error)) throw error
      return failure('The original Agent creation source pin cannot be verified. Its file was retained.', 'AGENT_CREATION_TRUST_INVALID', error)
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
  private messageTrustPath(sourceRuntimeId: string): string { return join(this.messageTrustDirectory, hash(sourceRuntimeId) + '.json') }
  private async readMessageTrust(path: string): Promise<AgentMuxMessageTrust> {
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      if (raw.purpose !== 'agent-message') throw new Error('Wrong authority purpose')
      const { purpose: _, ...fields } = raw
      const trust = parseAgentMuxCreationTrust(fields), pub = publicKey(trust.publicKey)
      if (trust.targetRuntimeId !== this.runtimeId || trust.fingerprint !== pub.fingerprint || path !== this.messageTrustPath(trust.sourceRuntimeId)) throw new Error('Wrong message trust scope')
      return { ...trust, purpose: 'agent-message' }
    } catch (error) {
      if (absent(error)) throw error
      return failure('The original message source pin cannot be verified. Its file is retained.', 'AGENT_MESSAGE_TRUST_INVALID', error)
    }
  }
  async trustMessageSource(value: AgentMuxCreationTrustInput, principal: AgentMuxCreationUserPrincipal): Promise<AgentMuxMessageTrust> {
    if (!principal || principal.kind !== 'user') failure('Only the authenticated user can pin a message source.', 'AGENT_MESSAGE_TRUST_PERMISSION_REQUIRED')
    const input = parseAgentMuxCreationTrustInput(value), pub = publicKey(input.publicKey), target = await this.identity()
    if (input.targetRuntimeId !== target.runtimeId || input.targetKeyFingerprint !== target.fingerprint) failure('The target message authority changed since approval. Inspect its exact identity.', 'AGENT_MESSAGE_TARGET_MISMATCH')
    const requested: AgentMuxMessageTrust = { ...parseAgentMuxCreationTrust({ sourceRuntimeId: input.sourceRuntimeId, publicKey: pub.encoded,
      fingerprint: pub.fingerprint, targetRuntimeId: this.runtimeId, registeredAt: Date.now(), registeredBy: principal }), purpose: 'agent-message' }
    const path = this.messageTrustPath(requested.sourceRuntimeId)
    let retained: AgentMuxMessageTrust
    try { retained = await this.readMessageTrust(path) }
    catch (error) { if (!absent(error)) throw error; await publishFirst(path, requested); retained = await this.readMessageTrust(path) }
    if (retained.publicKey !== requested.publicKey) failure('This message source already has another pinned key. The original pin is retained.', 'AGENT_MESSAGE_SOURCE_KEY_CONFLICT')
    return retained
  }
  async listTrustedMessageSources(): Promise<AgentMuxMessageTrust[]> {
    let names: string[]
    try { names = await readdir(this.messageTrustDirectory) } catch (error) { if (absent(error)) return []; throw error }
    return Promise.all(names.filter(name => name.endsWith('.json')).sort().map(name => this.readMessageTrust(join(this.messageTrustDirectory, name))))
  }
  async attestMessageInboxReceipt(input: Omit<AgentMuxRecipientInboxReceipt, 'runtimeId' | 'keyFingerprint' | 'publicKey' | 'signature'>): Promise<AgentMuxRecipientInboxReceipt> {
    const { identity, privateKey } = await this.loadIdentity()
    const { signature: _, ...payload } = parseRecipientInboxReceipt({ ...input, runtimeId: identity.runtimeId, keyFingerprint: identity.fingerprint, publicKey: identity.publicKey, signature: 'A'.repeat(86) })
    return { ...payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64url') }
  }
  async attestMessage(source: Omit<AgentMuxMessageParticipant, 'runtimeId'>, target: AgentMuxMessageParticipant, intentDigest: string, targetKeyFingerprint: string): Promise<AgentMuxMessageProvenance> {
    const { identity, privateKey } = await this.loadIdentity()
    const { signature: _, ...payload } = parseMessageProvenance({ schema: 'agentmux.agent-message-admission.v1', purpose: 'agent-message',
      source: { runtimeId: identity.runtimeId, ...source }, target, sourceKeyFingerprint: identity.fingerprint, targetKeyFingerprint, intentDigest, signature: 'A'.repeat(86) })
    return { ...payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64url') }
  }
  async attestMessageRead(source: Omit<AgentMuxMessageParticipant, 'runtimeId'>, targetRuntimeId: string, sourceMessageId: string, sourceIntentDigest: string,
    reader: AgentMuxMessageReadAuthority['reader'], targetKeyFingerprint: string): Promise<AgentMuxMessageReadAuthority> {
    const { identity, privateKey } = await this.loadIdentity()
    const { signature: _, ...payload } = parseMessageReadAuthority({ schema: 'agentmux.agent-message-read.v1', purpose: 'agent-message',
      source: { runtimeId: identity.runtimeId, ...source }, reader, sourceKeyFingerprint: identity.fingerprint, targetKeyFingerprint, targetRuntimeId, sourceMessageId, sourceIntentDigest, signature: 'A'.repeat(86) })
    return { ...payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64url') }
  }
  async verifyMessageProof(value: AgentMuxMessageProvenance | AgentMuxMessageReadAuthority): Promise<AgentMuxMessageTrust> {
    const proof = value.schema === 'agentmux.agent-message-admission.v1' ? parseMessageProvenance(value) : parseMessageReadAuthority(value)
    const targetRuntimeId = proof.schema === 'agentmux.agent-message-admission.v1' ? proof.target.runtimeId : proof.targetRuntimeId
    const identity = await this.identity()
    if (targetRuntimeId !== this.runtimeId || proof.targetKeyFingerprint !== identity.fingerprint) failure('This signed message belongs to another target Runtime or key. Original records are retained.', 'AGENT_MESSAGE_TARGET_MISMATCH')
    let trust: AgentMuxMessageTrust
    try { trust = await this.readMessageTrust(this.messageTrustPath(proof.source.runtimeId)) }
    catch (error) { if (absent(error)) failure('This message source has not been explicitly trusted by the target user. Keep the original operation and approve its exact source.', 'AGENT_MESSAGE_SOURCE_UNTRUSTED'); throw error }
    if (proof.sourceKeyFingerprint !== trust.fingerprint) failure('The signed message source key differs from the original approved pin.', 'AGENT_MESSAGE_AUTHORITY_INVALID')
    const { signature, ...payload } = proof, bytes = Buffer.from(signature, 'base64url')
    if (bytes.toString('base64url') !== signature || !verify(null, Buffer.from(JSON.stringify(payload)), publicKey(trust.publicKey).key, bytes)) failure('The original message source signature is invalid.', 'AGENT_MESSAGE_AUTHORITY_INVALID')
    return trust
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
