import { useEffect, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { deliveryFailure } from '@agentmux/core/delivery-attempt'
import { parseCapsuleParams, parseCapsuleResult, type CapsuleParamsMap, type CapsuleResultMap } from '@agentmux/core/capsule'
import { api } from '../../lib/api'

type Editable = Record<string, string | boolean>
const same = <T extends Editable>(a: T, b: T) => Object.keys(a).every(key => a[key] === b[key])

/** UI drafts retain their original CAS baseline; the Capsule owner holds saved truth. */
export function useCapsuleDraft<T extends Editable>(saved: T, revision: number) {
  const [draft, setDraft] = useState({ value: saved, base: saved, revision })
  const dirty = !same(draft.value, draft.base)
  useEffect(() => {
    setDraft(current => same(current.value, current.base) && current.revision !== revision
      ? { value: saved, base: saved, revision } : current)
  }, [saved, revision])
  return {
    ...draft, dirty, changed: revision !== draft.revision,
    set<K extends keyof T>(key: K, value: T[K]) { setDraft(current => ({ ...current, value: { ...current.value, [key]: value } })) },
    rebase() {
      setDraft(current => ({ revision, base: saved, value: Object.fromEntries(Object.keys(saved).map(key =>
        [key, current.value[key] === current.base[key] ? saved[key] : current.value[key]])) as T }))
    },
    confirm(submitted: T, value: T, nextRevision: number) {
      setDraft(current => ({ revision: nextRevision, base: value,
        value: Object.fromEntries(Object.keys(value).map(key => [key, current.value[key] === submitted[key] ? value[key] : current.value[key]])) as T }))
    }
  }
}

type Mutation = 'capsule.config.update' | 'capsule.create' | 'capsule.update' | 'capsule.open'
type Attempt<M extends Mutation> = { params: CapsuleParamsMap[M]; phase: 'pending' | 'unknown' | 'failed' | 'committed'; message: string }

/** A lost reply is inspected by its original operation; this hook never replays it. */
export function useCapsuleMutation<M extends Mutation>(method: M, confirmed: (result: CapsuleResultMap[M], params: CapsuleParamsMap[M]) => void) {
  const [attempt, setAttempt] = useState<Attempt<M> | null>(null)
  const [validation, setValidation] = useState('')
  const running = useRef(false), mounted = useRef(true), consume = useRef(confirmed)
  consume.current = confirmed
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const locked = attempt?.phase === 'pending' || attempt?.phase === 'unknown'
  async function submit(input: CapsuleParamsMap[M]) {
    if (running.current || locked) return
    let params: CapsuleParamsMap[M]
    try { params = parseCapsuleParams(method, input); setValidation('') }
    catch (error) { setValidation(presentError(error)); return }
    const original: Attempt<M> = { params, phase: 'pending', message: '' }
    running.current = true; setAttempt(original)
    try {
      const result = await api.capsules.call(method, params)
      if (!mounted.current) return
      consume.current(result, params)
      setAttempt({ ...original, phase: 'committed', message: 'Confirmed by the Capsule owner.' })
    } catch (error) {
      const failure = deliveryFailure(error).controlFailure
      const notApplied = failure?.disposition === 'not_applied' && failure.confirmedInputBytes === 0
      if (mounted.current) setAttempt({ ...original, phase: notApplied ? 'failed' : 'unknown', message: notApplied
        ? `The original operation was not applied. Your draft is kept. ${presentError(error)}` : presentError(error) })
    } finally { running.current = false }
  }
  async function inspect() {
    if (!attempt || running.current || attempt.phase !== 'unknown') return
    const original = attempt
    running.current = true; setAttempt({ ...original, phase: 'pending' })
    try {
      const { operation } = await api.capsules.call('capsule.operation.inspect', { operationId: original.params.operationId })
      if (!mounted.current) return
      if (operation?.status === 'committed') {
        const result = parseCapsuleResult(method, operation.result, original.params)
        consume.current(result, original.params)
        setAttempt({ ...original, phase: 'committed', message: 'The original operation is confirmed.' })
      } else if (operation?.status === 'failed') setAttempt({ ...original, phase: 'failed', message: operation.issue?.message ?? 'The original operation failed. Review the current values before a new submission.' })
      else setAttempt({ ...original, phase: 'unknown', message: 'The original operation is still unconfirmed. Your draft is kept; checking does not repeat it.' })
    } catch (error) { if (mounted.current) setAttempt({ ...original, phase: 'unknown', message: presentError(error) }) }
    finally { running.current = false }
  }
  return { attempt, locked: !!locked, pending: attempt?.phase === 'pending', validation, submit, inspect }
}
