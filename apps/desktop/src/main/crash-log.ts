import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { appendWithinBudget, serializeCrashRecord, type CrashRecord } from './crash-capture.js'

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
    private readonly path = join(app.getPath('userData'), 'crash-log.ndjson'),
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
}
