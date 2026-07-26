import { describe, expect, it } from 'vitest'
import { editorSaveAction } from '../src/renderer/src/lib/editor-save-shortcut.js'

// 编辑器此前只有工具栏按钮能保存，键盘上按不了。补快捷键时真正要定的不是键位，而是这个键在
// 每种文件状态下各自意味着什么——尤其是磁盘已经分叉时它**绝不能**当成普通保存。

describe('保存快捷键此刻该做什么', () => {
  it('有改动就保存', () => {
    expect(editorSaveAction({ dirty: true, saving: false })).toBe('save')
  })

  it('没有改动就什么也不做，不重写一遍相同内容', () => {
    expect(editorSaveAction({ dirty: false, saving: false })).toBe('none')
  })

  it('已经在保存时不排第二次', () => {
    // 一次写盘在飞的时候再按，不该叠一次写；enqueueFileSave 会串行化，但让键在这里就停住更诚实。
    expect(editorSaveAction({ dirty: true, saving: true })).toBe('none')
  })

  it('磁盘上已经变了的时候，快捷键绝不覆盖——这是本模块存在的全部理由', () => {
    // 覆盖是这条通路上唯一不可逆的动作，而快捷键是最容易被下意识按下的入口。
    // 用户在别处改了这个文件、然后习惯性按下保存，就把别人的改动无声冲掉了。
    expect(editorSaveAction({ dirty: true, issue: 'changed', saving: false })).toBe('conflict')
    expect(editorSaveAction({ dirty: true, issue: 'deleted', saving: false })).toBe('conflict')
    // 干净时的分叉同样不许走成保存——Reload/Overwrite 仍然要由人来选。
    expect(editorSaveAction({ dirty: false, issue: 'changed', saving: false })).toBe('conflict')
  })

  it('分叉与"没什么可存"是两回事，不能都答 none', () => {
    // 两者都不写盘，但原因完全不同，而这个区别决定用户下一步该做什么。
    // 若哪天把 conflict 并进 none，这条会红。
    expect(editorSaveAction({ dirty: true, issue: 'changed', saving: false }))
      .not.toBe(editorSaveAction({ dirty: false, saving: false }))
  })

  it('上一次写盘失败后允许再按，因为重试是可逆的', () => {
    // 把 write-error 也堵死等于让用户只能回去点按钮，而这正是本次要修的毛病。
    expect(editorSaveAction({ dirty: true, issue: 'write-error', saving: false })).toBe('save')
  })

  it('读盘都没成功时不保存——此刻的 revision 不可信', () => {
    expect(editorSaveAction({ dirty: true, issue: 'read-error', saving: false })).toBe('none')
  })

  it('分叉的优先级高于"正在保存"', () => {
    // 顺序若反过来，一次正在飞的保存会把分叉遮成 none，下一次按键就可能落成 save。
    expect(editorSaveAction({ dirty: true, issue: 'changed', saving: true })).toBe('conflict')
  })
})
