import { describe, expect, it, vi } from 'vitest'
import { editorPaneStoreState, storeKeysReadByEditorPane } from './helpers/editor-pane-store.js'

// 守的缺陷：三个测试文件各自手抄了一份 EditorPane 的 store 替身。那些字面量是宽类型
// （`Record<string, unknown>`），所以少一个键 tsc 全程沉默，只在**渲染期**炸
// `Cannot read properties of undefined (reading '...')`——实测同事给 EditorPane 加
// editorRegionModes / editorRegionDiffs 两个读取点时，一次打红 19 条，而红的位置离真因很远。
//
// 把三份合成一份只是把手抄从三处变成一处，仍然是手抄。真正的交付物是这个检测器：
// 判据落在「EditorPane 源码实际读了哪些 state 键」与「替身给了哪些键」的**双向**相等上。
// 单向（只查缺失）漏掉另一半：删掉一处读取而替身留着那个键，就是一个没人会发现的孤儿，
// 下一个人照它写新断言时会以为那个 slice 还承重。
describe('EditorPane 的 store 替身必须与它真读的键一一对应', () => {
  it('替身不缺 EditorPane 读的任何键——缺一个就是一次渲染期 TypeError', () => {
    const read = storeKeysReadByEditorPane()
    const given = new Set(Object.keys(editorPaneStoreState()))
    const missing = [...read].filter((key) => !given.has(key)).sort()
    expect(missing, '这些键 EditorPane 会读，替身没给：加进 editorPaneStoreState()').toEqual([])
  })

  it('替身不含 EditorPane 已经不读的键——留着的是孤儿，会让人误以为那个 slice 还承重', () => {
    const read = storeKeysReadByEditorPane()
    const given = new Set(Object.keys(editorPaneStoreState()))
    const orphans = [...given].filter((key) => !read.has(key)).sort()
    expect(orphans, '这些键 EditorPane 不再读，替身里该删掉').toEqual([])
  })

  it('取值字段给的是空容器而不是 undefined——EditorPane 读的是 state.xxx[key]', () => {
    // 承重区别：容器缺席会在下标那一步炸；空容器才是「这个文件没有对应记录」的真实形状。
    // 把某个容器改成 undefined 会让上面两条照旧绿（键在），只有这条认得出来。
    const state = editorPaneStoreState()
    for (const name of [
      'documents',
      'dirtyDocuments',
      'documentIssues',
      'savingDocuments',
      'documentRevealTargets',
      'editorRegionModes',
      'editorRegionDiffs'
    ]) {
      expect(state[name], `${name} 必须是可下标的容器`).toEqual({})
    }
  })

  it('动作给的是 spy 而不是裸函数——不然「某动作没被调用」这类断言会直接抛', () => {
    // 上面两条只判键在不在，把 vi.fn() 换成 `() => {}` 它们照旧绿；而调用方一旦写
    // `expect(state.overwriteDocument).not.toHaveBeenCalled()`（冲突时不许覆写，正是这一族最要紧的
    // 断言），裸函数会抛「is not a spy」。判据落在「有没有 mock 记录」上，不落在 typeof function 上。
    const state = editorPaneStoreState()
    const actions = Object.entries(state).filter(([, value]) => typeof value === 'function')
    // 挡板：一个动作都没读出来时下面循环一条不跑、整条静默通过。
    expect(actions.length, '替身里必须有动作').toBeGreaterThan(0)
    for (const [name, value] of actions) {
      expect(vi.isMockFunction(value), `${name} 必须是 vi.fn()，否则调用方无法断言它有没有被调用`).toBe(true)
    }
  })
})
