import { readFile } from 'node:fs/promises'
import { beforeAll, describe, expect, it, vi } from 'vitest'

let terminalLinks: typeof import('../src/renderer/src/components/TerminalView.js')

beforeAll(async () => {
  vi.stubGlobal('self', globalThis)
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  terminalLinks = await import('../src/renderer/src/components/TerminalView.js')
})

describe('Terminal link destination entry', () => {
  it('takes its scheme judgement from the shared exit instead of its own copy', async () => {
    // 「哪些 scheme 点了能打开」终端和对话正文必须判得一样。这条判据以前是终端自己一份
    // parseTerminalHttpLink，对话正文那条路后来又抄了一份——两份逐字相同，而漂移只会表现成
    // 「一个界面把死链接做成可点，另一个不做」，没人会为此报 bug。所以现在只有 open-destination.ts
    // 那一个出口，接受/拒绝集在 open-destination-bar.test.tsx 里钉死。
    //
    // 这里守的是**另一件事**：终端确实走那个出口。判据必须是 import 关系——本仓有先例，
    // not.toContain('name(') 这种按裸标识符判的守卫实测会被绕过（同名局部函数照样全绿）。
    const source = await readFile(
      new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url),
      'utf8'
    )
    expect(source).toMatch(/import\s*\{[^}]*\bparseHttpLinkUrl\b[^}]*\}\s*from\s*'\.\.\/lib\/open-destination'/)
    // 而且不许再有第二份本地实现。自检：这个正则要真能认出被删掉的那份旧代码的形状，
    // 否则它就是一条恒绿的门。
    const localCopy = /function\s+\w*[Hh]ttpLink\w*\s*\([^)]*\)\s*:\s*string\s*\|\s*null/
    expect(source).not.toMatch(localCopy)
    expect(
      "function parseTerminalHttpLink(rawUrl: string): string | null {",
      '自检：判据必须认得出旧的本地实现形状，否则这条门恒绿'
    ).toMatch(localCopy)
  })

  it('does not let an old menu dismissal clear a newer request', () => {
    const current = { id: 12, url: 'https://new.example/', x: 3, y: 4 }

    expect(terminalLinks.dismissTerminalLinkRequest(current, 11)).toBe(current)
    expect(terminalLinks.dismissTerminalLinkRequest(current, 12)).toBeNull()
  })
})
