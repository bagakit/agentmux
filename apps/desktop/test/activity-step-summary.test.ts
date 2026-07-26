import { describe, expect, it } from 'vitest'
import {
  MAX_STEP_SUMMARY_LENGTH,
  stepSummary,
  stepTitle
} from '../src/renderer/src/lib/activity-step-summary.js'

// 用户要的是：折叠状态本身可读——不展开就知道那步干了什么。三行裸 `Bash` 满足不了这件事。

describe('参数摘要', () => {
  it('跑命令取命令本身', () => {
    expect(stepSummary('Bash', JSON.stringify({ command: 'pnpm test' }))).toBe('pnpm test')
  })

  it('读文件取路径', () => {
    expect(stepSummary('Read', JSON.stringify({ file_path: '/repo/src/a.ts' }))).toBe('/repo/src/a.ts')
  })

  it('按工具种类取该取的那个字段，而不是碰上哪个算哪个', () => {
    // 同一份入参喂给两个工具，取出来的必须是不同的字段。若实现改成"取第一个字符串值"，
    // 两边会返回同一个东西，这条会红。
    const input = JSON.stringify({ command: 'rm -rf /', file_path: '/repo/a.ts' })
    expect(stepSummary('Bash', input)).toBe('rm -rf /')
    expect(stepSummary('Read', input)).toBe('/repo/a.ts')
  })

  it('工具名大小写不影响查表', () => {
    expect(stepSummary('bash', JSON.stringify({ command: 'ls' }))).toBe('ls')
    expect(stepSummary('BASH', JSON.stringify({ command: 'ls' }))).toBe('ls')
  })

  it('不认识的工具如实返回 null，不去猜一个字段', () => {
    // 猜错的摘要比没有摘要更坏：它看起来像已核实的事实。
    expect(stepSummary('MysteryTool', JSON.stringify({ command: 'ls', anything: 'x' }))).toBeNull()
  })

  it('坏 JSON 返回 null 而不抛——读不懂入参不等于这一行该消失', () => {
    expect(stepSummary('Bash', '{not json')).toBeNull()
    expect(stepSummary('Bash', '"a string"')).toBeNull()
    expect(stepSummary('Bash', '[1,2]')).toBeNull()
  })

  it('字段缺失或不是字符串时返回 null', () => {
    expect(stepSummary('Bash', JSON.stringify({ notCommand: 'ls' }))).toBeNull()
    expect(stepSummary('Bash', JSON.stringify({ command: 42 }))).toBeNull()
    expect(stepSummary('Bash', JSON.stringify({ command: '   ' }))).toBeNull()
  })

  it('toolName 或入参缺失时返回 null——不拿展示标题去凑', () => {
    expect(stepSummary(undefined, JSON.stringify({ command: 'ls' }))).toBeNull()
    expect(stepSummary('Bash', undefined)).toBeNull()
  })

  it('候选字段按顺序取第一个非空的', () => {
    expect(stepSummary('Read', JSON.stringify({ path: '/b.ts' }))).toBe('/b.ts')
    // file_path 排在 path 前面，两个都在时取前者。
    expect(stepSummary('Read', JSON.stringify({ file_path: '/a.ts', path: '/b.ts' }))).toBe('/a.ts')
  })

  it('换行与制表符压成单个空格——标题只占一行', () => {
    expect(stepSummary('Bash', JSON.stringify({ command: 'a\n\tb   c' }))).toBe('a b c')
  })

  it('超长命令被截断，不把时间偏移挤出可视区', () => {
    const long = 'x'.repeat(200)
    const summary = stepSummary('Bash', JSON.stringify({ command: long }))
    expect(summary).not.toBeNull()
    expect(summary!.length).toBeLessThanOrEqual(MAX_STEP_SUMMARY_LENGTH)
    expect(summary!.endsWith('…')).toBe(true)
  })

  it('刚好等于上界的不被截断', () => {
    const exact = 'y'.repeat(MAX_STEP_SUMMARY_LENGTH)
    expect(stepSummary('Bash', JSON.stringify({ command: exact }))).toBe(exact)
  })
})

describe('折叠行标题', () => {
  it('取得到就带上参数', () => {
    expect(stepTitle('Bash', 'Bash', JSON.stringify({ command: 'pnpm test' }))).toBe('Bash pnpm test')
  })

  it('取不到就只显示工具名，不显示空括号之类的空壳', () => {
    // 空壳会让人以为参数是空的，而事实是我们没读到。
    expect(stepTitle('Bash', 'Bash', '{bad')).toBe('Bash')
    expect(stepTitle('Mystery', 'Mystery', JSON.stringify({ a: 1 }))).toBe('Mystery')
    expect(stepTitle('Bash', undefined, undefined)).toBe('Bash')
  })
})
