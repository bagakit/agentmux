import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@agentmux/core'
import { emitUrlShortcut, emitWebloc, isBinaryContent } from '../src/shared/bookmark-file.js'
import { readBookmark } from '../src/main/bookmark-file.js'

/**
 * `readBookmark` 的**复合返回** `{url, binary}`：`openFile` 的书签分支一次 IPC 拿齐两件事——`url` 决定
 * 开 Browser 还是落穿回文本，`binary` 决定「查看源码」按钮灰不灰（§2.7）。承重的性质是**这两件事各自
 * 独立计算**：`binary` 恒等于「字节里有没有 NUL」（`isBinaryContent`），`url` 走按种类分派的解析。
 *
 * 之前只有 `readWeblocUrl` 有直接覆盖（`bookmark-file.test.ts`）；`readBookmark` 这层的组装是零覆盖。
 * 单独成文件而不并进 `bookmark-file.test.ts`：那份此刻正被另一人改。要挡住的变异：
 *  - `binary` 被写死 `true`/`false` —— 下面三点跨了 binary 的两种取值，写死必翻红。
 *  - `binary` 被偷偷从 `url` 派生（`url === null` / `url !== null`）—— 光靠「url 有/无」证明不了独立性，
 *    必须有一点是「binary 与 url 的真假不一致」：`.url` 文本取得出 url 但 binary=false（B），
 *    二进制坏文件取不出 url 但 binary=true（C）。这两点把 binary=f(url) 的所有写法都打死。
 *  - 种类分派错乱（`.url` 走去 shell `plutil`）—— B 断言 runProcess 从未被调。
 */

const NUL = String.fromCharCode(0)

/** 用 `plutil -convert binary1` 把一份 XML plist 变成真的二进制（`bplist00` 开头）。 */
function toBinaryPlist(xml: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'agentmux-composite-bin-'))
  const src = join(dir, 'src.webloc')
  const out = join(dir, 'out.webloc')
  writeFileSync(src, xml)
  execFileSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', out, src])
  return readFileSync(out)
}

describe('readBookmark 复合返回 {url, binary} 两件事各自独立算', () => {
  it.runIf(process.platform === 'darwin')(
    '二进制 .webloc（真 bplist00）：plutil 取回 url，且 binary=true',
    async () => {
      const url = 'https://example.com/composite?a=1&b=2'
      const binary = toBinaryPlist(emitWebloc(url))
      // 坐实喂进去的确实是二进制（含 NUL），否则这条测不到「二进制 + 有 url」这个角。
      expect(isBinaryContent(binary.toString('utf8'))).toBe(true)
      // 注入真的 runProcess，走真 plutil。
      expect(await readBookmark('webloc', binary, runProcess)).toEqual({ url, binary: true })
    }
  )

  it('.url 文本：取得出 url 但 binary=false，且从不 shell 出去（种类分派 + binary≠f(url)）', async () => {
    const url = 'https://example.com/win'
    const bytes = new TextEncoder().encode(emitUrlShortcut(url))
    let called = false
    const runner = (async () => {
      called = true
      return { stdout: '', stderr: '', exitCode: 0 }
    }) as unknown as typeof runProcess
    // url 非空、binary 为 false —— 若 binary 被写成 `url === null` 会得到 false（这里恰好也 false），
    // 但若被写成 `url !== null` 就会翻成 true，这一条打死后一种；C 打死前一种。
    expect(await readBookmark('url', bytes, runner)).toEqual({ url, binary: false })
    expect(called).toBe(false) // `.url` 恒文本，不该走 plutil
  })

  it('二进制坏文件（plutil 失败取不出 url）：url=null 但 binary 仍=true（binary 独立于 url）', async () => {
    const badBytes = new TextEncoder().encode(`bplist00${NUL}corrupt`)
    // plutil 失败 → readWeblocUrl 返回 null。用注入的失败 runner，判据不依赖真 plutil 对坏输入的行为。
    const failing = (async () => ({
      stdout: emitWebloc('https://should-be-ignored/'),
      stderr: 'boom',
      exitCode: 1
    })) as unknown as typeof runProcess
    // url 取不出（null），但字节含 NUL 所以 binary=true —— 这是「binary 由字节判、不由 url 判」的铁证：
    // 任何把 binary 写成 `url !== null` 的变异会得到 false，翻红。
    expect(await readBookmark('webloc', badBytes, failing)).toEqual({ url: null, binary: true })
  })
})
