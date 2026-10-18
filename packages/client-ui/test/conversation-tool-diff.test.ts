import { describe, expect, it } from 'vitest'
import { MAX_DIFF_LINES, parseUnifiedDiff, toolEditDiff, type DiffLine } from '../src/lib/conversation-tool-diff'

const changes = (lines: DiffLine[]) => lines.filter(line => line.kind === 'added' || line.kind === 'removed')

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

it('formats requested replacements and keeps shared prefix and suffix as context', () => {
  const diff = toolEditDiff({ filePath: 'src/answer.ts', edits: [{ before: 'prefix\nold\nsuffix', after: 'prefix\nnew\nsuffix' }] })!
  expect(diff.lines).toEqual([{ kind: 'context', text: 'prefix' }, { kind: 'removed', text: 'old' }, { kind: 'added', text: 'new' }, { kind: 'context', text: 'suffix' }])
  expect(diff.filePath).toBe('src/answer.ts'); expect(diff.truncated).toBe(false)
})
it('keeps ordered edit boundaries and declares the bounded preview', () => {
  expect(toolEditDiff({ edits: [{ before: 'a', after: 'A' }, { before: 'b', after: 'B' }] })!.lines.filter(line => line.kind === 'hunk').map(line => line.text)).toEqual(['@@ edit 1 @@', '@@ edit 2 @@'])
  for (const extra of [0, 1]) {
    const preview = toolEditDiff({ edits: [{ after: Array.from({ length: MAX_DIFF_LINES + extra }, (_, i) => String(i)).join('\n') }] })!
    expect(preview.lines).toHaveLength(MAX_DIFF_LINES); expect(preview.truncated).toBe(extra > 0)
  }
  expect(toolEditDiff({ edits: [{ after: '' }] })).toBeNull()
  let visited = 0
  const emptyEdits = new Proxy(Array.from({ length: 1000 }, () => ({ before: '', after: '' })), {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) visited += 1
      return Reflect.get(target, key, receiver)
    }
  })
  expect(toolEditDiff({ edits: emptyEdits })).toMatchObject({ truncated: true })
  expect(visited).toBeLessThanOrEqual(MAX_DIFF_LINES + 1)
})

it('bounds a large valid write or replacement without spreading lines as call arguments', () => {
  const large = 'x\n'.repeat(180000)
  for (const edit of [{ after: large }, { before: '', after: large }]) {
    const preview = toolEditDiff({ edits: [edit] })!
    expect(preview.truncated).toBe(true); expect(preview.lines).toHaveLength(MAX_DIFF_LINES)
  }
})
