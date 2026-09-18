import { useEffect, useState } from 'react'

type Scalar = string | number | boolean

/** Each scalar field retains its own expectation while its draft is dirty or saving. */
export function useSettingDraftRecord<T extends Record<keyof T, Scalar>>(saved: T) {
  const [draft, setDraft] = useState({ value: saved, expected: saved, saving: false })
  const keys = Object.keys(saved) as (keyof T)[]
  useEffect(() => {
    setDraft((current) => {
      if (current.saving) return current
      const value = { ...current.value }, expected = { ...current.expected }
      let changed = false
      for (const key of Object.keys(saved) as (keyof T)[]) {
        if (value[key] === expected[key] && expected[key] !== saved[key]) {
          value[key] = expected[key] = saved[key]
          changed = true
        }
      }
      return changed ? { ...current, value, expected } : current
    })
  }, [saved, draft.value, draft.expected, draft.saving])
  return {
    ...draft,
    dirty: keys.some((key) => draft.value[key] !== draft.expected[key]),
    setField: <K extends keyof T>(key: K, value: T[K]) => setDraft((current) => ({
      ...current, value: { ...current.value, [key]: value }
    })),
    beginSave: () => {
      const { value, expected } = draft
      setDraft((current) => ({ ...current, saving: true }))
      return {
        value,
        expected,
        finish: (committed: boolean) => setDraft((current) => ({
          ...current, expected: committed ? value : current.expected, saving: false
        }))
      }
    }
  }
}

export function useSettingDraft<T extends Scalar>(saved: T) {
  const draft = useSettingDraftRecord({ value: saved })
  return {
    value: draft.value.value,
    expected: draft.expected.value,
    dirty: draft.dirty,
    setValue: (value: T) => draft.setField('value', value),
    beginSave: () => {
      const submitted = draft.beginSave()
      return { value: submitted.value.value, expected: submitted.expected.value, finish: submitted.finish }
    }
  }
}
