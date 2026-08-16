import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { appendWithinBudget, serializeCrashRecord, type CrashRecord } from './crash-capture.js'

/**
 * 崩溃证据落盘的那个文件。**导出**是因为它有第二个消费者：`ui:revealCrashLog` 要在 Finder 里点出
 * 这个文件。两处各写一次 `join(userData, …)` 就是两个真相，改名时只改一处会让「显示崩溃日志」安静地
 * 指向一个不存在的路径——而那条路径本来就常常不存在（没崩过），于是分不出是没崩过还是指错了。
 */
export function crashLogPath(): string {
  return join(app.getPath('userData'), 'crash-log.ndjson')
}

/**
 * 崩溃证据的落盘存储：一份 NDJSON 文件，放在 Electron userData 里，和 config/window-geometry 并排。
 * 每次崩溃追加一行，读回全文、在字节上界内追加、再原子替换——体量有硬顶，崩溃循环写不满磁盘。
 *
 * 这里**只写本地文件，没有任何网络出口**。这是「只落盘、不上传」隐私立场的落地点：整个类连一次
 * 网络调用都不存在，不上传不是靠「我们没写上传代码」的口头承诺，而是这层根本没有上传能力。
 *
 * 写入串行化经一条 tail，避免两次崩溃几乎同时到达时读改写互相覆盖，把文件写成半条。
 */
export class CrashLog {
  private writeTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly path = crashLogPath(),
    /** NDJSON 文件的体量上界。默认 1 MiB：够留下最近一批崩溃，又不会让崩溃循环吃满盘。 */
    private readonly maxBytes = 1024 * 1024
  ) {}

  async append(record: CrashRecord): Promise<void> {
    const operation = this.writeTail.catch(() => {}).then(async () => {
      const line = serializeCrashRecord(record)
      let existing = ''
      try {
        existing = await readFile(this.path, 'utf8')
      } catch (error) {
        // 首次崩溃时文件还不存在；其它读失败也当作空文件重建，绝不因为读不到旧证据就丢掉这条新的。
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') existing = ''
      }
      const next = appendWithinBudget(existing, line, this.maxBytes)
      await mkdir(dirname(this.path), { recursive: true })
      const tempPath = `${this.path}.${process.pid}.tmp`
      await writeFile(tempPath, next, { mode: 0o600 })
      await rename(tempPath, this.path)
    })
    this.writeTail = operation.then(() => {}, () => {})
    await operation
  }

  /**
   * 同步落盘，专供致命崩溃的 exit 前留证——那时事件循环即将结束，异步 append 的 Promise 根本排不上。
   * 用同步 fs：读旧内容、字节上界内追加、原子替换，与 append 同一套裁量，只是不排队（进程马上就退了，
   * 没有并发写的余地）。任何 IO 失败都往上抛，由接线层落到 stderr——留证尽力而为，绝不阻断退出。
   */
  appendSync(record: CrashRecord): void {
    const line = serializeCrashRecord(record)
    let existing = ''
    try {
      existing = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') existing = ''
    }
    const next = appendWithinBudget(existing, line, this.maxBytes)
    mkdirSync(dirname(this.path), { recursive: true })
    const tempPath = `${this.path}.${process.pid}.sync.tmp`
    writeFileSync(tempPath, next, { mode: 0o600 })
    renameSync(tempPath, this.path)
  }
}
