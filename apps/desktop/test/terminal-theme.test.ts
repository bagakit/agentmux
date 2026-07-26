import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { Terminal } from '@xterm/headless'
import {
  TERMINAL_THEME_CATALOG,
  UNICODE_WIDTH_VERSION,
  activateTerminalUnicodeWidth,
  terminalOptions,
  terminalTheme
} from '../src/renderer/src/lib/terminal-theme.js'

// 用真正的 xterm 内核（headless，已是依赖）而非桩：宽度表是否生效只有内核说了算。
// 单元格宽度在字节写入那一刻按当时的 activeVersion 定型，所以下面既断言"激活到 11"，
// 也断言"激活必须早于写入"——顺序错了，本项差距（中文/emoji 错位）就不算修好。
function headlessTerminal(): Terminal {
  return new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
}

function firstCellWidth(terminal: Terminal): number {
  const line = terminal.buffer.active.getLine(0)
  if (!line) throw new Error('no line 0')
  return line.getCell(0)?.getWidth() ?? -1
}

function writeSync(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

describe('terminal appearance', () => {
  it('keeps Codex gray surfaces distinct on the Graphite terminal work area', () => {
    expect(terminalTheme('graphite')).toEqual({
      background: '#000000',
      foreground: '#ffffff',
      cursor: '#ffffff',
      cursorAccent: '#000000',
      selectionBackground: '#5a7898',
      selectionForeground: '#ffffff',
      black: '#1d1f21',
      red: '#cc6666',
      green: '#b5bd68',
      yellow: '#f0c674',
      blue: '#81a2be',
      magenta: '#b294bb',
      cyan: '#8abeb7',
      white: '#c5c8c6',
      brightBlack: '#666666',
      brightRed: '#d54e53',
      brightGreen: '#b9ca4a',
      brightYellow: '#e7c547',
      brightBlue: '#7aa6da',
      brightMagenta: '#c397d8',
      brightCyan: '#70c0b1',
      brightWhite: '#eaeaea'
    })
  })

  it('does not collapse the default TUI composer color into the work area', () => {
    const theme = terminalTheme('graphite')
    expect(theme.black).toBe('#1d1f21')
    expect(theme.black).not.toBe(theme.background)
  })

  it('offers only complete curated palettes', () => {
    expect(TERMINAL_THEME_CATALOG.map((item) => item.id)).toEqual([
      'graphite',
      'catppuccin-mocha'
    ])
    for (const { theme } of TERMINAL_THEME_CATALOG) {
      expect(Object.keys(theme)).toHaveLength(22)
      expect(theme.black).not.toBe(theme.background)
    }
  })

  it('keeps renderer behavior stable while selecting a palette', () => {
    expect(terminalOptions('catppuccin-mocha')).toMatchObject({
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',
      fontSize: 12,
      fontWeight: '300',
      fontWeightBold: '500',
      lineHeight: 1,
      scrollSensitivity: 1.15,
      fastScrollSensitivity: 5,
      macOptionIsMeta: false,
      macOptionClickForcesSelection: true,
      allowTransparency: false,
      minimumContrastRatio: 3,
      drawBoldTextInBrightColors: true,
      theme: terminalTheme('catppuccin-mocha')
    })
  })
})

describe('terminal Unicode 11 width table', () => {
  it('activates version 11, not the default 6', () => {
    const terminal = headlessTerminal()
    expect(terminal.unicode.activeVersion).toBe('6')
    const active = activateTerminalUnicodeWidth(terminal)
    expect(active).toBe(UNICODE_WIDTH_VERSION)
    expect(terminal.unicode.activeVersion).toBe('11')
    // 只 loadAddon 会把 '11' 登记进 versions；真正生效的判据是 activeVersion 切过去了。
    expect(terminal.unicode.versions).toContain('11')
  })

  it('lays out an emoji across two columns once the width table is active', async () => {
    const terminal = headlessTerminal()
    activateTerminalUnicodeWidth(terminal)
    await writeSync(terminal, '👍')
    // v11 下 👍 是宽字符，占两列；这正是修复前按 v6 只占一列导致的错位。
    expect(firstCellWidth(terminal)).toBe(2)
  })

  it('reports the real active version, not the constant it tried to set', () => {
    // 模拟一个激活悄悄没生效的宿主：activeVersion 的 setter 是空操作、始终读回 '6'。
    // 返回值必须诚实反映"实际生效的是 6"，而不是回显它想设的 '11'——调用点据此判断降级。
    // 这条断言钉住"读回真实状态"这行；把它换成 `return UNICODE_WIDTH_VERSION` 会红。
    let active = '6'
    const stub = {
      loadAddon() {},
      unicode: {
        get activeVersion() {
          return active
        },
        set activeVersion(_next: string) {
          // 宿主拒绝切换：保持 '6'，什么都不做。
        },
        get versions() {
          return active === '11' ? ['6', '11'] : ['6']
        }
      }
    } as unknown as Terminal
    expect(activateTerminalUnicodeWidth(stub)).toBe('6')

    // 而当宿主真的切过去时，返回值也随之为 '11'——证明它读的是状态而非常量。
    active = '6'
    const realStub = {
      loadAddon() {},
      unicode: {
        get activeVersion() {
          return active
        },
        set activeVersion(next: string) {
          active = next
        },
        get versions() {
          return ['6', '11']
        }
      }
    } as unknown as Terminal
    expect(activateTerminalUnicodeWidth(realStub)).toBe('11')
  })

  it('never throws when the host rejects the width table, so a healthy terminal survives', () => {
    // 工程原则 11：装饰性能力失败不许拖垮健康终端。setter 抛错时，helper 必须吞掉并退回当前版本，
    // 而不是把异常抛回 attach 建立段（那会连带掐断链接 provider / WebGL / attach）。
    const throwingStub = {
      loadAddon() {},
      unicode: {
        get activeVersion() {
          return '6'
        },
        set activeVersion(_next: string) {
          throw new Error('host refused unicode switch')
        },
        get versions() {
          return ['6']
        }
      }
    } as unknown as Terminal
    expect(() => activateTerminalUnicodeWidth(throwingStub)).not.toThrow()
    expect(activateTerminalUnicodeWidth(throwingStub)).toBe('6')
  })

  it('is load-bearing on order: bytes written before activation keep the wrong v6 width', async () => {
    // 顺序守卫。宽度在写入那一刻定型：先写后激活，emoji 已按 v6 落成 1 列，之后再激活也救不回来。
    // 这条断言就是 acceptance「顺序错了等于没做」的可证伪化——把激活挪到 write 之后，它会红。
    const wroteFirst = headlessTerminal()
    await writeSync(wroteFirst, '👍')
    activateTerminalUnicodeWidth(wroteFirst)
    expect(firstCellWidth(wroteFirst)).toBe(1)

    // 对照：同一个 emoji，激活在前，落成 2 列。差异只来自激活相对写入的先后。
    const activatedFirst = headlessTerminal()
    activateTerminalUnicodeWidth(activatedFirst)
    await writeSync(activatedFirst, '👍')
    expect(firstCellWidth(activatedFirst)).toBe(2)
  })
})

// 纯函数全绿证明不了它接到了产品上。TerminalView 在本仓无法跑 effect（无 jsdom），
// 所以承重的接线——「激活确实被调用，且排在 open() 之后、任何字节写入之前」——由源码断言守住。
// 只 loadAddon 不激活、或把激活挪到 write 之后、或在 open() 与激活之间插一条同步写入，
// 这三种最容易犯的静默失效都会让下面变红。
describe('Unicode width table is wired before the first replayed byte', () => {
  const terminalView = readFileSync(
    new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url),
    'utf8'
  )

  it('calls the activation helper from TerminalView', () => {
    expect(terminalView).toContain('activateTerminalUnicodeWidth(terminal)')
  })

  it('activates the width table after open() and before the first terminal write', () => {
    const openAt = terminalView.indexOf('terminal.open(root)')
    const activateAt = terminalView.indexOf('activateTerminalUnicodeWidth(terminal)')
    // 首写入的代理点收紧到真正的首写入，而不是靠后的 hydrate：本文件唯一的写终端通路是
    // terminalWrite（其调用形 `terminalWrite(terminal,` 靠逗号与定义 `terminalWrite(terminal:` 区分），
    // 回放走 hydrate；取两者更靠前的一个。只盯 hydrate 会漏掉"在 open() 与激活之间插一条同步写入"
    // 这种把宽字符按 v6 落格的静默回归——它会排在 hydrate 之前、却仍让旧守卫判绿。
    const firstTerminalWriteAt = terminalView.indexOf('terminalWrite(terminal,')
    const firstHydrateAt = terminalView.indexOf('hydrateTerminalReplay(')
    expect(openAt).toBeGreaterThan(0)
    expect(firstTerminalWriteAt).toBeGreaterThan(0)
    expect(firstHydrateAt).toBeGreaterThan(0)
    const firstWriteAt = Math.min(firstTerminalWriteAt, firstHydrateAt)
    // 顺序错了等于没做：激活必须排在 open() 之后、任何写入之前。
    expect(activateAt).toBeGreaterThan(openAt)
    expect(activateAt).toBeLessThan(firstWriteAt)
  })
})
