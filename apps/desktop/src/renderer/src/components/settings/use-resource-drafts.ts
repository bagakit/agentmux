import { useEffect, useState } from 'react'
import { configValuesEqual as equal } from '../../../../shared/config-edit'

type Records<T extends object> = Record<string, T>
function own<T>(record: Record<string, T>, id: string): T | undefined { return Object.hasOwn(record, id) ? record[id] : undefined }
function field(record: object | undefined, key: string): unknown {
  return record && Object.hasOwn(record, key) ? (record as Record<string, unknown>)[key] : undefined
}
function withField<T extends object>(record: T, key: string, value: unknown): T {
  const next = { ...record }
  if (value === undefined) delete (next as Record<string, unknown>)[key]
  else Object.defineProperty(next, key, { value, enumerable: true, configurable: true, writable: true })
  return next
}

/** The two resource editors retain authored field expectations, including additions and deletions. */
export function useResourceDrafts<T extends object>(saved: Records<T>) {
  const [draft, setDraft] = useState({ value: saved, expected: saved, saving: false })
  useEffect(() => {
    setDraft((current) => {
      if (current.saving) return current
      const value = { ...current.value }, expected = { ...current.expected }
      for (const id of new Set([...Object.keys(saved), ...Object.keys(value), ...Object.keys(expected)])) {
        const local = Object.hasOwn(value, id) ? value[id] : undefined
        const baseline = Object.hasOwn(expected, id) ? expected[id] : undefined
        const committed = Object.hasOwn(saved, id) ? saved[id] : undefined
        if (equal(local, baseline)) {
          if (committed) value[id] = expected[id] = committed
          else { delete value[id]; delete expected[id] }
        } else if (local && baseline && committed) {
          for (const key of new Set([...Object.keys(local), ...Object.keys(baseline), ...Object.keys(committed)])) {
            if (equal(field(local, key), field(baseline, key))) {
              value[id] = withField(value[id]!, key, field(committed, key))
              expected[id] = withField(expected[id]!, key, field(committed, key))
            }
          }
        }
      }
      return equal(value, current.value) && equal(expected, current.expected) ? current : { ...current, value, expected }
    })
  }, [saved, draft.value, draft.expected, draft.saving])
  return {
    ...draft,
    dirty: !equal(draft.value, draft.expected),
    setValue: (update: (current: Records<T>) => Records<T>) => setDraft((current) => ({ ...current, value: update(current.value) })),
    beginSave: (captured: Records<T> = draft.value) => {
      const expected = draft.expected
      setDraft((current) => ({ ...current, saving: true }))
      return {
        value: captured, expected,
        finish: (committed: Records<T> | undefined) => setDraft((current) => {
          if (!committed) return { ...current, saving: false }
          const value = { ...current.value }
          for (const id of new Set([...Object.keys(captured), ...Object.keys(committed)])) {
            const local = own(value, id), submitted = own(captured, id), accepted = own(committed, id)
            if (equal(local, submitted)) {
              if (accepted) value[id] = accepted
              else delete value[id]
            } else if (local && submitted && accepted) {
              for (const key of new Set([...Object.keys(submitted), ...Object.keys(accepted)])) {
                if (equal(field(value[id], key), field(submitted, key))) value[id] = withField(value[id]!, key, field(accepted, key))
              }
            }
          }
          return { value, expected: committed, saving: false }
        })
      }
    }
  }
}
