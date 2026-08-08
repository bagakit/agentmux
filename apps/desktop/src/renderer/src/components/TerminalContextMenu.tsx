import * as ContextMenu from '@radix-ui/react-context-menu'
import {
  ClipboardPaste,
  Copy,
  Eraser,
  Search,
  TextSelect,
  UnfoldVertical
} from 'lucide-react'
import type { ReactNode } from 'react'
import { terminalMenuChords } from '../lib/terminal-menu-chords'
import { isMacPlatform } from '../lib/host-platform'
import {
  terminalSelectionSuppressionHint,
  type MouseTrackingMode
} from '../lib/terminal-selection-mode'

export function TerminalContextMenu({
  children,
  hasSelection,
  mouseTrackingMode,
  onClear,
  onCopy,
  onPaste,
  onSearch,
  onSelectAll,
  onScrollToBottom
}: {
  children: ReactNode
  hasSelection: boolean
  // xterm 此刻的鼠标上报模式（`terminal.modes.mouseTrackingMode`）。**这是复制三合一失效的根因入口**：
  // TUI 一开鼠标上报，xterm 就停用选区服务，平白左拖不再建选区，于是 getSelection() 恒空、右键
  // Copy 变灰、Ctrl/Cmd+C 全部落空（机制见 lib/terminal-selection-mode.ts）。菜单把这个模式喂给那个
  // 纯模块，拿回「要不要提示、提示什么」——决定权整个在 lib，这里只渲染结果。
  //
  // **必填，不给默认值**：它曾经是可选的（接线还没落地时的临时形状），而可选在这里买到的只是 tsc
  // 的沉默——全仓只有 TerminalView.tsx 一个调用点，删掉那行 JSX 属性、或写成 `{undefined && …}`，
  // 整条能力就静默消失且编译照过（记忆 optional-prop-only-buys-silence）。改成必填之后，删属性是
  // 编译错误；至于「传进来的是不是那次真读取」，类型系统答不了，由
  // test/terminal-mouse-tracking-sampling.test.ts 按 AST 判取值身份（把实参换成常量 'none' 会红）。
  //
  // 分工提醒：模式 → 提示文案的映射在 lib 里被逐模式变异测试钉死；组件这侧只负责「把这个 prop 喂给
  // terminalSelectionSuppressionHint 并渲染其结果」，由 terminal-context-menu-selection-hint 守。
  mouseTrackingMode: MouseTrackingMode
  onClear: () => void
  onCopy: () => void
  onPaste: () => void
  onSearch: () => void
  onSelectAll: () => void
  onScrollToBottom: () => void
}) {
  const isMac = isMacPlatform()
  // 键位不在这里算：三个走注册表、paste 走原生 Edit→Paste 的和弦，理由与来源都在 lib 那一层。
  const chords = terminalMenuChords(isMac)
  // 选区被压制时该说的那句逃生提示（mac: ⌥Option 拖；别处: Shift 拖），否则 null（菜单照常）。
  // **不给 `?? 'none'` 兜底**：prop 必填之后那个兜底是死代码，而它一旦留着，将来若有人把接线改成
  // 传 undefined，提示会静默消失且这里看起来一切正常。整个判定在 lib，这里不重写位掩码或平台判断。
  const selectionHint = terminalSelectionSuppressionHint(mouseTrackingMode)
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="tab-context-menu terminal-context-menu"
          collisionPadding={8}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <ContextMenu.Item className="tab-context-menu__item" disabled={!hasSelection} onSelect={onCopy}>
            <Copy size={14} /><span>Copy</span><kbd>{chords.copy}</kbd>
          </ContextMenu.Item>
          {/* Copy 变灰不是没缘由的：TUI 占用了鼠标，xterm 停用了选区服务，所以平白拖动选不中东西。
              紧贴 Copy 之下说清「为什么 + 怎么办」，把用户从这个静默死胡同里领出来。ContextMenu.Label
              不可聚焦、不响应点击，纯粹是说明文字。selectionHint 为 null（未压制）时整行不挂。 */}
          {selectionHint ? (
            <ContextMenu.Label className="tab-context-menu__hint" role="note">
              {selectionHint}
            </ContextMenu.Label>
          ) : null}
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onPaste}>
            <ClipboardPaste size={14} /><span>Paste</span><kbd>{chords.paste}</kbd>
          </ContextMenu.Item>
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onSelectAll}>
            <TextSelect size={14} /><span>Select all</span>
          </ContextMenu.Item>
          <ContextMenu.Separator className="tab-context-menu__separator" />
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onSearch}>
            <Search size={14} /><span>Find</span><kbd>{chords.search}</kbd>
          </ContextMenu.Item>
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onScrollToBottom}>
            <UnfoldVertical size={14} /><span>Scroll to bottom</span>
          </ContextMenu.Item>
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onClear}>
            <Eraser size={14} /><span>Clear terminal</span><kbd>{chords.clear}</kbd>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
