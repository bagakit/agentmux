import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
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

/** Follow the actual write destination, including a const-bound path, without treating reads as writers. */
function namesPath(module: ReturnType<typeof parseModule>, node: ts.Node, name: string, seen = new Set<ts.Node>()): boolean {
  if (seen.has(node)) return false
  seen.add(node)
  if (ts.isStringLiteralLike(node)) return node.text === name
  if (ts.isIdentifier(node)) {
    const declaration = declarationOf(module, node)
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
      return namesPath(module, declaration.initializer, name, seen)
    }
  }
  let found = false
  ts.forEachChild(node, child => { if (namesPath(module, child, name, seen)) found = true })
  return found
}

/** The private seeder bundles only the actual ConfigStore export; it does not author a version. */
function inheritsCurrentDefaults(module: ReturnType<typeof parseModule>, object: ts.ObjectLiteralExpression): boolean {
  return object.properties.some(property => {
    if (!ts.isSpreadAssignment(property) || !ts.isCallExpression(property.expression) ||
      property.expression.expression.getText() !== 'structuredClone') return false
    const identifier = property.expression.arguments[0]
    if (!identifier || !ts.isIdentifier(identifier)) return false
    const binding = declarationOf(module, identifier)
    if (!binding || !ts.isBindingElement(binding) || !ts.isObjectBindingPattern(binding.parent) ||
      !ts.isVariableDeclaration(binding.parent.parent) || binding.name.getText() !== 'DEFAULT_CONFIG') return false
    const initializer = binding.parent.parent.initializer
    if (!initializer || !ts.isAwaitExpression(initializer) || !ts.isCallExpression(initializer.expression) ||
      initializer.expression.expression.kind !== ts.SyntaxKind.ImportKeyword) return false
    const imported = initializer.expression.arguments[0]
    if (!imported || !ts.isPropertyAccessExpression(imported) || imported.name.text !== 'href' ||
      !ts.isCallExpression(imported.expression) || imported.expression.expression.getText() !== 'pathToFileURL') return false
    const modulePath = imported.expression.arguments[0]
    if (!modulePath || !ts.isIdentifier(modulePath)) return false
    const moduleDeclaration = declarationOf(module, modulePath)
    if (!moduleDeclaration) return false
    let ownsExport = false
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText() === 'build' && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
        const options = node.arguments[0], outfile = propertyInitializer(options, 'outfile'), input = propertyInitializer(options, 'stdin')
        const contents = input && ts.isObjectLiteralExpression(input) && propertyInitializer(input, 'contents')
        if (outfile && declarationOf(module, outfile) === moduleDeclaration && contents && ts.isTemplateExpression(contents) &&
          contents.head.text === 'export { DEFAULT_CONFIG } from ' && contents.templateSpans.length === 1 && contents.templateSpans[0]!.literal.text === '') {
          const expression = contents.templateSpans[0]!.expression
          ownsExport = ts.isCallExpression(expression) && expression.expression.getText() === 'JSON.stringify' &&
            expression.arguments[0] !== undefined && namesPath(module, expression.arguments[0], 'apps/desktop/src/main/config-store.ts')
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(module.sourceFile)
    return ownsExport
  })
}

/** Unknown versions remain NaN so a newly discovered writer fails the owning version assertion. */
function configVersionsIn(source: string, label: string): number[] {
  const module = parseModule(source, label)
  const versions: number[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText() === 'JSON.stringify') {
      const argument = node.arguments[0]
      let ancestor: ts.Node | undefined = node.parent
      while (ancestor && !ts.isCallExpression(ancestor)) ancestor = ancestor.parent
      if (argument && ancestor && ts.isCallExpression(ancestor) && /(?:^|\.)writeFile(?:Sync)?$/.test(ancestor.expression.getText())) {
        const target = ancestor.arguments[0]
        if (target && namesPath(module, target, CONFIG_FILE_NAME)) {
          const object = objectLiteralOf(module, argument)
          const version = object && propertyInitializer(object, 'version')
          versions.push(version && ts.isNumericLiteral(version) ? Number(version.text) :
            !version && object && inheritsCurrentDefaults(module, object) ? CONFIG_VERSION : NaN)
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
    const declaredVersions = configVersionsIn(text, `${join(desktopRoot, path)}.ts`)
    if (declaredVersions.length) found.push({ path, declaredVersions })
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
    expect(configVersionsIn(sample, _hygiene_fixturePath("synthetic/three-stores.ts"))).toEqual([9])
  })

  it('finds const-bound write targets, excludes reads and rejects an unwitnessed version', () => {
    const label = _hygiene_fixturePath('synthetic/config-writer.ts')
    const target = `const target = join(root, 'agentmux.config.json');`
    expect(configVersionsIn(target + `await writeFile(target, JSON.stringify({version: 9}));`, label)).toEqual([9])
    expect(configVersionsIn(target + `await readFile(target); await writeFile('other.json', JSON.stringify({version: 1}));`, label)).toEqual([])
    expect(Number.isNaN(configVersionsIn(target + `await writeFile(target, JSON.stringify({hosts: []}));`, label)[0])).toBe(true)
    expect(Number.isNaN(configVersionsIn(target + `const DEFAULT_CONFIG = {version: 1}; await writeFile(target, JSON.stringify({...structuredClone(DEFAULT_CONFIG)}));`, label)[0])).toBe(true)
  })

  it('recognizes only the seed module that bundles the actual ConfigStore default export', () => {
    const source = `const seedModule = join(root, 'seed.mjs'); const source = join(repository, 'apps/desktop/src/main/config-store.ts');
      await build({stdin:{contents: \`export { DEFAULT_CONFIG } from \${JSON.stringify(source)}\`}, outfile: seedModule});
      const { DEFAULT_CONFIG } = await import(pathToFileURL(seedModule).href);
      await writeFile(join(root, 'agentmux.config.json'), JSON.stringify({...structuredClone(DEFAULT_CONFIG)}));`
    const label = _hygiene_fixturePath('synthetic/derived-config.ts')
    expect(configVersionsIn(source, label)).toEqual([CONFIG_VERSION])
    expect(Number.isNaN(configVersionsIn(source.replace('src/main/config-store.ts', 'src/main/unrelated.ts'), label)[0])).toBe(true)
    expect(configVersionsIn(source.replace('{...structuredClone(DEFAULT_CONFIG)}', '{...structuredClone(DEFAULT_CONFIG),version:1}'), label)).toEqual([1])
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
    ).toEqual(expect.arrayContaining([
      'file-editing-fixture.mjs',
      'measure-desktop-resources.mjs',
      'probe-attention-review-restart.mjs'
    ]))
    expect(writers.length).toBeGreaterThan(3)
    expect(new Set(writers.map(script => script.path)).size).toBe(writers.length)
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
