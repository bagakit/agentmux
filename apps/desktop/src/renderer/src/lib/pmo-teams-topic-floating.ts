import { useEffect, useRef, useState } from 'react'

// Stable UI state key: renaming the code surface must not lose a user's saved position/size.
const STORAGE_KEY = 'agentmux.leader-topic-floating.v1'
const EVENT_NAME = 'agentmux:pmo-teams-topic-floating'
const DEFAULT_POSITION = { left: 80, top: 72 }
const DEFAULT_SIZE = { width: 720, height: 520 }
export type PmoTeamsTopicPrompt = { id: string; text: string }

type FloatingState = {
  open: boolean
  maximized: boolean
  position: { left: number; top: number }
  size: { width: number; height: number }
  pendingPrompt?: PmoTeamsTopicPrompt | undefined
}

export type PmoTeamsTopicFloatingState = FloatingState

const defaultState = (): FloatingState => ({
  open: false,
  maximized: false,
  position: { ...DEFAULT_POSITION },
  size: { ...DEFAULT_SIZE }
})

function readState(): FloatingState {
  if (typeof window === 'undefined') return defaultState()
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaultState()
    const value = JSON.parse(raw) as Partial<FloatingState>
    return {
      open: value.open === true,
      maximized: value.maximized === true,
      position: value.position && Number.isFinite(value.position.left) && Number.isFinite(value.position.top)
        ? { left: value.position.left, top: value.position.top }
        : { ...DEFAULT_POSITION },
      size: value.size && Number.isFinite(value.size.width) && Number.isFinite(value.size.height)
        ? { width: value.size.width, height: value.size.height }
        : { ...DEFAULT_SIZE },
    }
  } catch {
    return defaultState()
  }
}

function writeState(state: FloatingState): void {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* persistence is best effort */ }
}

export function requestPmoTeamsTopicFloatingOpen(options?: { prompt?: string }): void {
  const prompt = options?.prompt?.trim()
  window.dispatchEvent(new CustomEvent(EVENT_NAME, {
    detail: {
      open: true,
      ...(prompt ? { pendingPrompt: { id: crypto.randomUUID(), text: prompt } } : {})
    }
  }))
}

export function requestPmoTeamsTopicFloatingClose(): void {
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { open: false } }))
}

export function usePmoTeamsTopicFloatingState(): [FloatingState, (next: Partial<FloatingState>) => void] {
  const [state, setState] = useState<FloatingState>(() => readState())
  const stateRef = useRef(state)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  useEffect(() => { stateRef.current = state }, [state])
  useEffect(() => {
    const onEvent = (event: Event): void => {
      const detail = (event as CustomEvent<Partial<FloatingState>>).detail ?? {}
      const nextOpen = detail.open
      if (typeof nextOpen !== 'boolean' && detail.pendingPrompt === undefined) return
      const current = stateRef.current
      if (nextOpen === true && !current.open) {
        const active = document.activeElement
        if (active instanceof HTMLElement && !active.closest('[data-pmo-teams-topic-floating]')) {
          returnFocusRef.current = active
        }
      }
      if (nextOpen === true && current.open) {
        document.querySelector<HTMLElement>('[data-pmo-teams-topic-floating]')?.focus({ preventScroll: true })
      }
      const next = { ...current, ...detail }
      stateRef.current = next
      setState(next)
      writeState(next)
      if (nextOpen === false) {
        const target = returnFocusRef.current
        returnFocusRef.current = null
        if (target && document.contains(target)) {
          requestAnimationFrame(() => target.focus({ preventScroll: true }))
        }
      }
    }
    window.addEventListener(EVENT_NAME, onEvent)
    return () => window.removeEventListener(EVENT_NAME, onEvent)
  }, [])
  const update = (next: Partial<FloatingState>): void => {
    const resolved = { ...stateRef.current, ...next }
    stateRef.current = resolved
    setState(resolved)
    writeState(resolved)
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: next }))
  }
  return [state, update]
}

export function clampPmoTeamsTopicFloatingState(state: FloatingState): FloatingState {
  if (typeof window === 'undefined') return state
  const width = Math.max(420, Math.min(state.size.width, Math.max(420, window.innerWidth - 32)))
  const height = Math.max(280, Math.min(state.size.height, Math.max(280, window.innerHeight - 48)))
  return {
    ...state,
    size: { width, height },
    position: {
      left: Math.max(16, Math.min(state.position.left, Math.max(16, window.innerWidth - width - 16))),
      top: Math.max(16, Math.min(state.position.top, Math.max(16, window.innerHeight - height - 16)))
    }
  }
}
