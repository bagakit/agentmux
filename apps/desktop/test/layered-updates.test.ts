import { expect, it } from 'vitest'
import { updateRoute } from '../src/shared/update-policy'
import { readFileSync } from 'node:fs'
it('uses frontend updates only for the same shell and runtime; unknown runtime requires review', () => {
  expect(updateRoute({ shell: 's', ctxmux: 'c' }, { shell: 's', ctxmux: 'c' })).toBe('renderer')
  expect(updateRoute({ shell: 's', ctxmux: 'c' }, { shell: 'new', ctxmux: 'c' })).toBe('application')
  expect(updateRoute({ shell: 's', ctxmux: 'c' }, { shell: 's', ctxmux: 'new' })).toBe('runtime-review')
  expect(updateRoute({ shell: '', ctxmux: '' }, { shell: '', ctxmux: '' })).toBe('runtime-review')
})
it('production installer checks runtime before quitting and never escalates a normal app quit', () => {
  const source = readFileSync(new URL('../scripts/package-macos.mjs', import.meta.url), 'utf8')
  const quit = source.slice(source.indexOf('async function quitInstalledApplication'), source.indexOf('async function', source.indexOf('async function quitInstalledApplication') + 10))
  expect(quit.length).toBeGreaterThan(100)
  expect(quit).not.toContain('signalProcessIds(')
  expect(quit).toContain('remaining.length === 0')
  expect(source).toContain("!== 'runtime-review'")
})
