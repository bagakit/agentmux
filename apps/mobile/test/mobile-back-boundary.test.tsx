import { act, useLayoutEffect, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMobileBack } from '../src/navigation/useMobileBack'
import { mount, mounted } from './conversation-fixture'

function FirstCommit({ children, observe }: { children: ReactNode; observe(): void }) {
  // A parent layout effect runs after its child's layout effects, before the visible frame.
  // Passive effects have not run yet; do not await a product guard to make Back succeed.
  useLayoutEffect(observe, [])
  return <>{children}</>
}

beforeEach(() => { window.history.replaceState(null, '') })
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks()
})

describe('visible mobile Back boundary', () => {
  it('accepts actual browser Back at the first visible deep-layer commit', async () => {
    const returned = vi.fn(), firstFrame: unknown[] = []
    function ActualLayer() {
      const [deep, setDeep] = useState(true)
      useMobileBack(deep, () => { returned(); setDeep(false) })
      return <p data-layer={deep ? 'original-content' : 'directory'}>Original layer</p>
    }
    const view = await mount(<FirstCommit observe={() => {
      firstFrame.push(window.history.state)
      window.history.back()
    }}><ActualLayer /></FirstCommit>)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(firstFrame).toHaveLength(1)
    expect(firstFrame[0]).toMatchObject({ agentmuxMobileBack: expect.stringMatching(/^mobile-back:/) })
    expect(returned).toHaveBeenCalledTimes(1)
    expect(view.element.querySelector('[data-layer]')?.getAttribute('data-layer')).toBe('directory')
  })

})
