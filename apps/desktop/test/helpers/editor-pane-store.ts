import { readFileSync } from 'node:fs'
import { vi } from 'vitest'

/**
 * EditorPane 渲染时会读到的那份 store 替身，以及一条「它读的键我都给了」的自检。
 *
 * 为什么要有这个文件：三个测试文件（editor-save-wiring / editor-copy-wiring / editor-pane-reveal）
 * 各自手抄了一份几乎逐字相同的 state 字面量。这些字面量是 `Record<string, unknown>` 这类宽类型，
 * 所以少一个键 tsc 完全沉默——EditorPane 新读一个 store slice 时，三家一起在**渲染期**炸
 * `Cannot read properties of undefined`，而红的位置离真因很远（实测：加 editorRegionModes /
 * editorRegionDiffs 一次打红 19 条）。手抄搬到一处只是把三份变成一份，仍然是手抄；所以这里同时
 * 提供检测器：从 EditorPane 源码读出它实际取用的 state 键，与这份替身的键集比对。
 */

const EDITOR_PANE_SOURCE = new URL('../../src/renderer/src/components/EditorPane.tsx', import.meta.url)

/**
 * EditorPane 在渲染期读到的 store 形状。
 *
 * 动作一律给 `vi.fn()` 而不是裸函数：调用方经常要断言「某个动作**没**被调用」（比如冲突时不许
 * overwrite），而 `not.toHaveBeenCalled()` 对裸函数会直接抛「is not a spy」。给 spy 的话，关心它的
 * 用例可以直接断言，不关心的用例也照样能渲染——两边都不用自己补。
 *
 * 取值字段给空容器而不是 undefined：EditorPane 读的是 `state.xxx[key]`，容器缺席会在下标那一步炸，
 * 而空容器才是「这个文件没有对应记录」的真实形状。
 */
export function editorPaneStoreState(): Record<string, unknown> {
  return {
    documents: {},
    dirtyDocuments: {},
    documentIssues: {},
    savingDocuments: {},
    documentRevealTargets: {},
    regionCaretFocus: null,
    config: { workspaces: [] as unknown[] },
    editorWordWrap: false,
    editorRegionModes: {},
    editorRegionDiffs: {},
    updateDocument: vi.fn(),
    saveDocument: vi.fn(),
    reloadDocument: vi.fn(),
    overwriteDocument: vi.fn(),
    clearDocumentRevealTarget: vi.fn(),
    clearRegionCaretFocus: vi.fn(),
    attachPersistedFileDocument: vi.fn(),
    reportError: vi.fn(),
    toggleEditorWordWrap: vi.fn(),
    setEditorRegionMode: vi.fn(),
    reloadRegionDiff: vi.fn()
  }
}

/**
 * EditorPane 挂载时会用到的 Monaco 常量，用真值而不是占位符——这样「注册的是不是 Cmd/Ctrl+S」
 * 这件事本身也能被断言。
 *
 * 取自 monaco-editor 0.56.0：KeyMod 在 common/services/editorBaseApi.js:16-19（CtrlCmd 2048 /
 * Shift 1024 / Alt 512），KeyCode 在 monaco.d.ts（KeyE 35 / KeyS 49 / KeyZ 56）与
 * base/common/keyCodes.js:104（F1 59）。注意 KeyMod 与 KeyCode 是两套：KeyCode 里也有个 Shift=4，
 * 那是「Shift 这个按键」而不是修饰位，别抄错。
 *
 * 为什么给全而不只给某条用例要按的那两个：`monacoKeybindingFor` 对查不到的键会**抛**（而不是让
 * `|` 算出 NaN 交给 Monaco 变成一个永不触发的键位）。EditorPane 挂载时注册的不止保存一个——还有
 * 换行开关（Alt+Z）与命令面板（F1）——替身少给一个常量就会让那次注册抛，把一个不相关的
 * 失败算到被测那条接线头上。替身该供的是「真 Monaco 供什么」，不是「这条用例用什么」。
 *
 * 这条教训是实测来的：加 `editor.show-commands` 那次，两个 wiring 文件各自手抄了一份常量而没走这个
 * helper，于是新注册在它们里面抛，16 条测试红在三个与本次改动无关的接线上。所以每个替身都必须调
 * 这个函数——「同一件事抄两份」在这里的代价不是漂移，是把红打到看不出原因的地方。
 */
export function monacoKeybindingConstants(): {
  KeyMod: { CtrlCmd: number; Shift: number; Alt: number }
  KeyCode: Record<string, number>
} {
  return {
    KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
    KeyCode: { KeyE: 35, KeyS: 49, KeyZ: 56, F1: 59 }
  }
}

/**
 * EditorPane 源码里 `state.<name>` 出现过的每个键。
 *
 * 覆盖两种取法：`useAppStore((state) => state.foo)` 与 `useAppStore.getState()` 之后存进局部变量
 * 再 `state.foo` / `currentState.foo`。所以判据不是「匹配 useAppStore 那一行」，而是「源码里对某个
 * 叫 state 的东西取了什么属性」——这样 onMount 回调里那些延迟读取也算进来，它们同样会在按键时炸。
 */
export function storeKeysReadByEditorPane(): Set<string> {
  const source = readFileSync(EDITOR_PANE_SOURCE, 'utf8')
  const keys = new Set<string>()
  for (const match of source.matchAll(/\bstate\.([A-Za-z_$][\w$]*)/g)) {
    keys.add(match[1]!)
  }
  // 挡板：空集上的比对恒绿，是这个仓库经典的假绿。正则或文件路径哪天失效要立刻响亮红。
  if (keys.size === 0) {
    throw new Error(`没有从 ${EDITOR_PANE_SOURCE.pathname} 读出任何 state.<key>——读取器失效了，不是 EditorPane 不读 store`)
  }
  return keys
}
