// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { requestMarkdownRender } from '../src/lib/markdown-render-job.js'

const workers: any[] = [], controllers: AbortController[] = []
beforeEach(() => {
  vi.stubGlobal('Worker', class {
    onmessage: any; onerror: any; onmessageerror: any
    postMessage = vi.fn(); terminate = vi.fn()
    constructor() { workers.push(this) }
  })
})
afterEach(async () => { for (const controller of controllers) controller.abort(); await Promise.resolve(); workers.length = 0; controllers.length = 0; vi.unstubAllGlobals() })
function request(source: string) {
  const controller = new AbortController(); controllers.push(controller)
  return { controller, result: requestMarkdownRender({ kind: 'code', language: 'js', source }, controller.signal) }
}
function respond(worker: any) {
  const { id, input } = worker.postMessage.mock.calls.at(-1)[0]
  worker.onmessage({ data: { id, result: { html: input.source } } })
}
it('correlates reused Worker replies without secure-context crypto APIs', async () => {
  vi.stubGlobal('crypto', undefined)
  const tasks = ['first', 'second', 'third'].map(request)
  const outcomes = Promise.allSettled(tasks.map(task => task.result))
  expect(workers).toHaveLength(2)
  const firstId = workers[0].postMessage.mock.calls[0][0].id
  const secondId = workers[1].postMessage.mock.calls[0][0].id
  respond(workers[0])
  const thirdId = workers[0].postMessage.mock.calls[1][0].id
  expect(new Set([firstId, secondId, thirdId]).size).toBe(3)
  workers[0].onmessage({ data: { id: firstId, result: { html: 'stale reply' } } })
  expect(workers[0].terminate).not.toHaveBeenCalled()
  respond(workers[0]); respond(workers[1])
  expect((await outcomes).map(result => result.status === 'fulfilled' ? result.value.html : result.reason)).toEqual(['first', 'second', 'third'])
  for (const worker of workers) expect(worker.terminate).toHaveBeenCalledOnce()
})
it('runs a 100-block FIFO burst with two reusable Workers and retires both when empty', async () => {
  const tasks = Array.from({ length: 100 }, (_, index) => request(`job-${index}`))
  expect(workers).toHaveLength(2)
  const order: string[] = []
  for (let index = 0; index < 100; index++) {
    const worker = workers[index % 2]
    order.push(worker.postMessage.mock.calls.at(-1)[0].input.source)
    respond(worker)
  }
  expect(order).toEqual(Array.from({ length: 100 }, (_, index) => `job-${index}`))
  expect((await Promise.all(tasks.map(task => task.result))).map(result => result.html)).toEqual(order)
  expect(workers).toHaveLength(2)
  for (const worker of workers) expect(worker.terminate).toHaveBeenCalledOnce()
})
it('removes queued aborts and terminates only the active owner before filling its slot', async () => {
  const tasks = Array.from({ length: 5 }, (_, index) => request(`job-${index}`))
  const outcomes = Promise.allSettled(tasks.map(task => task.result))
  const late = workers[0].onmessage, oldId = workers[0].postMessage.mock.calls[0][0].id
  tasks[2]!.controller.abort(); tasks[0]!.controller.abort()
  expect(workers[0].terminate).toHaveBeenCalledOnce(); expect(workers[1].terminate).not.toHaveBeenCalled()
  await Promise.resolve()
  expect(workers).toHaveLength(3)
  expect(workers[2].postMessage.mock.calls[0][0].input.source).toBe('job-3')
  late({ data: { id: oldId, result: { html: 'old' } } })
  respond(workers[1]); respond(workers[2]); respond(workers[1])
  const settled = await outcomes
  expect(settled.map(result => result.status)).toEqual(['rejected', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled'])
  expect(workers.flatMap(worker => worker.postMessage.mock.calls.map(([message]: any[]) => message.input.source))).not.toContain('job-2')
})
it('hiding all 100 consumers clears queued work without starting doomed jobs', async () => {
  const tasks = Array.from({ length: 100 }, (_, index) => request(`job-${index}`))
  const outcomes = Promise.allSettled(tasks.map(task => task.result))
  for (const task of tasks) task.controller.abort()
  expect((await outcomes).every(result => result.status === 'rejected' && result.reason.name === 'AbortError')).toBe(true)
  expect(workers).toHaveLength(2)
  for (const worker of workers) expect(worker.terminate).toHaveBeenCalledOnce()
  const next = request('fresh burst'); expect(workers).toHaveLength(3)
  respond(workers[2]); expect((await next.result).html).toBe('fresh burst')
})
it('rejects mismatched replies, releases a failed Worker and continues the original queue', async () => {
  const first = request('first'), second = request('second'), third = request('third')
  workers[0].onmessage({ data: { id: 'other-request', result: { html: 'wrong' } } })
  expect(workers[0].terminate).not.toHaveBeenCalled()
  workers[0].onmessageerror()
  expect((await first.result).error).toContain('worker stopped')
  expect(workers[0].terminate).toHaveBeenCalledOnce()
  expect(workers[2].postMessage.mock.calls[0][0].input.source).toBe('third')
  respond(workers[1]); respond(workers[2])
  expect((await second.result).html).toBe('second'); expect((await third.result).html).toBe('third')
})
