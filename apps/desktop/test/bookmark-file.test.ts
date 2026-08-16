import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@agentmux/core'

import {
  BOOKMARK_FILE_EXTENSIONS,
  bookmarkFileNameFromTitle,
  bookmarkKindForPath,
  emitBookmark,
  emitUrlShortcut,
  emitWebloc,
  isBinaryContent,
  parseBookmarkUrl,
  parseUrlShortcutUrl,
  parseWeblocUrl
} from '../src/shared/bookmark-file.js'
import { readWeblocUrl } from '../src/main/bookmark-file.js'

/**
 * T-001：书签格式的纯判定与发射。
 *
 * 关键的几条不是「断言字符串里含某子串」，而是**真的跑 macOS 的 `plutil`**：
 *  - 发射物过 `plutil -lint`（缺 DOCTYPE / 标签不闭合的串照样能过 toContain，但 Finder 不认）；
 *  - `&`/`<` 转义后**往返**逐字相等（只断言含子串的话，不转义的实现也能过）；
 *  - 解析要认二进制——喂真的 `bplist00`（`plutil -convert binary1` 产出），不是只喂 XML。
 *
 * `shared/bookmark-file.ts` 是纯模块：这个测试 import 它不需要任何 electron mock（acceptance 一条）。
 * `main/bookmark-file.ts` 的 `readWeblocUrl` 注入 `runProcess`（真的），走真 `plutil` 认二进制。
 */

const NUL = String.fromCharCode(0)

/** 真的调用 `plutil -lint`：写到临时文件再 lint（`plutil -lint` 要一个文件路径）。 */
function plutilLint(content: string): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agentmux-webloc-'))
  const path = join(dir, 'bookmark.webloc')
  writeFileSync(path, content)
  try {
    const output = execFileSync('/usr/bin/plutil', ['-lint', path], { encoding: 'utf8' })
    return { ok: /\bOK\b/.test(output), output }
  } catch (error) {
    return { ok: false, output: String((error as { stdout?: string }).stdout ?? error) }
  }
}

/** 用 `plutil -convert binary1` 把一份 XML plist 变成真的二进制（`bplist00` 开头）。 */
function toBinaryPlist(xml: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'agentmux-webloc-bin-'))
  const src = join(dir, 'src.webloc')
  const out = join(dir, 'out.webloc')
  writeFileSync(src, xml)
  execFileSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', out, src])
  return readFileSync(out)
}

describe('bookmark extension SSOT', () => {
  it('recognizes both extensions from a path, case-insensitively, and rejects non-bookmarks', () => {
    // 整份元组钉死（房规：钉死集合而非用 every，避免空集合下的白绿）。
    expect([...BOOKMARK_FILE_EXTENSIONS]).toEqual(['webloc', 'url'])
    expect(bookmarkKindForPath('/ws/Example.webloc')).toBe('webloc')
    expect(bookmarkKindForPath('/ws/Deep/site.URL')).toBe('url')
    expect(bookmarkKindForPath('/ws/notes.md')).toBeNull()
    expect(bookmarkKindForPath('/ws/.webloc')).toBeNull() // 无名点文件不是书签
    expect(bookmarkKindForPath('/ws/README')).toBeNull()
  })
})

describe('.webloc emission is real plist that plutil accepts', () => {
  it('emits a plist that passes plutil -lint', () => {
    const lint = plutilLint(emitWebloc('https://example.com/'))
    expect(lint.ok, lint.output).toBe(true)
  })

  it('escapes & and < and round-trips the URL byte-for-byte through a real plutil parse', async () => {
    const url = 'https://example.com/path?a=1&b=2&x=<y>&q="z"'
    const xml = emitWebloc(url)
    // 转义后仍是合法 plist。
    expect(plutilLint(xml).ok).toBe(true)
    // 原始 & 与 < 不能裸奔（否则不是合法 XML）。
    expect(xml).toContain('&amp;')
    expect(xml).toContain('&lt;')
    // 往返：我们自己的解析回来逐字相等……
    expect(parseWeblocUrl(xml)).toBe(url)
    // ……而且真的 plutil 转一遍（xml1→xml1）后取回来也逐字相等。
    const roundTripped = await runProcess('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '-'], {
      input: xml
    })
    expect(roundTripped.exitCode).toBe(0)
    expect(parseWeblocUrl(roundTripped.stdout)).toBe(url)
  })
})

describe('.url emission matches real on-disk samples (LF, single URL= line)', () => {
  it('is [InternetShortcut] then URL=, LF not CRLF, no extra keys', () => {
    const text = emitUrlShortcut('https://example.com/x')
    expect(text).toBe('[InternetShortcut]\nURL=https://example.com/x\n')
    expect(text).not.toContain('\r') // LF, 不是 CRLF
    // 只有这两行有内容（本机五个真实样本全是纯一行 URL=）。
    expect(text.split('\n').filter((line) => line.length > 0)).toEqual([
      '[InternetShortcut]',
      'URL=https://example.com/x'
    ])
  })

  it('emitBookmark dispatches by kind', () => {
    expect(emitBookmark('webloc', 'https://a')).toContain('<key>URL</key>')
    expect(emitBookmark('url', 'https://a')).toBe('[InternetShortcut]\nURL=https://a\n')
  })
})

describe('parsing returns null (never throws) on inputs with no URL', () => {
  it.each([
    ['empty string', ''],
    ['not a plist', 'just some text'],
    ['plist without a URL key', '<plist><dict><key>Other</key><string>x</string></dict></plist>'],
    ['InternetShortcut without URL=', '[InternetShortcut]\nIconIndex=0\n']
  ])('%s -> null', (_label, input) => {
    expect(() => parseWeblocUrl(input)).not.toThrow()
    expect(() => parseUrlShortcutUrl(input)).not.toThrow()
    // 两种解析器对「取不出」都返回 null。
    expect(parseWeblocUrl(input) ?? parseUrlShortcutUrl(input)).toBeNull()
  })

  it('parseBookmarkUrl extracts from valid content of each kind', () => {
    expect(parseBookmarkUrl('webloc', emitWebloc('https://x/y'))).toBe('https://x/y')
    expect(parseBookmarkUrl('url', emitUrlShortcut('https://x/y'))).toBe('https://x/y')
  })
})

describe('binary detection is by NUL, not by extension or parse failure', () => {
  it('a valid XML plist is not binary; a byte stream with NUL is', () => {
    expect(isBinaryContent(emitWebloc('https://x'))).toBe(false)
    // 一个我们没料到的、合法但奇怪的 XML 变体（多了注释/属性）——不能被误判成二进制。
    expect(isBinaryContent('<?xml version="1.0"?><!-- hi --><plist><dict/></plist>')).toBe(false)
    expect(isBinaryContent(`bplist00${NUL}garbage`)).toBe(true)
  })
})

describe('opening a real binary .webloc extracts the URL via plutil', () => {
  it('reads the URL from a genuine bplist00 file (not just XML)', async () => {
    const url = 'https://example.com/binary?a=1&b=2'
    const binary = toBinaryPlist(emitWebloc(url))
    // 坐实它真是二进制：起头是 bplist00，且含 NUL。
    expect(binary.subarray(0, 8).toString('latin1')).toBe('bplist00')
    const asString = binary.toString('utf8')
    expect(isBinaryContent(asString)).toBe(true)
    // 纯文本解析对二进制取不出（这正是要走 plutil 的理由）。
    expect(parseWeblocUrl(asString)).toBeNull()
    // 打开路径：注入真的 runProcess，喂 raw 字节，plutil 转 XML 后取回逐字相等。
    const opened = await readWeblocUrl(binary, runProcess)
    expect(opened).toBe(url)
  })

  it('reads an XML .webloc without shelling out at all', async () => {
    const url = 'https://example.com/text'
    let called = false
    const runner = (async () => {
      called = true
      return { stdout: '', stderr: '', exitCode: 0 }
    }) as unknown as typeof runProcess
    expect(await readWeblocUrl(new TextEncoder().encode(emitWebloc(url)), runner)).toBe(url)
    expect(called).toBe(false) // 文本不 shell 出去
  })

  it('returns null when plutil fails, never throws', async () => {
    const badBytes = new TextEncoder().encode(`bplist00${NUL}bad`)
    // stdout **含一个能解析出的 URL**：这样返回 null 的唯一原因是 exitCode 守卫，而不是 stdout 恰好空。
    // （否则删掉 `exitCode !== 0` 守卫这条变异会存活——实测过。）
    const failing = (async () => ({
      stdout: emitWebloc('https://should-be-ignored/'),
      stderr: 'boom',
      exitCode: 1
    })) as unknown as typeof runProcess
    expect(await readWeblocUrl(badBytes, failing)).toBeNull()
    const throwing = (async () => { throw new Error('no plutil') }) as unknown as typeof runProcess
    expect(await readWeblocUrl(badBytes, throwing)).toBeNull()
  })
})

describe('file name derivation is a safety boundary', () => {
  it.each([
    ['a title with a slash', 'AT&T / Home', 'AT&T Home'],
    ['a title with a colon', 'News: Today', 'News Today'],
    ['a windows path separator', 'a\\b', 'a b'],
    ['a NUL in the title', `evil${NUL}name`, 'evil name'],
    ['collapses whitespace', '  multiple   spaces  ', 'multiple spaces']
  ])('%s -> safe name', (_label, title, expected) => {
    const name = bookmarkFileNameFromTitle(title)
    expect(name).toBe(expected)
    expect(name).not.toContain('/')
    expect(name).not.toContain('\\')
    expect(name).not.toContain(NUL)
  })

  it('empty or whitespace-only titles fall back to a constant', () => {
    expect(bookmarkFileNameFromTitle('')).toBe('Bookmark')
    expect(bookmarkFileNameFromTitle('   ')).toBe('Bookmark')
    expect(bookmarkFileNameFromTitle('...')).toBe('Bookmark')
  })

  it('keeps ordinary punctuation like hyphens', () => {
    expect(bookmarkFileNameFromTitle('My Cool-Page v2')).toBe('My Cool-Page v2')
  })
})
