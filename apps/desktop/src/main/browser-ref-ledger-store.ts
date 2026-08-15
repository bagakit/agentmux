import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { durableWriteFile } from '@agentmux/core'
import { z } from 'zod'
import type { BrowserRefLedger } from './browser-ref-ledger.js'

/**
 * 账本的落盘面。
 *
 * **与匹配逻辑分家**（`browser-ref-ledger.ts` 是纯的），理由不是整洁而是可测性：那一半被真机探针
 * 打进一个临时 bundle 跑（browser-drive-e2e.test.ts），而 `electron` / `@agentmux/core` 这两个
 * 运行时依赖一旦混进去，探针在 import 的那一刻就会炸在一句与页面无关的错上——而那种红看起来
 * 和"真机上闭环不成立"一模一样。仓里 `window-geometry.ts` / `window-geometry-store.ts` 是同一分法。
 */

const LEDGER_VERSION = 1
const LEDGER_FILE_NAME = 'browser-ref-ledger.json'
/**
 * 最多留几个 Browser 的账本。
 *
 * **上限在这里而不是在 Browser 关闭时清理**，这一条是刻意的：`BrowserViewManager.close` 在用户关掉
 * 一个 Browser 时会调，在应用退出时也会（`dispose` 逐个 close）。挂在那里清理，等于每次退出应用
 * 把所有账本删干净——而"跨重启还认得出 ref"正是这个模块的全部目的。按最近使用裁剪没有这个歧义：
 * 它不需要知道这次关闭是哪一种。
 */
export const MAX_TRACKED_BROWSERS = 64

const entrySchema = z
  .object({ ref: z.string().min(1), role: z.string(), name: z.string(), nth: z.number().int().min(1) })
  .strict()

const fileSchema = z
  .object({
    version: z.literal(LEDGER_VERSION),
    byBrowserId: z.record(
      z.string(),
      z.object({ url: z.string(), entries: z.array(entrySchema) }).strict()
    )
  })
  .strict()

/**
 * 账本的落盘面。形状照 `WindowGeometryStore`：durable 写 + 一条串行尾巴。
 *
 * 整份重写而不是每个 Browser 一个文件：同时开着的 Browser 是个位数，一次几 KB 的原子写比维护
 * 一堆小文件的生命周期便宜。真到了要开几百个的那天再拆。
 * ponytail: 整份重写，Browser 数量上百再按 id 分文件。
 */
export class BrowserRefLedgerStore {
  private loaded: Promise<Record<string, BrowserRefLedger>> | null = null
  private saveTail: Promise<void> = Promise.resolve()

  constructor(private readonly path = join(app.getPath('userData'), LEDGER_FILE_NAME)) {}

  /**
   * 读这个 Browser 上一次留下的账本。
   *
   * 文件缺失或读坏了一律当成"没有账本"：ref 解不开会退回一句明确的"重新取快照"，而崩在启动路径上
   * 会把一个能干活的 Agent 连同整个应用一起挡住（AGENTS.md:32-52 第 2 类）。
   */
  async read(browserId: string): Promise<BrowserRefLedger | null> {
    return (await this.all())[browserId] ?? null
  }

  async write(browserId: string, ledger: BrowserRefLedger): Promise<void> {
    const all = await this.all()
    // 先删再插：对象的字符串键按插入序遍历，删掉重插就是把这个 Browser 挪到队尾。
    // 少了 delete，一个反复被驱动的 Browser 会永远停在它第一次出现的位置，于是裁剪会把
    // **最常用的那个**当成最老的删掉。
    delete all[browserId]
    all[browserId] = ledger
    const ids = Object.keys(all)
    for (const stale of ids.slice(0, Math.max(0, ids.length - MAX_TRACKED_BROWSERS))) delete all[stale]
    await this.flush(all)
  }

  private async all(): Promise<Record<string, BrowserRefLedger>> {
    this.loaded ??= (async () => {
      try {
        const parsed = fileSchema.safeParse(JSON.parse(await readFile(this.path, 'utf8')))
        return parsed.success ? parsed.data.byBrowserId : {}
      } catch {
        return {}
      }
    })()
    return await this.loaded
  }

  private async flush(byBrowserId: Record<string, BrowserRefLedger>): Promise<void> {
    const operation = this.saveTail.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      await durableWriteFile(this.path, `${JSON.stringify({ version: LEDGER_VERSION, byBrowserId }, null, 2)}\n`)
    })
    this.saveTail = operation.then(() => {}, () => {})
    await operation
  }
}
