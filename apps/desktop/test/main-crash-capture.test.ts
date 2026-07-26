import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import {
  appendWithinBudget,
  crashRecordFrom,
  serializeCrashRecord,
  type CrashRecord
} from '../src/main/crash-capture.js'
import { CrashLog } from '../src/main/crash-log.js'
import { crashReporterOptions, registerCrashCapture } from '../src/main/crash-capture-wiring.js'

/**
 * 崩溃事后可见的三层验证，逐层都有断言够得着：
 *  1. crashRecordFrom —— 四类来源各自归一成什么（纯函数，直接断言）。
 *  2. appendWithinBudget + CrashLog —— 体量上界，崩溃循环写不满盘。
 *  3. registerCrashCapture —— 接线：每类事件都挂上、都走归一、都进 sink。
 *  4. 隐私：crashReporter 恒不上传，CrashLog 只落本地文件、无网络出口。
 *
 * 归一逻辑抽成纯函数是因为 index.ts 的 electron API 在测试里跑不起来。接线用真的 EventEmitter
 * 喂事件，断言 sink 收到的记录——这才证明「能力接到了产品上」，而不只是纯逻辑自证。
 */

const FIXED_MS = Date.UTC(2026, 7, 30, 12, 0, 0)

describe('crashRecordFrom: 四类来源归一', () => {
  it('未捕获异常带上栈作为 detail', () => {
    const error = new Error('boom')
    error.stack = 'Error: boom\n    at somewhere'
    const record = crashRecordFrom({ kind: 'uncaught-exception', error }, FIXED_MS)
    expect(record).toEqual({
      at: '2026-08-30T12:00:00.000Z',
      kind: 'uncaught-exception',
      summary: 'boom',
      detail: 'Error: boom\n    at somewhere'
    })
  })

  it('非 Error 的 rejection 也能落成一句可读的 summary，没有栈就不带 detail', () => {
    const record = crashRecordFrom({ kind: 'unhandled-rejection', reason: { code: 42 } }, FIXED_MS)
    expect(record.kind).toBe('unhandled-rejection')
    expect(record.summary).toBe('{"code":42}')
    expect(record.detail).toBeUndefined()
  })

  it('渲染进程消失记下 reason/exitCode，URL 作为 detail', () => {
    const record = crashRecordFrom(
      { kind: 'render-process-gone', details: { reason: 'crashed', exitCode: 133 }, url: 'file:///renderer' },
      FIXED_MS
    )
    expect(record.summary).toBe('renderer crashed (exit 133)')
    expect(record.detail).toBe('file:///renderer')
  })

  it('子进程消失记下 type/reason/exitCode，服务名作为 detail', () => {
    const record = crashRecordFrom(
      { kind: 'child-process-gone', details: { type: 'GPU', reason: 'crashed', exitCode: 1, serviceName: 'gpu-process' } },
      FIXED_MS
    )
    expect(record.summary).toBe('GPU crashed (exit 1)')
    expect(record.detail).toBe('gpu-process')
  })
})

describe('appendWithinBudget: 体量有硬顶，旧行滚掉', () => {
  it('总量超上界时从最旧的行开始丢，新行始终保留', () => {
    const line = 'x'.repeat(20)
    let content = ''
    for (let i = 0; i < 10; i += 1) content = appendWithinBudget(content, `${line}-${i}`, 80)
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(80)
    // 最新的一行必须还在，最旧的必须已经被挤掉。
    expect(content).toContain(`${line}-9`)
    expect(content).not.toContain(`${line}-0`)
    // 每一行都完整以换行结尾，读取端按行切不会读到半条。
    expect(content.endsWith('\n')).toBe(true)
  })

  it('单条巨型记录截断到上界，绝不越界', () => {
    const huge = 'y'.repeat(500)
    const result = appendWithinBudget('', huge, 64)
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(64)
    expect(result.endsWith('\n')).toBe(true)
  })
})

describe('CrashLog: 落盘只在本地，体量受控', () => {
  async function tempLog(maxBytes: number): Promise<{ log: CrashLog; path: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'agentmux-crashlog-'))
    const path = join(dir, 'crash-log.ndjson')
    return { log: new CrashLog(path, maxBytes), path }
  }

  it('多次追加后文件是有效 NDJSON，且不超过上界', async () => {
    const { log, path } = await tempLog(400)
    for (let i = 0; i < 12; i += 1) {
      await log.append({ at: new Date(FIXED_MS + i).toISOString(), kind: 'uncaught-exception', summary: `err-${i}` })
    }
    const content = await readFile(path, 'utf8')
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(400)
    const parsed = content.split('\n').filter(Boolean).map((l) => JSON.parse(l) as CrashRecord)
    expect(parsed.length).toBeGreaterThan(0)
    // 最新的一条一定在，最旧的一定被滚掉。
    expect(parsed.some((r) => r.summary === 'err-11')).toBe(true)
    expect(parsed.some((r) => r.summary === 'err-0')).toBe(false)
  })
})

describe('隐私：只落盘，不上传', () => {
  it('crashReporter 选项恒不上传，且不含任何 submitURL', () => {
    const options = crashReporterOptions()
    expect(options.uploadToServer).toBe(false)
    // 不上传不是靠「没写上传代码」，而是这个选项对象里根本没有服务器地址。
    expect((options as Record<string, unknown>).submitURL).toBeUndefined()
  })

  it('CrashLog 源码里没有任何网络出口', async () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = await readFile(join(here, '../src/main/crash-log.ts'), 'utf8')
    expect(source.length).toBeGreaterThan(0)
    // 这层的「不上传」是结构性的：整个文件不 import/调用任何网络 API。
    expect(source).not.toMatch(/\bfetch\b|node:https?|node:net|XMLHttpRequest|net\.connect|https?\.request/)
  })
})

describe('registerCrashCapture: 四类事件都接到 sink', () => {
  function harness() {
    const fakeApp = new EventEmitter()
    const fakeProcess = new EventEmitter()
    const records: CrashRecord[] = []
    const dispose = registerCrashCapture({
      app: fakeApp as never,
      process: fakeProcess as never,
      sink: (record) => {
        records.push(record)
      },
      now: () => FIXED_MS,
      logStderr: () => {}
    })
    return { fakeApp, fakeProcess, records, dispose }
  }

  it('uncaughtException 进 sink', () => {
    const { fakeProcess, records } = harness()
    fakeProcess.emit('uncaughtException', new Error('main died'))
    expect(records).toHaveLength(1)
    expect(records[0]?.kind).toBe('uncaught-exception')
    expect(records[0]?.summary).toBe('main died')
  })

  it('unhandledRejection 进 sink', () => {
    const { fakeProcess, records } = harness()
    fakeProcess.emit('unhandledRejection', new Error('no one caught me'))
    expect(records).toHaveLength(1)
    expect(records[0]?.kind).toBe('unhandled-rejection')
  })

  it('render-process-gone 进 sink，且带上 webContents 的 URL', () => {
    const { fakeApp, records } = harness()
    fakeApp.emit('render-process-gone', {}, { getURL: () => 'file:///r' }, { reason: 'crashed', exitCode: 5 })
    expect(records).toHaveLength(1)
    expect(records[0]?.kind).toBe('render-process-gone')
    expect(records[0]?.detail).toBe('file:///r')
  })

  it('child-process-gone 进 sink', () => {
    const { fakeApp, records } = harness()
    fakeApp.emit('child-process-gone', {}, { type: 'Utility', reason: 'crashed', exitCode: 9 })
    expect(records).toHaveLength(1)
    expect(records[0]?.kind).toBe('child-process-gone')
  })

  it('disposer 摘除监听后事件不再进 sink', () => {
    const { fakeProcess, records, dispose } = harness()
    dispose()
    fakeProcess.emit('uncaughtException', new Error('after dispose'))
    expect(records).toHaveLength(0)
  })

  it('sink 同步抛出不会把崩溃处理器搞崩，且失败落到 stderr', () => {
    const fakeApp = new EventEmitter()
    const fakeProcess = new EventEmitter()
    const stderr: string[] = []
    registerCrashCapture({
      app: fakeApp as never,
      process: fakeProcess as never,
      sink: () => {
        throw new Error('disk full')
      },
      now: () => FIXED_MS,
      logStderr: (line) => stderr.push(line)
    })
    // 不抛即通过：留证失败绝不放大故障。
    expect(() => fakeProcess.emit('uncaughtException', new Error('x'))).not.toThrow()
    // 但失败必须可见——落到 stderr，不许悄悄吞掉。
    expect(stderr.some((l) => l.includes('crash sink failed') && l.includes('disk full'))).toBe(true)
  })

  it('sink 异步 reject 也落到 stderr，不变成又一个没人接的 rejection', async () => {
    const fakeApp = new EventEmitter()
    const fakeProcess = new EventEmitter()
    const stderr: string[] = []
    registerCrashCapture({
      app: fakeApp as never,
      process: fakeProcess as never,
      sink: () => Promise.reject(new Error('async disk full')),
      now: () => FIXED_MS,
      logStderr: (line) => stderr.push(line)
    })
    fakeProcess.emit('uncaughtException', new Error('x'))
    // 让微任务队列排空，异步 reject 的 catch 才跑到。
    await Promise.resolve()
    await Promise.resolve()
    expect(stderr.some((l) => l.includes('crash sink failed') && l.includes('async disk full'))).toBe(true)
  })
})

describe('index.ts 接线守卫（源码扫描）', () => {
  it('index.ts 真的启动了 crashReporter 并挂上了 registerCrashCapture', async () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = (await readFile(join(here, '../src/main/index.ts'), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    expect(source.length).toBeGreaterThan(0)
    // electron 在测试里起不来，index.ts 不可导入；扫源码断言接线还在，删掉任一句都会红。
    expect(source).toContain('crashReporter.start(crashReporterOptions())')
    expect(source).toContain('registerCrashCapture(')
    expect(source).toContain('new CrashLog()')
  })
})

// serializeCrashRecord 被 CrashLog 内部用；这里点一下它就是一行 JSON，防止有人把它改成多行。
describe('serializeCrashRecord', () => {
  it('是不含换行的单行 JSON', () => {
    const line = serializeCrashRecord({ at: '2026-08-30T12:00:00.000Z', kind: 'uncaught-exception', summary: 'x' })
    expect(line).not.toContain('\n')
    expect(JSON.parse(line).summary).toBe('x')
  })
})
