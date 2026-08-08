import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  clampTerminalFontSize,
  type AppConfig
} from '../src/shared/contracts.js'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store.js'
import { terminalOptions } from '../src/renderer/src/lib/terminal-theme'

// ---------------------------------------------------------------------------
// Guard 3 — 越界字号在**拥有 clamp 的那道边界**上被夹住，而且**只**在那里。
//
// 「拥有 clamp」的边界是持久化 schema：save 与 get 都过它，所以任何字号——UI 传来的、用户手改
// 磁盘写进去的——落盘前一定在范围内。判据是行为的：往 ConfigStore 存一个 900 / 0，读回来必须是
// max / min；不是「源码里出现了 clamp 这个词」。
//
// 「只在那里」这一半同样重要：clampTerminalFontSize 不应在渲染路径上被再调一次。若 terminal-theme
// 也 clamp，clamp 的归属就散成两处，日后改范围要改两个地方、必然漂移（本仓「重复的规则会吃掉修复」）。
// 所以下面显式断言 terminalOptions 会**原样透传**一个越界值——证明它信任持久化过的值、自己不夹。
// ---------------------------------------------------------------------------

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function storeFixture(): Promise<{ store: ConfigStore; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-fontsize-test-'))
  roots.push(root)
  return { store: new ConfigStore(join(root, 'config.json')), path: join(root, 'config.json') }
}

function configWithFontSize(size: number): AppConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    appearance: { terminalTheme: 'graphite', terminalFontSize: size }
  }
}

describe('the persistence schema owns the terminal font-size clamp', () => {
  it('save() 夹住超上限的字号到 max，而不是把 900 写进盘', async () => {
    const { store, path } = await storeFixture()
    const saved = await store.save(configWithFontSize(900))
    expect(saved.appearance.terminalFontSize).toBe(TERMINAL_FONT_SIZE_MAX)
    // 盘上也必须是夹过的值——不是内存夹一份、磁盘留一份 900。
    expect(await readFile(path, 'utf8')).toContain(`"terminalFontSize": ${TERMINAL_FONT_SIZE_MAX}`)
  })

  it('save() 夹住低于下限的字号到 min', async () => {
    const { store } = await storeFixture()
    const saved = await store.save(configWithFontSize(0))
    expect(saved.appearance.terminalFontSize).toBe(TERMINAL_FONT_SIZE_MIN)
  })

  it('get() 读一份手改过、字号越界的磁盘配置时同样夹住', async () => {
    // 用户直接编辑 agentmux.config.json 写了个 999：读取路径也必须夹，不能只夹写入路径。
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      ...configWithFontSize(TERMINAL_FONT_SIZE_DEFAULT),
      appearance: { terminalTheme: 'graphite', terminalFontSize: 999 }
    }))
    const loaded = await store.get()
    expect(loaded.appearance.terminalFontSize).toBe(TERMINAL_FONT_SIZE_MAX)
  })

  it('小数被取整（不让分数格子度量落盘）', async () => {
    const { store } = await storeFixture()
    const saved = await store.save(configWithFontSize(TERMINAL_FONT_SIZE_MIN + 0.6))
    expect(saved.appearance.terminalFontSize).toBe(TERMINAL_FONT_SIZE_MIN + 1)
  })

  it('范围内的字号原样保留（clamp 不是无条件复位成默认）', async () => {
    const inRange = Math.round((TERMINAL_FONT_SIZE_MIN + TERMINAL_FONT_SIZE_MAX) / 2)
    const { store } = await storeFixture()
    const saved = await store.save(configWithFontSize(inRange))
    expect(saved.appearance.terminalFontSize).toBe(inRange)
    expect(inRange).not.toBe(TERMINAL_FONT_SIZE_DEFAULT)
  })
})

describe('clampTerminalFontSize is the single clamp function', () => {
  it('夹两端、取整、把非有限值退回默认（而不是退到某个边界）', () => {
    expect(clampTerminalFontSize(900)).toBe(TERMINAL_FONT_SIZE_MAX)
    expect(clampTerminalFontSize(0)).toBe(TERMINAL_FONT_SIZE_MIN)
    expect(clampTerminalFontSize(12.6)).toBe(13)
    // NaN 不是「太小」，是「没有值」——退回默认，别静默夹成 min。
    expect(clampTerminalFontSize(Number.NaN)).toBe(TERMINAL_FONT_SIZE_DEFAULT)
    expect(clampTerminalFontSize(Number.POSITIVE_INFINITY)).toBe(TERMINAL_FONT_SIZE_DEFAULT)
  })
})

describe('the render path does NOT re-clamp (clamp lives only at persistence)', () => {
  it('terminalOptions 原样透传一个越界值，不自己夹', () => {
    // 若 terminal-theme 也调 clampTerminalFontSize，这里会得到夹过的值，判据随之改变——那正是
    // 「clamp 归属散成两处」的信号。渲染层信任持久化过的值：传 900 就得到 900。
    const outOfRange = TERMINAL_FONT_SIZE_MAX + 100
    expect(terminalOptions('graphite', outOfRange).fontSize).toBe(outOfRange)
  })
})
