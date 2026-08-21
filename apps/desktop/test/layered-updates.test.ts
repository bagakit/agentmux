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
  expect(source).toContain('runtime-review')
})

it('a runtime bump is installable only by producing the review it demands', () => {
  // 这条守的是**门不能是死路**：runtime 变了必须先 review，但 review 做完要有一条路能装。
  // 少了这条路，任何 ctxmux 升级都永远装不上——门就从"先 review"退化成"不许升级"。
  const source = readFileSync(new URL('../scripts/package-macos.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('async function installApplication')
  expect(start, 'package-macos.mjs 必须有 installApplication').toBeGreaterThan(-1)
  const body = source.slice(start, source.indexOf('\nasync function', start + 10))
  expect(body.length).toBeGreaterThan(200)

  // 放行的条件必须是**那份 review 记录读得出内容**，不是命令行上有没有打开关。
  // 裸开关只证明有人想跳过检查；读得出的记录才证明检查做过，而且装完还能回去看。
  expect(body).toContain("=== 'runtime-review'")
  expect(body).toMatch(/await readFile\(runtimeReviewPath/)
  expect(body).toMatch(/review !== null/)
  expect(body).toMatch(/review\.trim\(\)\.length > 0/)
  // 缺席不是默许：没给记录就必须停下。
  expect(body).toMatch(/assert\(runtimeReviewArgument,/)
})
