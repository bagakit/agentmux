import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useMobileScreenMotion, type MobileScreenMotion } from '../src/navigation/use-mobile-screen-motion'

let seen: MobileScreenMotion[] = []
function Probe({ layer, depth, revision }: { layer: string; depth: number; revision: number }) {
  seen.push(useMobileScreenMotion(layer, depth, revision))
  return null
}
const host = document.createElement('div')
const root = createRoot(host)
const render = (layer: string, depth: number, revision: number) => act(async () => { root.render(<Probe layer={layer} depth={depth} revision={revision} />) })
afterEach(() => { seen = [] })

describe('navigation-declared screen motion', () => {
  it('pushes deeper, pops shallower, and stays still for siblings or changes without a navigation action', async () => {
    await render('directory:focus', 0, 0)
    await render('conversation', 1, 1)
    expect(seen.at(-1)).toMatchObject({ kind: 'push' })
    await render('terminal', 2, 2)
    expect(seen.at(-1)).toMatchObject({ kind: 'push' })
    await render('conversation', 1, 3)
    expect(seen.at(-1)).toMatchObject({ kind: 'pop' })
    const before = seen.at(-1)!.key
    // A late read or automatic chat start changes the layer without a navigation revision.
    await render('directory:focus', 0, 3)
    expect(seen.at(-1)?.key ?? before).toBe(before)
    // Siblings at the same depth switch without motion.
    await render('directory:mote', 0, 4)
    expect(seen.at(-1)?.key ?? before).toBe(before)
  })
})
