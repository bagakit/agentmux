import { describe, expect, it } from 'vitest'
import { createBrowserStepEffectRecorder, normalizeBrowserStepEffects } from '@agentmux/browser/operations'

describe('what one page call caused, as Main saw it', () => {
  it('a Browser the page opens during a call is that call’s effect; the document it moved to is recorded', () => {
    const effects = createBrowserStepEffectRecorder()
    effects.begin(1, 'nav-1')
    effects.opened('child-a')
    effects.opened('child-a')
    expect(effects.finish(1, 'nav-2')).toEqual({ opened: ['child-a'], navigatedTo: 'nav-2' })
  })

  it('a call that caused nothing reports nothing, and an open after every call settled is attributed to none', () => {
    const effects = createBrowserStepEffectRecorder()
    effects.begin(1, 'nav-1')
    expect(effects.finish(1, 'nav-1')).toBeUndefined()
    effects.opened('late-child')
    effects.begin(2, 'nav-1')
    expect(effects.finish(2, 'nav-1'), 'a page opened by a timer is not the next call’s doing').toBeUndefined()
  })

  it('an unknown navigation id never claims the page moved', () => {
    const effects = createBrowserStepEffectRecorder()
    effects.begin(1, undefined)
    expect(effects.finish(1, 'nav-2')).toBeUndefined()
    effects.begin(2, 'nav-1')
    expect(effects.finish(2, undefined)).toBeUndefined()
  })

  it('effects read back from disk keep only well-formed facts', () => {
    expect(normalizeBrowserStepEffects({ opened: ['a', 7, '', 'b'], navigatedTo: 'nav-9' })).toEqual({ opened: ['a', 'b'], navigatedTo: 'nav-9' })
    expect(normalizeBrowserStepEffects({ opened: 'a', navigatedTo: 3 })).toBeUndefined()
    expect(normalizeBrowserStepEffects(null)).toBeUndefined()
    expect(normalizeBrowserStepEffects({ opened: Array.from({ length: 40 }, (_, i) => `c${i}`) })!.opened).toHaveLength(16)
  })
})
