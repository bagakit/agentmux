import { describe, expect, it } from 'vitest'
import {
  NOTE_FILE_EXTENSION,
  NOTE_NAME_ATTEMPTS,
  createNoteWithAvailableName,
  noteNameCandidates,
  noteStemForDate
} from '../src/renderer/src/lib/note-names.js'

/**
 * 笔记命名。
 *
 * 承重前提：写入走的 `files:create` 用 `O_CREAT | O_EXCL`（见 workspace-files.ts 的 create 分支），
 * 撞名时**失败**而不是截断。所以命名必须是一个序列 + 由文件系统裁决，而不是先列目录再挑一个——
 * 后者是 check-then-act 竞态，同一 tick 建两条笔记会挑中同一个名字，第二次 create 抛裸 EEXIST。
 */
describe('note names', () => {
  const day = new Date(2026, 8, 3, 14, 30)

  it('第一个候选不带后缀，后缀从 2 开始', () => {
    const candidates = noteNameCandidates(day, 3)
    expect(candidates).toEqual([
      'note-2026-09-03.md',
      'note-2026-09-03-2.md',
      'note-2026-09-03-3.md'
    ])
  })

  it('月和日补零——不补零会让名字既不好读也不能按字典序排', () => {
    expect(noteStemForDate(new Date(2026, 0, 5))).toBe('note-2026-01-05')
    // 反证：这条区分"补了零"与"恰好是两位数"。
    expect(noteStemForDate(new Date(2026, 10, 25))).toBe('note-2026-11-25')
  })

  // 「用本地日历日」这条性质在 TZ=UTC 下**根本不可观测**——偏移为 0 时本地与 UTC 逐字段相等，
  // getDate 与 getUTCDate 的实现完全无法区分。原先这条判据靠本机环境时区恰好非零来提供判别器，
  // 于是在 CI 最常见的 TZ=UTC 上，两条行为断言退化成恒真、而自检直接变红（正确代码打红）。
  // 所以时区由本条自己钉住，两个方向各钉一次：正偏移把 00:30 推到前一天，负偏移把 23:30 推到后一天。
  // 这样判别器无条件在场，与跑测试的机器在哪无关。
  for (const [zone, hour] of [['Asia/Tokyo', 0], ['America/Los_Angeles', 23]] as const) {
    it(`用本地日历日，不用 UTC——晚上记的笔记不该写成明天（${zone}）`, () => {
      const original = process.env.TZ
      process.env.TZ = zone
      try {
        const moment = new Date(2026, 8, 3, hour, 30)
        // 前提自检：这个时刻的 UTC 日期确实与本地日期分岔，否则下面那条是恒真的。
        // 若实现改用 getUTCDate/toISOString，分岔就会在名字里显出来。
        expect(moment.getUTCDate()).not.toBe(moment.getDate())
        expect(noteStemForDate(moment)).toBe('note-2026-09-03')
      } finally {
        if (original === undefined) delete process.env.TZ
        else process.env.TZ = original
      }
    })
  }

  it('全是 .md——编辑器按扩展名决定语法', () => {
    for (const name of noteNameCandidates(day, 5)) {
      expect(name.endsWith(NOTE_FILE_EXTENSION)).toBe(true)
    }
  })

  it('默认候选数足够一天用，且有界', () => {
    expect(noteNameCandidates(day)).toHaveLength(NOTE_NAME_ATTEMPTS)
    expect(NOTE_NAME_ATTEMPTS).toBeGreaterThan(1)
    expect(Number.isFinite(NOTE_NAME_ATTEMPTS)).toBe(true)
  })

  it('候选之间互不重名——重名会让"下一个名字"退化成重试同一个', () => {
    const candidates = noteNameCandidates(day)
    expect(new Set(candidates).size).toBe(candidates.length)
  })
})

describe('createNoteWithAvailableName', () => {
  const day = new Date(2026, 8, 3, 14, 30)

  it('没撞名时用第一个候选，且只调一次 create', () => {
    const calls: string[] = []
    return expect(
      createNoteWithAvailableName(day, async (name) => { calls.push(name) })
    ).resolves.toBe('note-2026-09-03.md').then(() => {
      expect(calls).toEqual(['note-2026-09-03.md'])
    })
  })

  it('撞名就往后走，返回真正建出来的那个名字', async () => {
    const existing = new Set(['note-2026-09-03.md', 'note-2026-09-03-2.md'])
    const created: string[] = []
    const name = await createNoteWithAvailableName(day, async (candidate) => {
      if (existing.has(candidate)) throw new Error('EEXIST')
      created.push(candidate)
    })

    expect(name).toBe('note-2026-09-03-3.md')
    // 承重：返回的名字必须是**实际建出来的**那个，而不是算出来的第一个。
    expect(created).toEqual(['note-2026-09-03-3.md'])
  })

  it('绝不覆盖已存在的笔记——被拒的名字一个都没落地', async () => {
    // 这条是整个模块存在的理由。若哪天有人把写入换成截断式的 write，撞名会"成功"，
    // 于是返回第一个候选、已有笔记被清空——这条会红。
    const existing = new Set(['note-2026-09-03.md'])
    const created: string[] = []
    await createNoteWithAvailableName(day, async (candidate) => {
      if (existing.has(candidate)) throw new Error('EEXIST')
      created.push(candidate)
    })

    expect(created).not.toContain('note-2026-09-03.md')
    expect(created).toHaveLength(1)
  })

  it('候选用尽时抛出**最后一次**真实失败，而不是换成一句名字用尽', async () => {
    // 每个候选都因权限失败时，用户该看到权限问题。报"100 个名字都被占了"会把人引向错的方向。
    await expect(
      createNoteWithAvailableName(day, async () => { throw new Error('EACCES: permission denied') }, 3)
    ).rejects.toThrow(/EACCES/)
  })

  it('把非 Error 的拒因换成可读消息，不让 undefined 冒到界面上', async () => {
    await expect(
      createNoteWithAvailableName(day, async () => { throw 'not an error object' }, 2)
    ).rejects.toThrow(/Could not create a note/)
  })

  it('尝试次数有界——不会对着一个持续失败的文件系统无限打转', async () => {
    let attempts = 0
    await expect(
      createNoteWithAvailableName(day, async () => { attempts += 1; throw new Error('EEXIST') }, 4)
    ).rejects.toThrow()
    expect(attempts).toBe(4)
  })
})
