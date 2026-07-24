import { afterEach, describe, expect, it } from 'vitest'

export type ConformanceRunRef = {
  runId: string
  incarnationId: string
}

export type ConformanceRun = ConformanceRunRef & {
  createOperationId: string
  pid: number
  state: 'running' | 'exited' | 'lost'
  cols: number
  rows: number
  latestOutputBytes: number
  acceptedInputBytes: number
}

export type ConformanceDataEvent = ConformanceRunRef & {
  startByte: number
  endByte: number
  data: string
}

export type ConformanceAttachment = {
  run: ConformanceRun
  replay: ConformanceDataEvent[]
  gap: null | {
    requestedAfterByte: number
    firstAvailableByte: number
  }
}

export type ConformanceCreateInput = {
  runId: string
  createOperationId: string
  workspacePath: string
  cols?: number
  rows?: number
  command?: string
  args?: readonly string[]
}

export type ConformanceClient = {
  create(input: ConformanceCreateInput): Promise<ConformanceRun>
  list(): Promise<ConformanceRun[]>
  attach(runId: string, afterByte?: number): Promise<ConformanceAttachment>
  release(ref: ConformanceRunRef): Promise<void>
  write(ref: ConformanceRunRef, data: string): Promise<{ acceptedThroughByte: number; duplicate: boolean }>
  writeAt(ref: ConformanceRunRef, startByte: number, data: string): Promise<{ acceptedThroughByte: number; duplicate: boolean }>
  resize(ref: ConformanceRunRef, cols: number, rows: number): Promise<{ cols: number; rows: number }>
  acknowledge(ref: ConformanceRunRef, throughByte: number): Promise<void>
  stop(ref: ConformanceRunRef): Promise<void>
  onData(listener: (event: ConformanceDataEvent) => void): () => void
  disconnect(): void
}

export type RunKernelConformanceHarness = {
  connect(): Promise<ConformanceClient>
  dispose(): Promise<void>
}

export type RunKernelConformanceDefinition = {
  id: string
  tier: 'fast' | 'chaos' | 'resource' | 'remote'
  oracle: string
}

export const RUN_KERNEL_CONFORMANCE: readonly RunKernelConformanceDefinition[] = [
  { id: 'create-operation-content-identity', tier: 'fast', oracle: '同一 Operation ID 只能重放完全相同的 Create intent。' },
  { id: 'input-content-identity', tier: 'fast', oracle: '同一 byte cursor 只有原字节完全相同才是 duplicate。' },
  { id: 'incarnation-fence', tier: 'fast', oracle: '旧 Incarnation 的控制不能命中新 Run。' },
  { id: 'ordered-input-output', tier: 'fast', oracle: '输入与输出 byte range 连续、单调且不重复。' },
  { id: 'attach-release-replay-gap', tier: 'fast', oracle: 'Release 只结束 Attachment；超窗恢复返回显式 Gap。' },
  { id: 'resize-readback', tier: 'fast', oracle: 'Resize 返回 Kernel 实际应用的尺寸。' },
  { id: 'stop-process-tree', tier: 'chaos', oracle: 'Stop 后 Run 与完整后代树都不可继续运行。' },
  { id: 'slow-consumer-budget', tier: 'chaos', oracle: '慢 Attachment 有界断开，不暂停 Run 或其他 Client。' },
  { id: 'release-resource-budget', tier: 'resource', oracle: '循环关闭后 Run、Attachment、FD 与常驻内存保持预算内。' },
  { id: 'local-recovery', tier: 'chaos', oracle: 'Client/Kernel 故障后的 Run disposition 明确且不伪造恢复。' },
  { id: 'ssh-partition-recovery', tier: 'remote', oracle: 'Transport partition 不改变远端 Run identity；重连重新验身份。' }
]

const REQUIRED_CONTRACT_IDS = new Set(RUN_KERNEL_CONFORMANCE.map((definition) => definition.id))

function contractTest(
  knownGaps: ReadonlySet<string>,
  id: string,
  name: string,
  run: () => Promise<void>
): void {
  if (!REQUIRED_CONTRACT_IDS.has(id)) throw new Error(`Unknown Run Kernel contract: ${id}`)
  const define = knownGaps.has(id) ? it.fails : it
  define(`${id}: ${name}`, run)
}

async function waitFor(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 8_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

export function registerRunKernelConformance(input: {
  candidate: string
  createHarness(): Promise<RunKernelConformanceHarness>
  knownGaps?: readonly string[]
  echoAgent: { command: string; args(label: string): readonly string[] }
}): void {
  describe(`Run Kernel Conformance: ${input.candidate}`, () => {
    let harness: RunKernelConformanceHarness | null = null
    const knownGaps = new Set(input.knownGaps ?? [])

    async function createHarness(): Promise<RunKernelConformanceHarness> {
      harness = await input.createHarness()
      return harness
    }

    afterEach(async () => {
      const current = harness
      harness = null
      if (current) await current.dispose()
    })

    contractTest(knownGaps, 'create-operation-content-identity', 'rejects the same operation id with different intent', async () => {
      const client = await (await createHarness()).connect()
      const first = await client.create({
        runId: 'create-identity',
        createOperationId: 'create-identity-operation',
        workspacePath: process.cwd(),
        cols: 80,
        rows: 24
      })
      await expect(client.create({
        runId: first.runId,
        createOperationId: first.createOperationId,
        workspacePath: process.cwd(),
        cols: 120,
        rows: 40
      })).rejects.toMatchObject({ code: 'CREATE_OPERATION_CONFLICT' })
      await client.stop(first)
    })

    contractTest(knownGaps, 'input-content-identity', 'rejects different bytes at an accepted cursor', async () => {
      const client = await (await createHarness()).connect()
      const run = await client.create({
        runId: 'input-identity',
        createOperationId: 'input-identity-operation',
        workspacePath: process.cwd(),
        command: input.echoAgent.command,
        args: input.echoAgent.args('input-identity')
      })
      const accepted = await client.writeAt(run, 0, 'first-bytes\n')
      expect(accepted).toMatchObject({ acceptedThroughByte: 12, duplicate: false })
      await expect(client.writeAt(run, 0, 'other-bytes\n')).rejects.toMatchObject({
        code: 'INPUT_CONTENT_CONFLICT'
      })
      await client.stop(run)
    })

    contractTest(knownGaps, 'incarnation-fence', 'keeps stale control away from a reused Run id', async () => {
      const firstClient = await (await createHarness()).connect()
      const controller = await harness!.connect()
      const first = await firstClient.create({
        runId: 'incarnation-fence',
        createOperationId: 'incarnation-fence-first',
        workspacePath: process.cwd()
      })
      const attached = await controller.attach(first.runId)
      await controller.stop(attached.run)
      const second = await controller.create({
        runId: first.runId,
        createOperationId: 'incarnation-fence-second',
        workspacePath: process.cwd()
      })
      expect(second.incarnationId).not.toBe(first.incarnationId)
      await expect(firstClient.resize(first, 100, 30)).rejects.toMatchObject({
        code: 'STALE_SESSION_INCARNATION'
      })
      await controller.stop(second)
    })

    contractTest(knownGaps, 'ordered-input-output', 'keeps byte order and ranges continuous', async () => {
      const client = await (await createHarness()).connect()
      const events: ConformanceDataEvent[] = []
      client.onData((event) => events.push(event))
      const run = await client.create({
        runId: 'ordered-bytes',
        createOperationId: 'ordered-bytes-operation',
        workspacePath: process.cwd(),
        command: input.echoAgent.command,
        args: input.echoAgent.args('ordered-bytes')
      })
      await waitFor('echo workload readiness', () => events.some((event) => event.data.includes('run-kernel-ready:ordered-bytes')))
      const chunks = Array.from({ length: 32 }, (_, index) => `${String(index).padStart(2, '0')}\n`)
      const acknowledgements = await Promise.all(chunks.map(async (chunk) => await client.write(run, chunk)))
      await waitFor('ordered workload input', () => events.some((event) => event.data.includes('run-kernel-input:31')))
      expect(acknowledgements.at(-1)?.acceptedThroughByte).toBe(
        chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk), 0)
      )
      for (let index = 1; index < events.length; index += 1) {
        expect(events[index]!.startByte).toBe(events[index - 1]!.endByte)
      }
      await client.acknowledge(run, events.at(-1)?.endByte ?? 0)
      await client.stop(run)
    })

    contractTest(knownGaps, 'attach-release-replay-gap', 'releases one Attachment without stopping the Run', async () => {
      const controller = await (await createHarness()).connect()
      const observer = await harness!.connect()
      const run = await controller.create({
        runId: 'attachment-release',
        createOperationId: 'attachment-release-operation',
        workspacePath: process.cwd()
      })
      const attached = await observer.attach(run.runId)
      await observer.release(attached.run)
      await controller.write(run, "printf 'after-release\\n'\n")
      let reopened = await observer.attach(run.runId, 0)
      await waitFor('replay after Attachment release', async () => {
        reopened = await observer.attach(run.runId, 0)
        return reopened.replay.some((event) => event.data.includes('after-release'))
      })
      expect(reopened.run.incarnationId).toBe(run.incarnationId)
      expect(await controller.resize(run, 101, 31)).toEqual({ cols: 101, rows: 31 })
      await observer.stop(reopened.run)
      await expect(controller.list()).resolves.toEqual([])
    })
  })
}
