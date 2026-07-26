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
  isFatalToMainProcess,
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
    const persisted: CrashRecord[] = []
    const exits: number[] = []
    const dispose = registerCrashCapture({
      app: fakeApp as never,
      process: fakeProcess as never,
      sink: (record) => {
        records.push(record)
      },
      persistSync: (record) => {
        persisted.push(record)
      },
      exit: (code) => {
        exits.push(code)
      },
      now: () => FIXED_MS,
      logStderr: () => {}
    })
    return { fakeApp, fakeProcess, records, persisted, exits, dispose }
  }

  it('uncaughtException 同步落盘并 fail-fast，不走异步 sink', () => {
    const { fakeProcess, records, persisted, exits } = harness()
    fakeProcess.emit('uncaughtException', new Error('main died'))
    // 致命崩溃：exit 前必须同步落地那一条，再补回被处理器抑制掉的 Node 默认退出。
    expect(persisted).toHaveLength(1)
    expect(persisted[0]?.kind).toBe('uncaught-exception')
    expect(persisted[0]?.summary).toBe('main died')
    expect(exits).toEqual([1])
    // 绝不能只记录不退出——那会让主进程带着半损坏运行时静默续命。异步 sink 不该被用于致命路径。
    expect(records).toHaveLength(0)
  })

  it('unhandledRejection 同样 fail-fast', () => {
    const { fakeProcess, persisted, exits } = harness()
    fakeProcess.emit('unhandledRejection', new Error('no one caught me'))
    expect(persisted).toHaveLength(1)
    expect(persisted[0]?.kind).toBe('unhandled-rejection')
    expect(exits).toEqual([1])
  })

  it('render-process-gone 只异步留证、绝不退出主进程', () => {
    const { fakeApp, records, exits } = harness()
    fakeApp.emit('render-process-gone', {}, { getURL: () => 'file:///r' }, { reason: 'crashed', exitCode: 5 })
    expect(records).toHaveLength(1)
    expect(records[0]?.kind).toBe('render-process-gone')
    expect(records[0]?.detail).toBe('file:///r')
    // Electron 主进程按设计能在渲染器死后存活，为一个渲染器崩溃杀主进程是更糟的回归。
    expect(exits).toEqual([])
  })

  it('child-process-gone 也只异步留证、不退出', () => {
    const { fakeApp, records, exits } = harness()
    fakeApp.emit('child-process-gone', {}, { type: 'Utility', reason: 'crashed', exitCode: 9 })
    expect(records).toHaveLength(1)
    expect(records[0]?.kind).toBe('child-process-gone')
    expect(exits).toEqual([])
  })

  it('致命崩溃：同步落盘抛错也绝不阻断退出，失败落到 stderr', () => {
    const fakeApp = new EventEmitter()
    const fakeProcess = new EventEmitter()
    const stderr: string[] = []
    const exits: number[] = []
    registerCrashCapture({
      app: fakeApp as never,
      process: fakeProcess as never,
      sink: () => {},
      persistSync: () => {
        throw new Error('disk full')
      },
      exit: (code) => {
        exits.push(code)
      },
      now: () => FIXED_MS,
      logStderr: (line) => stderr.push(line)
    })
    fakeProcess.emit('uncaughtException', new Error('x'))
    // 留证失败也必须退出——带病续命比丢一条崩溃日志更糟。
    expect(exits).toEqual([1])
    expect(stderr.some((l) => l.includes('crash sink failed') && l.includes('disk full'))).toBe(true)
  })

  it('disposer 摘除监听后事件不再进 sink', () => {
    const { fakeProcess, records, persisted, exits, dispose } = harness()
    dispose()
    fakeProcess.emit('uncaughtException', new Error('after dispose'))
    expect(records).toHaveLength(0)
    expect(persisted).toHaveLength(0)
    expect(exits).toEqual([])
  })

  it('非致命的 sink 同步抛出不会把崩溃处理器搞崩，且失败落到 stderr', () => {
    const fakeApp = new EventEmitter()
    const fakeProcess = new EventEmitter()
    const stderr: string[] = []
    registerCrashCapture({
      app: fakeApp as never,
      process: fakeProcess as never,
      sink: () => {
        throw new Error('disk full')
      },
      persistSync: () => {},
      exit: () => {},
      now: () => FIXED_MS,
      logStderr: (line) => stderr.push(line)
    })
    // 不抛即通过：留证失败绝不放大故障。用非致命的 child-process-gone 走异步 sink 路径。
    expect(() =>
      fakeApp.emit('child-process-gone', {}, { type: 'Utility', reason: 'crashed', exitCode: 1 })
    ).not.toThrow()
    // 但失败必须可见——落到 stderr，不许悄悄吞掉。
    expect(stderr.some((l) => l.includes('crash sink failed') && l.includes('disk full'))).toBe(true)
  })

  it('非致命的 sink 异步 reject 也落到 stderr，不变成又一个没人接的 rejection', async () => {
    const fakeApp = new EventEmitter()
    const fakeProcess = new EventEmitter()
    const stderr: string[] = []
    registerCrashCapture({
      app: fakeApp as never,
      process: fakeProcess as never,
      sink: () => Promise.reject(new Error('async disk full')),
      persistSync: () => {},
      exit: () => {},
      now: () => FIXED_MS,
      logStderr: (line) => stderr.push(line)
    })
    fakeApp.emit('child-process-gone', {}, { type: 'Utility', reason: 'crashed', exitCode: 1 })
    // 让微任务队列排空，异步 reject 的 catch 才跑到。
    await Promise.resolve()
    await Promise.resolve()
    expect(stderr.some((l) => l.includes('crash sink failed') && l.includes('async disk full'))).toBe(true)
  })
})

describe('isFatalToMainProcess: 只有未捕获异常/拒绝才致命', () => {
  it('未捕获异常与未处理拒绝致命——挂上 process 处理器会抑制 Node 默认退出，必须手动补回', () => {
    expect(isFatalToMainProcess('uncaught-exception')).toBe(true)
    expect(isFatalToMainProcess('unhandled-rejection')).toBe(true)
  })

  it('渲染/子进程消失不致命——Electron 主进程按设计能在它们死后继续存活', () => {
    expect(isFatalToMainProcess('render-process-gone')).toBe(false)
    expect(isFatalToMainProcess('child-process-gone')).toBe(false)
  })
})

describe('crashRecordFrom: 字段有字节上界，每行始终可 JSON.parse', () => {
  it('超长栈只截 detail 字段并补省略号，记录整体仍是合法 JSON', () => {
    const error = new Error('boom')
    error.stack = 'S'.repeat(300 * 1024) // 远超 detail 上界
    const record = crashRecordFrom({ kind: 'uncaught-exception', error }, FIXED_MS)
    // 序列化后必须能被严格解析——不能像整行截断那样切出半条 JSON。
    const line = serializeCrashRecord(record)
    expect(() => JSON.parse(line)).not.toThrow()
    // detail 被裁到上界内，且末尾有省略号标记「这里被截过」。
    expect(Buffer.byteLength(record.detail ?? '', 'utf8')).toBeLessThanOrEqual(128 * 1024)
    expect(record.detail?.endsWith('…')).toBe(true)
    // 一整行也远小于文件 1 MiB 上界，appendWithinBudget 永远走不到整行截断那条坏路。
    expect(Buffer.byteLength(`${line}\n`, 'utf8')).toBeLessThan(1024 * 1024)
  })

  it('超长 summary 也被截断补省略号，仍可解析', () => {
    const record = crashRecordFrom({ kind: 'unhandled-rejection', reason: 'm'.repeat(10 * 1024) }, FIXED_MS)
    expect(() => JSON.parse(serializeCrashRecord(record))).not.toThrow()
    expect(Buffer.byteLength(record.summary, 'utf8')).toBeLessThanOrEqual(4 * 1024)
    expect(record.summary.endsWith('…')).toBe(true)
  })

  it('多字节字符不会被从中间切开，截断后仍是合法 UTF-8（无 \\uFFFD 替换符）', () => {
    // 每个字符 3 字节，撑爆 summary 上界；若按字节硬切会切出坏字节序列。
    const record = crashRecordFrom({ kind: 'unhandled-rejection', reason: '中'.repeat(3000) }, FIXED_MS)
    const line = serializeCrashRecord(record)
    expect(() => JSON.parse(line)).not.toThrow()
    // 截断绝不在字符中间落刀：结果里不能出现 UTF-8 解码失败的替换符。
    expect(record.summary).not.toContain('�')
    expect(Buffer.byteLength(record.summary, 'utf8')).toBeLessThanOrEqual(4 * 1024)
    expect(record.summary.endsWith('…')).toBe(true)
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
    // 致命崩溃的 fail-fast 必须真的接上：同步落盘 + app.exit 都喂进接线层，否则只记录不退出。
    expect(source).toContain('crashLog.appendSync(record)')
    expect(source).toContain('exit: (code) => app.exit(code)')
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
