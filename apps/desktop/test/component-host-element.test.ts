import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resolveHostElement } from './helpers/component-host-element.js'

/**
 * `resolveHostElement` 自己的判据。
 *
 * 它是 `launcher-submit` 与 `pr-launch` 两道判据的承重件：那两条断言现在问的是「onKeyDown 最终落在
 * 哪个 DOM 元素上」，答案整份由这个函数给出。**它一旦退化，那两条断言就退化成恒真而没有人会红。**
 * 这不是推测——把它整个改成 `return { tag: 'textarea', viaComponent: tagName,
 * forwardsCallerProps: true }`（函数体第一行插一句 return，其余一字不动）之后实测
 * `Test Files 2 passed (2)` / `Tests 40 passed (40)`：两个消费者一条都没红。本文件就是为杀掉那次
 * 变异存在的。
 *
 * 判据的形状：每个可能的返回值都要有至少一条用例**要求它不是别的值**。所以 `tag` 既有 textarea 的
 * 用例也有 div 的用例，`forwardsCallerProps` 既有 true 也有 false 的用例——任何常量返回都至少红一条。
 *
 * 用临时目录里的 fixture 而不是仓库里的样例文件：`composer-ime.test.ts` 有一条「整棵 renderer 源码树里
 * 只有壳自己渲染裸 textarea」的全树扫描，往树里放一个渲染 textarea 的样例文件会把它打红。
 */

let root: string

/** 写一对「消费者 + 它 import 的那层壳」，返回消费者文件的绝对路径。 */
function fixture(name: string, shellSource: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'Shell.tsx'), shellSource)
  const consumerPath = join(dir, 'Consumer.tsx')
  writeFileSync(
    consumerPath,
    `import { Shell } from './Shell.js'\nexport function Consumer() {\n  return <Shell onKeyDown={() => {}} />\n}\n`
  )
  return consumerPath
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agentmux-host-element-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('resolveHostElement 跟着 import 走到组件自己的根元素', () => {
  it('壳的根是 textarea 且整份转发 rest 时，答案是 textarea + 转发', () => {
    const consumer = fixture(
      'forwarding-textarea',
      `export function Shell({ value, ...rest }: { value: string }) {\n` +
        `  return <textarea {...rest} value={value} />\n` +
        `}\n`
    )
    expect(resolveHostElement(consumer, 'Shell')).toEqual({
      tag: 'textarea',
      viaComponent: 'Shell',
      forwardsCallerProps: true
    })
  })

  // 这一条与上一条成对：`tag` 的取值必须真的来自被解析的文件。只要有一个常量能同时满足两条，
  // 这个函数就可以整体退化而消费者不知道——那正是本文件文件头记的那次存活变异。
  it('壳的根换成 div 时，答案跟着变成 div——名字一个字都没改', () => {
    const consumer = fixture(
      'forwarding-div',
      `export function Shell({ value, ...rest }: { value: string }) {\n` +
        `  return <div {...rest} data-value={value} />\n` +
        `}\n`
    )
    expect(resolveHostElement(consumer, 'Shell').tag).toBe('div')
  })

  // 与第一条成对：`forwardsCallerProps` 也必须来自文件，不许是常量 true。
  it('根元素上没有 {...rest} 时，转发判成 false（调用方的属性到不了那个元素）', () => {
    const consumer = fixture(
      'swallowing-textarea',
      `export function Shell({ value, ...rest }: { value: string }) {\n` +
        `  return <textarea value={value} />\n` +
        `}\n`
    )
    const resolution = resolveHostElement(consumer, 'Shell')
    expect(resolution.tag, '根元素仍然是 textarea——这一条要单独把转发那一面钉住').toBe('textarea')
    expect(resolution.forwardsCallerProps).toBe(false)
  })

  // 展开的必须是**那个** rest 形参。展开别的对象在 React 里是合法代码，但调用方给的属性照旧丢掉。
  it('展开的是别的对象而不是 rest 形参时，转发判成 false', () => {
    const consumer = fixture(
      'spreads-other-object',
      `const preset = { rows: 3 }\n` +
        `export function Shell({ value, ...rest }: { value: string }) {\n` +
        `  return <textarea {...preset} value={value} />\n` +
        `}\n`
    )
    expect(resolveHostElement(consumer, 'Shell').forwardsCallerProps).toBe(false)
  })

  // #731：只认一种合法写法的判据会对正确代码打红，然后被下一个作者整条删掉。
  it('箭头函数绑定与整体形参这两种合法写法都认', () => {
    const arrow = fixture(
      'arrow-binding',
      `export const Shell = ({ value, ...rest }: { value: string }) => {\n` +
        `  return <textarea {...rest} value={value} />\n` +
        `}\n`
    )
    expect(resolveHostElement(arrow, 'Shell')).toEqual({
      tag: 'textarea',
      viaComponent: 'Shell',
      forwardsCallerProps: true
    })

    const wholeParam = fixture(
      'whole-parameter',
      `export function Shell(props: { value: string }) {\n` + `  return <input {...props} />\n` + `}\n`
    )
    expect(resolveHostElement(wholeParam, 'Shell')).toEqual({
      tag: 'input',
      viaComponent: 'Shell',
      forwardsCallerProps: true
    })
  })

  it('表达式体箭头函数（没有 return 语句）也能读出根元素', () => {
    const consumer = fixture(
      'expression-body',
      `export const Shell = ({ ...rest }: { value?: string }) => <textarea {...rest} />\n`
    )
    expect(resolveHostElement(consumer, 'Shell').tag).toBe('textarea')
  })

  it('属性里的箭头函数不会被当成本组件的返回', () => {
    const consumer = fixture(
      'nested-arrow',
      `export function Shell({ ...rest }: { value?: string }) {\n` +
        `  return <textarea {...rest} onFocus={() => { return <div /> }} />\n` +
        `}\n`
    )
    expect(resolveHostElement(consumer, 'Shell').tag).toBe('textarea')
  })
})

describe('认不出的形状一律响亮抛错，不许静默给一个像是答案的答案', () => {
  it('根是另一个组件时抛错并点名「只跟一层」这个缺口', () => {
    const consumer = fixture(
      'component-root',
      `import { Inner } from './Inner.js'\n` +
        `export function Shell({ ...rest }: { value?: string }) {\n` +
        `  return <Inner {...rest} />\n` +
        `}\n`
    )
    expect(() => resolveHostElement(consumer, 'Shell')).toThrow(/只跟一层/u)
  })

  it('根是 Fragment 时抛错——没有单一宿主元素能接住调用方的属性', () => {
    const consumer = fixture(
      'fragment-root',
      `export function Shell({ ...rest }: { value?: string }) {\n` +
        `  return <><textarea {...rest} /></>\n` +
        `}\n`
    )
    expect(() => resolveHostElement(consumer, 'Shell')).toThrow(/Fragment/u)
  })

  it('形参里没有 rest 元素时抛错——其余属性被就地丢掉了', () => {
    const consumer = fixture(
      'no-rest-element',
      `export function Shell({ value }: { value?: string }) {\n` +
        `  return <textarea value={value} />\n` +
        `}\n`
    )
    expect(() => resolveHostElement(consumer, 'Shell')).toThrow(/没有 rest 元素/u)
  })

  it('小写标签抛错——它本来就是 DOM 元素，调用方该自己分流', () => {
    const consumer = fixture('lowercase', `export function Shell() {\n  return <textarea />\n}\n`)
    expect(() => resolveHostElement(consumer, 'textarea')).toThrow(/DOM 标签而不是组件/u)
  })

  it('import 的不是相对路径时抛错——第三方组件的根元素无从解析', () => {
    const dir = join(root, 'third-party')
    mkdirSync(dir, { recursive: true })
    const consumerPath = join(dir, 'Consumer.tsx')
    writeFileSync(
      consumerPath,
      `import { Shell } from 'some-ui-kit'\nexport function Consumer() {\n  return <Shell />\n}\n`
    )
    expect(() => resolveHostElement(consumerPath, 'Shell')).toThrow(/不是相对路径/u)
  })

  it('消费者文件里根本没有绑定这个名字时抛错', () => {
    const consumer = fixture('unbound', `export function Shell() {\n  return <textarea />\n}\n`)
    expect(() => resolveHostElement(consumer, 'Missing')).toThrow(/没有任何 import 绑定/u)
  })
})
