import {
  conversationInputKey, conversationInputWitnessGroup, conversationInputWitnessKey, conversationInputWitnessTurn,
  conversationNativeInputWitness, mergeConversationInputWitness,
  type ConversationInputAdoptionEvidence, type ConversationInputWitness, type ConversationSourceRecord
} from './conversation-stream.js'

/** Lightweight evidence retained by one temporary Reader, never a second adoption authority. */
export class ConversationInputWitnessIndex {
  private readonly records = new Map<string, ConversationInputWitness>()
  private readonly groups = new Map<string, readonly ConversationInputWitness[]>()
  private readonly keys = new Map<string, Set<string>>()
  private readonly turns = new Map<string, Set<string>>()
  private readonly uncertainGroups = new Set<string>()
  private readonly uncertainKeys = new Set<string>()

  constructor(private readonly parent?: ConversationInputWitnessIndex) {}

  /** Stage only this batch; an incomplete wire window cannot mutate its accepted Reader. */
  preview(records: readonly ConversationSourceRecord[]): ConversationInputWitnessIndex {
    const next = new ConversationInputWitnessIndex(this)
    next.accept(records)
    return next
  }

  accept(records: readonly ConversationSourceRecord[]): void {
    for (const record of records) {
      const prior = this.record(record.id), next = conversationNativeInputWitness(record)
      if (prior && prior.recordRevision !== record.revision && (!next ||
          prior.semanticItemId !== next.semanticItemId || conversationInputWitnessGroup(prior) !== conversationInputWitnessGroup(next) ||
          !!prior.key && conversationInputWitnessKey(prior) !== conversationInputWitnessKey(next))) {
        for (const witness of next ? [prior, next] : [prior]) {
          this.uncertainGroups.add(conversationInputWitnessGroup(witness))
          const key = conversationInputWitnessKey(witness); if (key) this.uncertainKeys.add(key)
        }
      }
      if (!next) continue
      const group = conversationInputWitnessGroup(next), key = conversationInputWitnessKey(next)
      this.groups.set(group, mergeConversationInputWitness(this.group(group), next))
      const turn = conversationInputWitnessTurn(next.record, next.turnId), turnGroups = this.turns.get(turn) ?? new Set<string>()
      turnGroups.add(group); this.turns.set(turn, turnGroups)
      if (key) {
        const groups = this.keys.get(key) ?? new Set<string>()
        groups.add(group); this.keys.set(key, groups)
      }
      // Keep the original identity witness; an added qualification is monotonic.
      if (!prior || !prior.key && next.key) this.records.set(record.id, next)
    }
  }

  /** Only relevant keys/groups reach projection and wire, irrespective of total history. */
  context(records: readonly ConversationSourceRecord[]): ConversationInputAdoptionEvidence {
    const groups = new Set<string>(), keys = new Set<string>(), pending: string[] = []
    const addKey = (key: string) => {
      if (keys.has(key)) return
      keys.add(key)
      for (const group of this.keyGroups(key)) if (!groups.has(group)) { groups.add(group); pending.push(group) }
    }
    for (const record of records) {
      const key = conversationInputKey(record); if (key) addKey(key)
      if (record.original.kind === 'native' && record.reference && record.original.item.turnId && record.original.item.turnOutcome) {
        for (const group of this.turnGroups(conversationInputWitnessTurn(record.reference, record.original.item.turnId))) {
          const facts = this.group(group)
          const uncertain = this.groupUncertain(group) || facts.length > 1 || facts.some(fact => {
            const key = conversationInputWitnessKey(fact)
            return key && (this.keyUncertain(key) || this.keyGroups(key).size > 1)
          })
          if (uncertain && !groups.has(group)) { groups.add(group); pending.push(group) }
        }
      }
      const fact = conversationNativeInputWitness(record), prior = this.record(record.id)
      for (const witness of [fact, prior]) if (witness) {
        const group = conversationInputWitnessGroup(witness)
        if (!groups.has(group)) { groups.add(group); pending.push(group) }
      }
    }
    const witnesses: ConversationInputWitness[] = [], unconfirmedKeys = new Set<string>()
    for (let i = 0; i < pending.length; i++) {
      const group = pending[i]!, facts = this.group(group)
      witnesses.push(...facts)
      for (const fact of facts) {
        const key = conversationInputWitnessKey(fact)
        if (key) { addKey(key); if (this.groupUncertain(group)) unconfirmedKeys.add(key) }
      }
    }
    for (const key of keys) if (this.keyUncertain(key)) unconfirmedKeys.add(key)
    return { witnesses, unconfirmedKeys }
  }

  private record(id: string): ConversationInputWitness | undefined { return this.records.get(id) ?? this.parent?.record(id) }
  private group(id: string): readonly ConversationInputWitness[] { return this.groups.get(id) ?? this.parent?.group(id) ?? [] }
  private keyGroups(key: string): ReadonlySet<string> {
    return new Set([...(this.parent?.keyGroups(key) ?? []), ...(this.keys.get(key) ?? [])])
  }
  private turnGroups(turn: string): ReadonlySet<string> {
    return new Set([...(this.parent?.turnGroups(turn) ?? []), ...(this.turns.get(turn) ?? [])])
  }
  private groupUncertain(group: string): boolean { return this.uncertainGroups.has(group) || !!this.parent?.groupUncertain(group) }
  private keyUncertain(key: string): boolean { return this.uncertainKeys.has(key) || !!this.parent?.keyUncertain(key) }
}
