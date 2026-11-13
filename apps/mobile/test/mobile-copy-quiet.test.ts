import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Ordinary phone copy speaks work language (docs/design/presentation/mobile-client.md, 文案). It
 * names the Mac, the conversation and the terminal, and says what happened and what the person can
 * do; it does not recite engineering guarantees. Exact identities and technical detail stay readable
 * in their details, written as data rather than as Chinese prose with engineering nouns.
 */
const root = join(__dirname, '../src')
const ENGINEERING = /回执|\b(?:Host|Runtime|Session|Run|RPC|PTY)\b|原(?!因|生|样|则|来|本|始|理|地|位|图|先|型|文(?!件))/u
const CHINESE_LITERAL = /(['"`])((?:(?!\1)[^\\]|\\.)*?[一-鿿](?:(?!\1)[^\\]|\\.)*?)\1/gu

/** Exact strings that must keep an engineering word, each with the reason. Keep this short. */
const ALLOWED = new Map<string, string>([
])

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/u.test(name) && !/\.test\.tsx?$/u.test(name) ? [path] : []
  })
}
export function engineeringCopy(paths: readonly string[]): string[] {
  const found: string[] = []
  for (const path of paths) {
    readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
      const code = line.trimStart()
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return
      for (const [, , text] of line.matchAll(CHINESE_LITERAL)) {
        if (text && ENGINEERING.test(text) && !ALLOWED.has(text)) found.push(`${relative(root, path)}:${index + 1}  ${text}`)
      }
    })
  }
  return found
}

const all = files(root)
const groups = new Map<string, string[]>()
for (const path of all) {
  const top = relative(root, path).split('/')
  const key = top.length > 1 ? top[0]! : '(root)'
  groups.set(key, [...groups.get(key) ?? [], path])
}

describe('ordinary phone copy', () => {
  it('scans real production files, and the detector catches each engineering form', () => {
    expect(all.length).toBeGreaterThan(100)
    for (const sample of ['答复回执未知', '原 Host 已改变', '原请求保留', 'Session 不可用', '原文件已保存']) expect(ENGINEERING.test(sample), sample).toBe(true)
    for (const sample of ['原因：网络中断', '复制原文', '原生终端', '已答复', 'Mac 连接中断']) expect(ENGINEERING.test(sample), sample).toBe(false)
    for (const text of ALLOWED.keys()) expect(ENGINEERING.test(text), text).toBe(true)
  })
  for (const [group, paths] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    it(`${group} uses work language`, () => { expect(engineeringCopy(paths)).toEqual([]) })
  }
})
