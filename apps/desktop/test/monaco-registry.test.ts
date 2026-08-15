import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  DETECTABLE_LANGUAGE_IDS,
  getUnregisteredDetectedLanguageIds
} from '../src/renderer/src/lib/language-detect.js'
import { ASTRO_LANGUAGE_ID } from '../src/renderer/src/lib/monaco-languages/register-astro.js'
import { JSONL_LANGUAGE_ID } from '../src/renderer/src/lib/monaco-languages/register-jsonl.js'
import { SVELTE_LANGUAGE_ID } from '../src/renderer/src/lib/monaco-languages/register-svelte.js'
import { VUE_LANGUAGE_ID } from '../src/renderer/src/lib/monaco-languages/register-vue.js'
import { declarationOf, importedModuleOf, parseModule, parseModuleFile } from './helpers/ts-binding.js'

const require = createRequire(import.meta.url)

const MONACO_ENTRY = new URL('../src/renderer/src/monaco.ts', import.meta.url).pathname

/**
 * 每个自定义语言：注册函数名、它住的模块、以及它注册出来的那个 id。
 *
 * 这张表是本文件唯一手抄的东西，而它的两半会被互相校验：id 从各自模块 import 进来（不是字面量），
 * 注册函数是否真的被 monaco.ts 调用则由 {@link registeredCustomLanguageIds} 走 binder 判定。
 */
const CUSTOM_LANGUAGES = [
  { registrar: 'registerVueLanguage', module: './lib/monaco-languages/register-vue', id: VUE_LANGUAGE_ID },
  { registrar: 'registerSvelteLanguage', module: './lib/monaco-languages/register-svelte', id: SVELTE_LANGUAGE_ID },
  { registrar: 'registerAstroLanguage', module: './lib/monaco-languages/register-astro', id: ASTRO_LANGUAGE_ID },
  { registrar: 'registerJsonlLanguage', module: './lib/monaco-languages/register-jsonl', id: JSONL_LANGUAGE_ID }
] as const

/**
 * 一个自定义语言的注册调用在不在 monaco.ts 的**顶层**。
 *
 * 为什么走 binder 而不是 `source.includes('registerVueLanguage(monaco)')`：注释掉那一行，文本仍在文件里
 * （`// registerVueLanguage(monaco)`），grep 判据完全看不出区别——这正是本仓 [grep-guard-cannot-see-early-return]
 * 记过的形状。AST 里被注释掉的调用根本不是节点，删掉或注释掉都一样判否。
 *
 * 同时校验被调用的那个名字**解析到它应在的模块**：一个同名局部函数（`function registerVueLanguage() {}`）
 * 会让文本判据继续通过，而实际什么都没注册。`importedModuleOf` 回答的是 import 关系，不是拼写。
 *
 * 只认顶层语句：注册必须在模块求值时无条件发生。藏进 `if` 或某个没人调的函数体里的调用，
 * 在真实启动路径上不会执行，这里也不该算数。
 */
function callsRegistrarAtTopLevel(
  module: { sourceFile: ts.SourceFile; checker: ts.TypeChecker },
  registrar: string,
  expectedModule: string
): boolean {
  return module.sourceFile.statements.some((statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false
    const callee = statement.expression.expression
    if (!ts.isIdentifier(callee) || callee.text !== registrar) return false
    return importedModuleOf(declarationOf(module, callee)) === expectedModule
  })
}

/** monaco.ts 真正注册出来的那些自定义 id——由「调用在场」推出，不是抄一份清单。 */
function registeredCustomLanguageIds(path = MONACO_ENTRY): string[] {
  const module = parseModuleFile(path)
  return CUSTOM_LANGUAGES
    .filter((language) => callsRegistrarAtTopLevel(module, language.registrar, language.module))
    .map((language) => language.id)
}

function installedMonacoLanguageIds(): Set<string> {
  const monacoRoot = resolve(dirname(require.resolve('monaco-editor')), '../..')
  const editorMainPath = join(monacoRoot, 'esm/vs/editor/editor.main.js')
  const editorMain = readFileSync(editorMainPath, 'utf8')
  const registerFiles = [...editorMain.matchAll(
    /['"](\.\.\/languages\/(?:definitions|features)\/[^'"]+\/register\.js)['"]/g
  )].map((match) => resolve(dirname(editorMainPath), match[1]!))
  const ids = new Set<string>()
  for (const registerFile of registerFiles) {
    const source = readFileSync(registerFile, 'utf8')
    for (const match of source.matchAll(/\bid:\s*["']([^"']+)["']/g)) ids.add(match[1]!)
  }
  const modesRegistry = readFileSync(
    join(monacoRoot, 'esm/vs/editor/common/languages/modesRegistry.js'),
    'utf8'
  )
  const plaintext = modesRegistry.match(/PLAINTEXT_LANGUAGE_ID\s*=\s*["']([^"']+)["']/)?.[1]
  if (!plaintext) throw new Error('Installed Monaco does not declare a plaintext language id')
  ids.add(plaintext)
  return ids
}

describe('Monaco language registration truth', () => {
  it('keeps every detector output inside the installed or AgentMux-registered language set', () => {
    const registered = installedMonacoLanguageIds()
    // 自定义 id 来自「monaco.ts 确实调了那个注册函数」，而不是本文件抄的四个常量。
    // 抄一份的话，注释掉任何一个 registerXLanguage(monaco) 这条都照样绿——那个守卫名叫
    // 「registration truth」却从不检查 registration。
    for (const customId of registeredCustomLanguageIds()) registered.add(customId)

    expect(DETECTABLE_LANGUAGE_IDS.length).toBeGreaterThan(1)
    expect(getUnregisteredDetectedLanguageIds(registered)).toEqual([])
  })

  it('reports the exact detector capability missing from a registry', () => {
    const registered = new Set(DETECTABLE_LANGUAGE_IDS)
    registered.delete('jsonl')
    expect(getUnregisteredDetectedLanguageIds(registered)).toEqual(['jsonl'])
  })

  it('今天四个注册函数都真的被调用了——否则上一条的通过是因为检测器宽松', () => {
    // 没有这条，「注册函数一个都没被调用」与「检测器恰好不产出自定义 id」在上面那条里同样是绿的。
    expect(registeredCustomLanguageIds().sort())
      .toEqual(CUSTOM_LANGUAGES.map((language) => language.id).sort())
  })
})

/**
 * 判据自检：上面那个提取器必须能分辨四种「看起来注册了但没有」的写法。
 *
 * 合成源码走的是与真实文件**同一条** parse/binder 路径（parseModule vs parseModuleFile 只差读盘），
 * 所以这里证明的能力就是真实文件上生效的能力，不存在「对真文件弱判、对自检强判」的分裂。
 */
describe('注册提取器分得清这四种没注册', () => {
  const header = `import { registerVueLanguage } from './lib/monaco-languages/register-vue'\n`
  const parse = (source: string): typeof CUSTOM_LANGUAGES[number]['id'][] => {
    const module = parseModule(source, '/synthetic/monaco.ts')
    return CUSTOM_LANGUAGES
      .filter((language) => callsRegistrarAtTopLevel(module, language.registrar, language.module))
      .map((language) => language.id)
  }

  it('真的调用了才算', () => {
    expect(parse(`${header}registerVueLanguage(monaco)\n`)).toEqual([VUE_LANGUAGE_ID])
  })

  it('注释掉的调用不算——文本还在，节点没了', () => {
    expect(parse(`${header}// registerVueLanguage(monaco)\n`)).toEqual([])
  })

  it('整行删掉不算', () => {
    expect(parse(header)).toEqual([])
  })

  it('同名局部函数不算——拼写一样，解析到的模块不一样', () => {
    expect(parse(`function registerVueLanguage() {}\nregisterVueLanguage(monaco)\n`)).toEqual([])
  })

  it('藏在条件里不算——启动路径上不保证执行', () => {
    expect(parse(`${header}if (flag) registerVueLanguage(monaco)\n`)).toEqual([])
  })
})
