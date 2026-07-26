import { describe, expect, it } from 'vitest'
import { singleFlight } from '../src/main/single-flight.js'

/**
 * 单飞去重原语的直接单测。这是 index.ts 三处建窗触发点共享的并发守卫——whenReady 首建还在 await 时
 * second-instance 触发，绝不能并发建出第二个窗口。这里用 deferred 任务把「在途」这个时刻钉住，断言
 * 在途期间的重复调用不会再启动一次，且结算之后能重新启动。
 */

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('singleFlight: 在途只跑一次', () => {
  it('在途期间的重复调用复用同一个 Promise，任务体只被调用一次', () => {
    let calls = 0
    const gate = deferred()
    const guarded = singleFlight(async () => {
      calls += 1
      await gate.promise
    })

    const first = guarded()
    const second = guarded()
    const third = guarded()

    // 关键：三次调用里任务体只跑一次；后两次拿到的是同一个在途 Promise。
    expect(calls).toBe(1)
    expect(second).toBe(first)
    expect(third).toBe(first)
    gate.resolve()
  })

  it('上一次结算后，下一次调用会真正重新启动', async () => {
    let calls = 0
    let gate = deferred()
    const guarded = singleFlight(async () => {
      calls += 1
      await gate.promise
    })

    const first = guarded()
    gate.resolve()
    await first
    expect(calls).toBe(1)

    // 在途已清空，新调用必须真的再跑一次，而不是复用已结算的旧 Promise。
    gate = deferred()
    const second = guarded()
    expect(calls).toBe(2)
    expect(second).not.toBe(first)
    gate.resolve()
    await second
  })

  it('任务失败后在途也会清空，下一次能重新启动（不会被一次失败永久卡住）', async () => {
    let calls = 0
    const guarded = singleFlight(async () => {
      calls += 1
      throw new Error(`fail-${calls}`)
    })

    await expect(guarded()).rejects.toThrow('fail-1')
    // finally 清空在途，第二次必须重新跑——否则一次崩溃会把建窗能力永久锁死。
    await expect(guarded()).rejects.toThrow('fail-2')
    expect(calls).toBe(2)
  })
})
