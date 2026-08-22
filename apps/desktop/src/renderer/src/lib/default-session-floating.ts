import { useEffect, useState } from 'react'

const STORAGE_KEY = 'agentmux.default-session-floating.v1'
const EVENT_NAME = 'agentmux:default-session-floating'
const DEFAULT_POSITION = { left: 80, top: 72 }
const DEFAULT_SIZE = { width: 720, height: 520 }

type FloatingState = {
  open: boolean
  position: { left: number; top: number }
  size: { width: number; height: number }
}

export type DefaultSessionFloatingState = FloatingState

function readState(): FloatingState {
  if (typeof window === 'undefined') return { open: false, position: DEFAULT_POSITION, size: DEFAULT_SIZE }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { open: false, position: DEFAULT_POSITION, size: DEFAULT_SIZE }
    const value = JSON.parse(raw) as Partial<FloatingState>
    return {
      open: value.open === true,
      position: value.position && Number.isFinite(value.position.left) && Number.isFinite(value.position.top) ? value.position : DEFAULT_POSITION,
      size: value.size && Number.isFinite(value.size.width) && Number.isFinite(value.size.height) ? value.size : DEFAULT_SIZE
    }
  } catch {
    return { open: false, position: DEFAULT_POSITION, size: DEFAULT_SIZE }
  }
}

function writeState(state: FloatingState): void {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* persistence is best effort */ }
}

export function requestDefaultSessionFloatingOpen(): void {
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { open: true } }))
}

export function requestDefaultSessionFloatingClose(): void {
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { open: false } }))
}

export function useDefaultSessionFloatingState(): [FloatingState, (next: Partial<FloatingState>) => void] {
  const [state, setState] = useState<FloatingState>(() => readState())
  useEffect(() => {
    const onEvent = (event: Event): void => {
      const nextOpen = (event as CustomEvent<{ open?: boolean }>).detail?.open
      if (typeof nextOpen !== 'boolean') return
      setState((current) => {
        const next = { ...current, open: nextOpen }
        writeState(next)
        return next
      })
    }
    window.addEventListener(EVENT_NAME, onEvent)
    return () => window.removeEventListener(EVENT_NAME, onEvent)
  }, [])
  const update = (next: Partial<FloatingState>): void => {
    setState((current) => {
      const resolved = { ...current, ...next }
      writeState(resolved)
      return resolved
    })
  }
  return [state, update]
}

export function clampDefaultSessionFloatingState(state: FloatingState): FloatingState {
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
