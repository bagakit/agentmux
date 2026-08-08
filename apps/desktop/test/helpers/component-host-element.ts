import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'

/**
 * 「这个 JSX 标签**最终落在哪个 DOM 元素上**」的解析器：跟着 import 走到组件自己的文件，读出它
 * 返回的根元素，而不是接受标签名。
 *
 * ─── 为什么这个文件必须存在 ───
 *
 * 本仓有一族判据把 DOM 标签名硬写在断言里：
 *
 *     expect(owners).toEqual(['textarea'])            // launcher-submit：onKeyDown 挂在哪
 *     if (node.type === 'input' || node.type === 'textarea')   // pr-launch：表单里有哪几格
 *
 * 这两条在 #609/#622 把 8 个受控 textarea 收进 `ComposerTextarea` 那层壳之后**同时对正确代码打红**：
 * 标签名从 `textarea` 变成了 `ComposerTextarea`，而元素其实还是那个 textarea。本仓 #731 记过：
 * 对正确代码打红的守卫会被下一个作者整条删掉——所以修法是修判据，不是把生产代码改回裸 textarea。
 *
 * 而「把 `'ComposerTextarea'` 也加进允许的名字里」是错的修法：那是**接受名字**。同名的组件可以来自
 * 任何地方，也可以在某次重构里变成一个 `<div>` 包着的富文本框——名字一个字都不用改，而调用方的
 * `onKeyDown` 从此落在一个 div 上。判据必须跟着间接走。
 *
 * ─── 这个解析器**保证**什么 ───
 *
 * 给定「消费者文件 + 它用的那个组件标签名」，它做四件事，每一件失败都**响亮抛错**（不是静默放过）：
 *
 *   1. 在消费者文件里找到绑定这个名字的 import，取出模块路径。不是相对路径（第三方包）就抛——
 *      本仓的判据只对自己树里的组件成立。
 *   2. 解析那个文件，找到同名的导出组件（`export function X` 与 `export const X = (…) => …` 都认，
 *      因为两种都是合法写法，只认一种会变成 #731 那样的假红）。
 *   3. 找出它返回的那个根 JSX 元素，读出标签名。根是另一个组件（大写开头）时抛错：这个解析器
 *      **只跟一层**，这是点名的缺口，不是被覆盖的。
 *   4. 读出它的 rest 形参名，并回答「根元素上有没有 `{...rest}`」——也就是**调用方给的属性到不到
 *      那个 DOM 元素**。
 *
 * ─── 它**不**保证什么（docstring 不许承诺断言不做的事，这本身是本仓的一族缺陷）───
 *
 *   - 它不证明壳内部的取值接线对。壳把 `onValueChange` 转成 DOM `onChange` 这条路是
 *     `composer-ime.test.ts` 的判据（那个文件里「壳里那份 ime 就是 composerCompositionHandlers 的
 *     结果」与「壳把其余属性整份转发下去」两条），本文件的消费者**引用**那条判据，不重抄一份。
 *   - 它不证明这个组件真的被挂到屏上。desktop 包没有 DOM 测试环境，挂载是另一族缺口（#204）。
 *   - `forwardsCallerProps` 只回答「根元素上有没有对 rest 形参的整份展开」。壳把某个属性从 rest 里
 *     摘出来单独处理时（`Omit` 掉的那几个就是这么做的），这个字段照旧是 true——它说的是「其余属性
 *     转发了」，不是「每个属性都转发了」。
 */

/** 一个 JSX 标签解析到的宿主元素。 */
export type HostElementResolution = {
  /** 最终那个 DOM 标签名，例如 `textarea`。 */
  tag: string
  /** 中间那层组件叫什么；标签本身就是 DOM 元素时为 `undefined`。 */
  viaComponent: string | undefined
  /** 调用方给的其余属性整份转发到了根元素上（`{...rest}`）。 */
  forwardsCallerProps: boolean
}

function fail(message: string): never {
  throw new Error(`component-host-element: ${message}`)
}

function parseFile(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
}

/** 消费者文件里绑定 `name` 的那个 import 的模块路径。 */
function importSpecifierOf(source: ts.SourceFile, name: string): string {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    const bound = bindings.elements.some((element) => element.name.text === name)
    if (!bound) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) {
      fail(`<${name}> 的 import 模块路径不是字符串字面量：${statement.moduleSpecifier.getText(source)}`)
    }
    return statement.moduleSpecifier.text
  }
  return fail(
    `${source.fileName} 里没有任何 import 绑定 <${name}>——它要么是本文件定义的，要么标签名写错了`
  )
}

/** 把相对模块路径落到磁盘上的 .tsx / .ts 文件。 */
function resolveModulePath(fromFile: string, specifier: string): string {
  if (!specifier.startsWith('.')) {
    fail(`<${specifier}> 不是相对路径：这个判据只对自己树里的组件成立，第三方组件的根元素无从解析`)
  }
  const base = resolve(dirname(fromFile), specifier.replace(/\.js$/u, ''))
  for (const candidate of [`${base}.tsx`, `${base}.ts`, `${base}/index.tsx`]) {
    if (existsSync(candidate)) return candidate
  }
  return fail(`解析不到模块 ${specifier}（从 ${fromFile} 出发），试过 .tsx / .ts / /index.tsx`)
}

/** 认得出的组件实现形状。用具体三种而不是 `SignatureDeclaration`：后者含无体的调用签名。 */
type ComponentImplementation = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression

/** 组件的实现：`export function X` 与 `export const X = (…) => …` 两种写法都认。 */
function componentImplementation(source: ts.SourceFile, name: string): ComponentImplementation {
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue
      const initializer = declaration.initializer
      if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
        return initializer
      }
    }
  }
  return fail(`${source.fileName} 里找不到组件 ${name} 的实现（认 function 声明与箭头/函数表达式绑定）`)
}

/** 那个「其余属性」形参叫什么。解构式取 `...rest` 那一项，整体形参则是它自己。 */
function restParameterName(implementation: ComponentImplementation, name: string): string {
  const parameter = implementation.parameters[0]
  if (!parameter) return fail(`${name} 一个形参都没有：调用方给的属性无从转发`)
  if (ts.isIdentifier(parameter.name)) return parameter.name.text
  if (ts.isObjectBindingPattern(parameter.name)) {
    const restElement = parameter.name.elements.find((element) => element.dotDotDotToken)
    if (restElement && ts.isIdentifier(restElement.name)) return restElement.name.text
    return fail(`${name} 的解构形参里没有 rest 元素：调用方给的其余属性被就地丢掉了`)
  }
  return fail(`${name} 的形参形状无法识别：${parameter.name.getText()}`)
}

/** 组件返回的那个根 JSX 元素。跳过嵌套函数体，所以属性里的箭头函数不会被当成返回。 */
function rootJsxElement(
  implementation: ComponentImplementation,
  name: string
): ts.JsxOpeningLikeElement {
  const found: ts.JsxOpeningLikeElement[] = []
  const collect = (node: ts.Node): void => {
    // 嵌套函数有自己的返回，与本组件的根元素无关。
    if (node !== implementation && ts.isFunctionLike(node)) return
    if (ts.isReturnStatement(node) && node.expression) {
      let expression: ts.Expression = node.expression
      while (ts.isParenthesizedExpression(expression)) expression = expression.expression
      if (ts.isJsxElement(expression)) found.push(expression.openingElement)
      else if (ts.isJsxSelfClosingElement(expression)) found.push(expression)
      else if (ts.isJsxFragment(expression)) {
        fail(`${name} 的根是一个 Fragment：没有单一宿主元素可以接住调用方的属性`)
      }
    }
    ts.forEachChild(node, collect)
  }
  // 表达式体箭头函数（`= (props) => <textarea … />`）没有 return 语句，直接看它的 body。
  if (ts.isArrowFunction(implementation) && implementation.body && !ts.isBlock(implementation.body)) {
    let expression: ts.Expression = implementation.body
    while (ts.isParenthesizedExpression(expression)) expression = expression.expression
    if (ts.isJsxElement(expression)) found.push(expression.openingElement)
    else if (ts.isJsxSelfClosingElement(expression)) found.push(expression)
  } else if (implementation.body) {
    ts.forEachChild(implementation.body, collect)
  }

  if (found.length === 0) fail(`${name} 没有返回任何 JSX 元素`)
  if (found.length > 1) {
    fail(
      `${name} 有 ${found.length} 个各自返回 JSX 的出口（${found
        .map((element) => `<${element.tagName.getText()}>`)
        .join(' / ')}）：调用方的属性可能落在其中任意一个，这个解析器不猜`
    )
  }
  return found[0]!
}

/**
 * 把消费者文件里用的一个 JSX 标签解析成它最终落在的 DOM 元素。
 *
 * @param consumerPath 用这个标签的那个文件的绝对路径
 * @param tagName      JSX 里写的标签名。小写（本来就是 DOM 元素）会抛错——调用方自己分流，
 *                     免得这个解析器多一条「其实什么都没解析」的静默出口。
 */
export function resolveHostElement(consumerPath: string, tagName: string): HostElementResolution {
  if (!/^[A-Z]/u.test(tagName)) {
    fail(`<${tagName}> 是 DOM 标签而不是组件：无须解析，调用方应当直接使用它`)
  }
  const consumer = parseFile(consumerPath)
  const shellPath = resolveModulePath(consumerPath, importSpecifierOf(consumer, tagName))
  const shell = parseFile(shellPath)
  const implementation = componentImplementation(shell, tagName)
  const restName = restParameterName(implementation, tagName)
  const root = rootJsxElement(implementation, tagName)
  const tag = root.tagName.getText()
  if (/^[A-Z]/u.test(tag)) {
    fail(
      `${tagName} 的根是另一个组件 <${tag}>：这个解析器只跟一层间接。` +
        `这是点名的缺口——要跟多层就在这里显式实现，不要让判据静默接受一个组件名。`
    )
  }
  const forwardsCallerProps = root.attributes.properties.some(
    (property) => ts.isJsxSpreadAttribute(property) && property.expression.getText() === restName
  )
  return { tag, viaComponent: tagName, forwardsCallerProps }
}
