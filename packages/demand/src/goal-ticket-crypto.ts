import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { parseGoalTicketProof, parseGoalTicketRecord, type GoalTicketOwner, type GoalTicketProof, type GoalTicketRecord, type GoalTicketSigner } from './goal-ticket-proof.js'

export type { GoalTicketSigner } from './goal-ticket-proof.js'

const schema = 'agentmux.goal-ticket-proof.v1'
const bytes = (record: GoalTicketRecord) => Buffer.from(JSON.stringify([schema, parseGoalTicketRecord(record)]), 'utf8')
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('base64url')

/** The key fingerprint comes from independently admitted trust for this Goal and purpose. */
export function verifyGoalTicketProof(value: unknown, expected: { fingerprint: string; goalId: string; hash: string }): GoalTicketProof {
  const proof = parseGoalTicketProof(value)
  const keyBytes = Buffer.from(proof.publicKey, 'base64url')
  const signature = Buffer.from(proof.signature, 'base64url')
  if (keyBytes.toString('base64url') !== proof.publicKey || signature.toString('base64url') !== proof.signature ||
      createHash('sha256').update(keyBytes).digest('hex') !== expected.fingerprint || proof.record.scope.goalId !== expected.goalId || proof.hash !== expected.hash)
    throw new Error('Goal Ticket proof does not match the expected key, Goal or hash')
  const key = createPublicKey({ key: keyBytes, format: 'der', type: 'spki' })
  const original = bytes(proof.record)
  if (key.asymmetricKeyType !== 'ed25519' || digest(original) !== proof.hash || !verify(null, original, key, signature))
    throw new Error('Goal Ticket proof hash or signature is invalid')
  return proof
}

/** The private signing key stays in Core. The capability is for this local Goal Store. */
export function goalTicketSigner(owner: GoalTicketOwner, publicKey: string, fingerprint: string, privateKey: KeyObject): GoalTicketSigner {
  const assertOwner = (record: GoalTicketRecord) => {
    if (record.scope.runtimeId !== owner.runtimeId || record.scope.namespace !== owner.namespace)
      throw new Error('Goal Ticket proof belongs to another original owner')
  }
  return { owner, issue(value) {
    const record = parseGoalTicketRecord(value)
    assertOwner(record)
    const original = bytes(record)
    return { schema, record, hash: digest(original), publicKey, signature: sign(null, original, privateKey).toString('base64url') }
  }, verify(proof) {
    assertOwner(proof.record)
    verifyGoalTicketProof(proof, { fingerprint, goalId: proof.record.scope.goalId, hash: proof.hash })
  } }
}
