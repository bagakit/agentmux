import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { CONFIG_VERSION } from '../src/shared/contracts.js'

/**
 * 守住 scripts/*.mjs 里手抄的配置版本号。
 *
 * 为什么需要这道门：`scripts/` 与 `src/` 不在同一个构建图，.mjs 导不了 contracts.ts 的
 * `CONFIG_VERSION`，所以那些 fixture 只能手抄一个字面量。手抄的常量没有守卫就一定会漂——这条已经
 * 真的发生过：CONFIG_VERSION 从 7 升到 8 时两个脚本都没跟上，ConfigStore 于是走 isOlderVersion
 * 分支删掉配置、回落到空 workspaces，打包 ship gate 与 measure:desktop 双双变红。
 *
 * 而它当时**没有任何测试发现**：`pnpm check` 跑的是 test:fast + test:native，两个门禁都不在里面，
 * 于是 2058 条测试全绿而两个门禁是坏的。那两个门禁本身要跑几分钟到十几分钟，不能当作发现漂移的手段。
 *
 * 判据故意不是"检查那两个已知文件"，而是**谁往 agentmux.config.json 写配置**。规则因此不随脚本
 * 数量变：新增第四个写配置的脚本会自动落进扫描范围，而不是悄悄绕过这道门。
 */

const desktopRoot = fileURLToPath(new URL('../', import.meta.url))
const CONFIG_FILE_NAME = 'agentmux.config.json'

function trackedScripts(): string[] {
  // 用 git ls-files 而不是 readdir：只扫被跟踪的文件，本地临时脚本和构建产物不参与。
  const listed = execFileSync('git', ['ls-files', '-z', 'scripts/*.mjs'], {
    cwd: desktopRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024
  })
  return listed.split('\0').filter((path) => path.length > 0)
}

type ConfigWritingScript = {
  path: string
  declaredVersions: number[]
}

function configWritingScripts(): ConfigWritingScript[] {
  const found: ConfigWritingScript[] = []
  for (const path of trackedScripts()) {
    const text = readFileSync(join(desktopRoot, path), 'utf8')
    if (!text.includes(CONFIG_FILE_NAME)) continue
    // 只认 `version: <整数>` 这一种写法——那正是这两份 fixture 的形状（JSON.stringify 的对象字面量）。
    // 写成别的形状（拼字符串、从别处取）就不该由这道门负责，那时它会因为"一个都没抓到"而变红，
    // 而红比静默放过好：它会把人带到这里，要么补形状，要么说明为什么不需要守。
    const declaredVersions = [...text.matchAll(/\bversion:\s*(\d+)/gu)]
      .map((match) => Number(match[1]))
    found.push({ path, declaredVersions })
  }
  return found
}

describe('scripts fixture config version', () => {
  it('scans real tracked scripts instead of passing on an empty result', () => {
    const scripts = trackedScripts()
    // 扫描根写错时这里立刻红，而不是让下面每条断言在空集合上恒真通过。
    expect(scripts.length, 'apps/desktop/scripts 下一个被跟踪的 .mjs 都没有，扫描根写错了')
      .toBeGreaterThan(3)
    const writers = configWritingScripts()
    expect(
      writers.map((script) => basename(script.path)).sort(),
      `没有任何脚本被识别为 ${CONFIG_FILE_NAME} 的写方：要么判据失效了，要么脚本改了写法`
    ).toEqual(['file-editing-fixture.mjs', 'measure-desktop-resources.mjs'])
  })

  it('keeps every scripted fixture config at the current CONFIG_VERSION', () => {
    for (const script of configWritingScripts()) {
      // 每个写方都必须至少声明一个 version，否则它写出去的配置形状无从校验。
      expect(
        script.declaredVersions.length,
        `${script.path} 写 ${CONFIG_FILE_NAME} 却没有 \`version: <整数>\`，这道门看不见它的版本号`
      ).toBeGreaterThan(0)
      for (const declared of script.declaredVersions) {
        expect(
          declared,
          `${script.path} 写死的 version ${declared} 与 CONFIG_VERSION ${CONFIG_VERSION} 不一致。` +
            '低于当前版本会让 ConfigStore 走 isOlderVersion 分支删掉配置、回落到空 workspaces，' +
            '打包 ship gate 与 measure:desktop 都会红；高于当前版本会被 schema 直接拒绝。' +
            `请把 ${script.path} 的 version 同步到 ${CONFIG_VERSION}。`
        ).toBe(CONFIG_VERSION)
      }
    }
  })
})
