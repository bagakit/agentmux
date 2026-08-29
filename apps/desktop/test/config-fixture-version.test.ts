import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { CONFIG_VERSION } from '../src/shared/contracts.js'
import { declarationOf, parseModule, propertyInitializer } from './helpers/ts-binding.js'

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
 *
 * 版本号取自**写进那个文件的那个对象**，而不是全文里每一处 `version:`。这个区别不是洁癖：
 * probe-attention-review-restart.mjs 一个文件里同时播种三份存储——config 是 9、
 * `agentmux-workbench-v1`（store.ts 的 persist version）是 1、agent-sessions 是 5。
 * 按全文扫，后两个会被当成"配置版本漂了"报上来，而它们各自都是对的；照着报错去改，反倒会把
 * 两份正确的种子改坏。谁的版本号，就按谁的写入点判。
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

/** The object literal an expression denotes, following one level of `const x = {…}` binding. */
function objectLiteralOf(
  module: ReturnType<typeof parseModule>,
  node: ts.Expression
): ts.ObjectLiteralExpression | null {
  if (ts.isObjectLiteralExpression(node)) return node
  if (!ts.isIdentifier(node)) return null
  const declaration = declarationOf(module, node)
  if (!declaration || !ts.isVariableDeclaration(declaration)) return null
  const initializer = declaration.initializer
  return initializer && ts.isObjectLiteralExpression(initializer) ? initializer : null
}

/**
 * Every `version:` on an object that is stringified into a path ending in agentmux.config.json.
 *
 * Shape matched: `writeFile(join(dir, 'agentmux.config.json'), `${JSON.stringify(<obj>)}\n`, …)`,
 * where `<obj>` is an inline literal or a `const` bound to one — both spellings are in the tree today.
 */
function configVersionsIn(source: string, label: string): number[] {
  const module = parseModule(source, label)
  const versions: number[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText().endsWith('JSON.stringify')) {
      const argument = node.arguments[0]
      // Walk out to the writeFile() call and ask which file this stringify feeds.
      let ancestor: ts.Node | undefined = node.parent
      while (ancestor && !ts.isCallExpression(ancestor)) ancestor = ancestor.parent
      if (argument && ancestor && ts.isCallExpression(ancestor)) {
        const target = ancestor.arguments[0]
        if (target && target.getText().includes(CONFIG_FILE_NAME)) {
          const object = objectLiteralOf(module, argument)
          const version = object && propertyInitializer(object, 'version')
          if (version && ts.isNumericLiteral(version)) versions.push(Number(version.text))
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(module.sourceFile)
  return versions
}

function configWritingScripts(): ConfigWritingScript[] {
  const found: ConfigWritingScript[] = []
  for (const path of trackedScripts()) {
    const text = readFileSync(join(desktopRoot, path), 'utf8')
    if (!text.includes(CONFIG_FILE_NAME)) continue
    // 标签必须以 .ts 结尾：`parseModule` 固定按 ScriptKind.TS 建单文件 program，而 host 只在文件名
    // 完全相同时才交出源码。用真实的 .mjs 名字时 program 里一个文件都没有，checker 于是对每个
    // 标识符都返回"无声明"——`JSON.stringify(fixtureConfig)` 这种写法会被静默当成"没有版本号"。
    // 这不是洁癖：实测 .mjs 名下 5 个标识符实参 0 个解析得到，换成 .ts 名 5 个全部解析得到。
    found.push({ path, declaredVersions: configVersionsIn(text, `${join(desktopRoot, path)}.ts`) })
  }
  return found
}

describe('scripts fixture config version', () => {
  it('reads the version off the object that is written, not every version in the file', () => {
    // 自证：这条判据必须能把同一个文件里的三份存储分开。全文扫的写法会把 1 和 5 也算进来。
    const sample = `
      const fixtureConfig = { version: 9, hosts: [] }
      const workbenchSeed = { state: {}, version: 1 }
      await writeFile(join(userData, 'agentmux.config.json'), \`\${JSON.stringify(fixtureConfig)}\\n\`)
      await writeFile(join(userData, 'agent-sessions.json'), \`\${JSON.stringify({ version: 5 })}\\n\`)
      localStorage.setItem('agentmux-workbench-v1', JSON.stringify(workbenchSeed))
    `
    expect(configVersionsIn(sample, '/synthetic/three-stores.ts')).toEqual([9])
  })

  it('scans real tracked scripts instead of passing on an empty result', () => {
    const scripts = trackedScripts()
    // 扫描根写错时这里立刻红，而不是让下面每条断言在空集合上恒真通过。
    expect(scripts.length, 'apps/desktop/scripts 下一个被跟踪的 .mjs 都没有，扫描根写错了')
      .toBeGreaterThan(3)
    const writers = configWritingScripts()
    expect(
      writers.map((script) => basename(script.path)).sort(),
      `没有任何脚本被识别为 ${CONFIG_FILE_NAME} 的写方：要么判据失效了，要么脚本改了写法`
    ).toEqual([
      'file-editing-fixture.mjs',
      'measure-desktop-resources.mjs',
      'probe-attention-review-restart.mjs'
    ])
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
