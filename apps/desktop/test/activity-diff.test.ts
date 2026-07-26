import { describe, expect, it } from 'vitest'
import {
  MAX_DIFF_LINES,
  parseUnifiedDiff,
  toolCallToDiff,
  type DiffLine
} from '../src/renderer/src/lib/activity-diff.js'

/**
 * 编辑工具入参 → 可显示 diff 行。守的几件事：
 *  - 坏 JSON 返回 null 而不抛（上游没有 try/catch，一抛整行白屏）；
 *  - 截断是显式信号，不是静默少几行；
 *  - MultiEdit 各条编辑之间有可见边界，不连成一片；
 *  - 普通文本（Markdown 列表）不会被误认成 diff。
 */

const stringify = JSON.stringify

/** 只挑出真正变动的行，断言时不必手写一长串 context。 */
function changes(lines: DiffLine[]): { kind: DiffLine['kind']; text: string }[] {
  return lines.filter((l) => l.kind === 'added' || l.kind === 'removed')
}

describe('toolCallToDiff — Edit', () => {
  it('把 old_string/new_string 摆成先删后增，两头相同行留作 context', () => {
    const diff = toolCallToDiff(
      'Edit',
      stringify({ file_path: '/w/a.ts', old_string: 'const a = 1\nkeep\n', new_string: 'const a = 2\nkeep\n' })
    )
    expect(diff).not.toBeNull()
    expect(diff!.filePath).toBe('/w/a.ts')
    expect(diff!.truncated).toBe(false)
    expect(changes(diff!.lines)).toEqual([
      { kind: 'removed', text: 'const a = 1' },
      { kind: 'added', text: 'const a = 2' }
    ])
    // 相同的尾行是 context，不能被算成一次删+增。
    expect(diff!.lines.some((l) => l.kind === 'context' && l.text === 'keep')).toBe(true)
  })

  it('缺 new_string 不成其为编辑，返回 null', () => {
    expect(toolCallToDiff('Edit', stringify({ file_path: '/w/a.ts', old_string: 'x' }))).toBeNull()
  })

  it('公共前缀被掐掉，不会把没变的开头行当成改动', () => {
    const diff = toolCallToDiff(
      'Edit',
      stringify({ old_string: 'same\nold', new_string: 'same\nnew' })
    )
    expect(changes(diff!.lines)).toEqual([
      { kind: 'removed', text: 'old' },
      { kind: 'added', text: 'new' }
    ])
    // 没给 file_path：这个键要根本不存在，不是 undefined（exactOptionalPropertyTypes）。
    expect('filePath' in diff!).toBe(false)
  })
})

describe('toolCallToDiff — Write', () => {
  it('整份 content 都是新增行', () => {
    const diff = toolCallToDiff('Write', stringify({ file_path: '/w/n.ts', content: 'line1\nline2\n' }))
    expect(diff!.lines).toEqual([
      { kind: 'added', text: 'line1' },
      { kind: 'added', text: 'line2' }
    ])
    expect(diff!.filePath).toBe('/w/n.ts')
  })

  it('末尾换行不会凭空多出一行空的新增行', () => {
    const diff = toolCallToDiff('Write', stringify({ content: 'only\n' }))
    expect(diff!.lines).toEqual([{ kind: 'added', text: 'only' }])
  })

  it('空 content 没有可显示的行，返回 null', () => {
    expect(toolCallToDiff('Write', stringify({ file_path: '/w/n.ts', content: '' }))).toBeNull()
  })
})

describe('toolCallToDiff — MultiEdit', () => {
  it('每条编辑之间有可见的 hunk 边界', () => {
    const diff = toolCallToDiff(
      'MultiEdit',
      stringify({
        file_path: '/w/m.ts',
        edits: [
          { old_string: 'a', new_string: 'A' },
          { old_string: 'b', new_string: 'B' }
        ]
      })
    )
    const hunks = diff!.lines.filter((l) => l.kind === 'hunk')
    expect(hunks).toHaveLength(2)
    expect(hunks[0]!.text).toBe('@@ edit 1 @@')
    expect(hunks[1]!.text).toBe('@@ edit 2 @@')
    expect(changes(diff!.lines)).toEqual([
      { kind: 'removed', text: 'a' },
      { kind: 'added', text: 'A' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'B' }
    ])
  })

  it('有一条编辑形状不对就整体返回 null，不半渲染谎报改动', () => {
    const diff = toolCallToDiff(
      'MultiEdit',
      stringify({ edits: [{ old_string: 'a', new_string: 'A' }, { old_string: 'b' }] })
    )
    expect(diff).toBeNull()
  })

  it('空 edits 数组返回 null', () => {
    expect(toolCallToDiff('MultiEdit', stringify({ edits: [] }))).toBeNull()
  })
})

describe('toolCallToDiff — 健壮性', () => {
  it('坏 JSON 返回 null 而不抛', () => {
    expect(() => toolCallToDiff('Edit', '{not json')).not.toThrow()
    expect(toolCallToDiff('Edit', '{not json')).toBeNull()
  })

  it('JSON 是数组或标量（非对象）时返回 null', () => {
    expect(toolCallToDiff('Edit', '[1,2,3]')).toBeNull()
    expect(toolCallToDiff('Edit', '"just a string"')).toBeNull()
    expect(toolCallToDiff('Write', '42')).toBeNull()
  })

  it('不认识的工具名返回 null', () => {
    expect(toolCallToDiff('Bash', stringify({ command: 'ls' }))).toBeNull()
    // 精确匹配：大小写/变体不算。
    expect(toolCallToDiff('edit', stringify({ old_string: 'a', new_string: 'b' }))).toBeNull()
  })

  it('超过上限时截断并显式置 truncated', () => {
    const content = Array.from({ length: MAX_DIFF_LINES + 50 }, (_, i) => `line ${i}`).join('\n')
    const diff = toolCallToDiff('Write', stringify({ content }))
    expect(diff!.truncated).toBe(true)
    expect(diff!.lines).toHaveLength(MAX_DIFF_LINES)
  })

  it('刚好等于上限时不截断', () => {
    const content = Array.from({ length: MAX_DIFF_LINES }, (_, i) => `line ${i}`).join('\n')
    const diff = toolCallToDiff('Write', stringify({ content }))
    expect(diff!.truncated).toBe(false)
    expect(diff!.lines).toHaveLength(MAX_DIFF_LINES)
  })
})

describe('parseUnifiedDiff', () => {
  it('解析带 @@ 段头的 unified diff', () => {
    const text = ['@@ -1,3 +1,3 @@', ' context', '-old line', '+new line', ' tail'].join('\n')
    const diff = parseUnifiedDiff(text)
    expect(diff).not.toBeNull()
    expect(diff!.lines).toEqual([
      { kind: 'hunk', text: '@@ -1,3 +1,3 @@' },
      { kind: 'context', text: 'context' },
      { kind: 'removed', text: 'old line' },
      { kind: 'added', text: 'new line' },
      { kind: 'context', text: 'tail' }
    ])
  })

  it('解析 ```diff 围栏，剥掉围栏本身', () => {
    const text = ['```diff', '-was', '+now', '```'].join('\n')
    const diff = parseUnifiedDiff(text)
    expect(diff).not.toBeNull()
    expect(changes(diff!.lines)).toEqual([
      { kind: 'removed', text: 'was' },
      { kind: 'added', text: 'now' }
    ])
  })

  it('Markdown 列表不是 diff——没有围栏也没有 @@，返回 null', () => {
    // 这条守的就是"别把 `- 买牛奶` 染成删除行"。
    const text = ['- 买牛奶', '- 买鸡蛋', '+ 备注：记得找零'].join('\n')
    expect(parseUnifiedDiff(text)).toBeNull()
  })

  it('带 @@ 段头即算 diff——哪怕这一段只有 context', () => {
    // "是不是 diff" 的门槛是围栏或 @@，不是"有没有改动"：@@ 是 unified diff 的自证，
    // 认下它才不会把一次纯 context 的 hunk 漏掉。
    const text = ['@@ -1 +1 @@', ' unchanged only'].join('\n')
    const diff = parseUnifiedDiff(text)
    expect(diff).not.toBeNull()
    expect(diff!.lines).toEqual([
      { kind: 'hunk', text: '@@ -1 +1 @@' },
      { kind: 'context', text: 'unchanged only' }
    ])
  })

  it('文件头 --- / +++ 归为结构行，不当成删除/新增', () => {
    const text = ['--- a/f.ts', '+++ b/f.ts', '@@ -1 +1 @@', '-x', '+y'].join('\n')
    const diff = parseUnifiedDiff(text)
    const headers = diff!.lines.filter((l) => l.kind === 'hunk').map((l) => l.text)
    expect(headers).toContain('--- a/f.ts')
    expect(headers).toContain('+++ b/f.ts')
    expect(changes(diff!.lines)).toEqual([
      { kind: 'removed', text: 'x' },
      { kind: 'added', text: 'y' }
    ])
  })

  it('CRLF 的 \\r 被剥掉', () => {
    const text = ['@@ -1 +1 @@', '-old\r', '+new\r'].join('\n')
    const diff = parseUnifiedDiff(text)
    expect(changes(diff!.lines)).toEqual([
      { kind: 'removed', text: 'old' },
      { kind: 'added', text: 'new' }
    ])
  })

  it('围栏内无前缀的行当作 context 收下', () => {
    const text = ['```diff', 'bare context line', '+added'].join('\n') + '\n```'
    const diff = parseUnifiedDiff(text)
    expect(diff).not.toBeNull()
    expect(diff!.lines).toContainEqual({ kind: 'context', text: 'bare context line' })
  })

  it('超长 unified diff 也会截断', () => {
    const rows = ['@@ -1 +1 @@']
    for (let i = 0; i < MAX_DIFF_LINES + 20; i += 1) rows.push(`+line ${i}`)
    const diff = parseUnifiedDiff(rows.join('\n'))
    expect(diff!.truncated).toBe(true)
    expect(diff!.lines).toHaveLength(MAX_DIFF_LINES)
  })
})
