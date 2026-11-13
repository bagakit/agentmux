// 聚焦画面对自己处理的 Command 和弦的认领。窗口路由在 capture 段先拿到每个键；一个画面若自己处理某个和弦
// （截图标注编辑器的 Cmd+D 复制、Cmd+[ / Cmd+] 调层级），就在这里为自己的根元素登记一个判定，路由把
// 「事件目标在一个认领了这个和弦的画面里」当作编辑作用域的事实，带 not-in-editable 门的工作台绑定让路。
// 认领按和弦，不按整块画面：画面没认领的工作台和弦（Cmd+T、Cmd+W、Cmd+1…9）照常生效。

import type { ShortcutEvent } from './shortcut-registry'

type ChordOwner = (event: ShortcutEvent) => boolean
const owners = new WeakMap<Element, ChordOwner>()

/** Claims the chords `owns` accepts for keys whose target is inside `root`; the returned function releases the claim. */
export function claimSurfaceChords(root: Element, owns: ChordOwner): () => void {
  owners.set(root, owns)
  return () => { if (owners.get(root) === owns) owners.delete(root) }
}

/** True when the nearest claiming surface around `target` declares this chord as its own. */
export function surfaceOwnsChord(target: Element, event: ShortcutEvent): boolean {
  for (let node: Element | null = target; node; node = node.parentElement) {
    const owns = owners.get(node)
    if (owns) return owns(event)
  }
  return false
}
