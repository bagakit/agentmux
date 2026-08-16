import { describe, expect, it } from 'vitest'
import { nextToolDockPhase } from '../src/renderer/src/components/AgentComposerTools.js'

describe('Message Tools three-state interaction', () => {
  it('collapses first, restores the current density, then expands to multiple tools', () => {
    const first = nextToolDockPhase('current')
    const second = nextToolDockPhase(first)
    const third = nextToolDockPhase(second)
    expect([first, second, third]).toEqual(['collapsed', 'restored', 'expanded'])
  })

  it('returns from the expanded state to the quiet collapsed state', () => {
    expect(nextToolDockPhase('expanded')).toBe('collapsed')
  })
})
