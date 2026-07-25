import { describe, expect, it } from 'vitest'
import type { AppConfig } from '../src/shared/contracts.js'
import {
  buildFanOutRequest,
  fanOutStemFromPrompt,
  MAX_FANOUT_LANES
} from '../src/renderer/src/lib/fanout-request.js'

function config(executorIds: string[]): AppConfig {
  return {
    version: 7,
    hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
    executors: Object.fromEntries(executorIds.map((id) => [
      id,
      { label: id, providerId: id, command: id, args: [], env: {}, injectAgentMuxGuide: true }
    ])),
    workspaces: [],
    appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
  }
}

describe('fanOutStemFromPrompt', () => {
  it('builds a path- and ref-safe stem from what the user actually asked for', () => {
    // The stem identifies the group afterwards, so it comes from the request, not a counter.
    expect(fanOutStemFromPrompt('Add retry to the uploader')).toBe('add-retry-to-the-uploader')
  })

  it('collapses punctuation and never leaves a trailing separator', () => {
    const stem = fanOutStemFromPrompt('Fix   the  parser!!! (again)')
    expect(stem).toBe('fix-the-parser-again')
    expect(stem.endsWith('-')).toBe(false)
  })

  it('bounds the length so a long prompt cannot produce an unusable branch name', () => {
    const stem = fanOutStemFromPrompt('word '.repeat(80))
    expect(stem.length).toBeLessThanOrEqual(40)
    expect(stem.endsWith('-')).toBe(false)
  })
})

describe('buildFanOutRequest', () => {
  it('produces a fan-out carrying the stem, count and executors', () => {
    const draft = buildFanOutRequest({
      prompt: 'Add retry to the uploader',
      count: 3,
      config: config(['codex', 'claude'])
    })

    expect(draft.kind).toBe('fanout')
    if (draft.kind !== 'fanout') return
    expect(draft.count).toBe(3)
    expect(draft.baseName).toBe('add-retry-to-the-uploader')
    // Concrete branch names and paths are main's to derive — the draft must not contain any.
    expect(JSON.stringify(draft)).not.toContain('.worktrees')
    expect(draft.executorIds).toEqual(['codex', 'claude'])
  })

  it('treats one lane as an ordinary launch rather than a bake-off', () => {
    const draft = buildFanOutRequest({ prompt: 'just do it', count: 1, config: config(['codex']) })
    expect(draft.kind).toBe('single')
    if (draft.kind !== 'single') return
    expect(draft.executorId).toBe('codex')
  })

  it('refuses a count past the ceiling instead of silently trimming it', () => {
    const draft = buildFanOutRequest({
      prompt: 'compare approaches',
      count: MAX_FANOUT_LANES + 1,
      config: config(['codex'])
    })
    expect(draft.kind).toBe('invalid')
    if (draft.kind !== 'invalid') return
    expect(draft.reason).toContain(String(MAX_FANOUT_LANES))
  })

  it('refuses a count below one', () => {
    expect(buildFanOutRequest({ prompt: 'x y z', count: 0, config: config(['codex']) }).kind).toBe('invalid')
  })

  it('refuses an empty prompt', () => {
    expect(buildFanOutRequest({ prompt: '   ', count: 3, config: config(['codex']) }).kind).toBe('invalid')
  })

  it('refuses when no executor is configured', () => {
    const draft = buildFanOutRequest({ prompt: 'compare approaches', count: 3, config: config([]) })
    expect(draft.kind).toBe('invalid')
    if (draft.kind !== 'invalid') return
    expect(draft.reason).toContain('executor')
  })

  it('refuses a prompt that slugifies to nothing rather than inventing a placeholder stem', () => {
    // Every lane would otherwise collide on the same empty name.
    const draft = buildFanOutRequest({ prompt: '!!! ???', count: 3, config: config(['codex']) })
    expect(draft.kind).toBe('invalid')
  })

  it('ignores executor ids that are not configured', () => {
    const draft = buildFanOutRequest({
      prompt: 'compare approaches',
      count: 2,
      config: config(['codex']),
      executorIds: ['codex', 'ghost']
    })
    expect(draft.kind).toBe('fanout')
    if (draft.kind !== 'fanout') return
    expect(draft.executorIds).toEqual(['codex'])
  })
})
