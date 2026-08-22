import * as ContextMenu from '@radix-ui/react-context-menu'
import {
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  Eraser,
  ScrollText,
  Search,
  TextSelect,
  UnfoldVertical
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Fragment } from 'react'
import { terminalMenuChords } from '../lib/terminal-menu-chords'
import { isMacPlatform } from '../lib/host-platform'
import type { TerminalFileMenuAction } from '../lib/terminal-file-action'
import type { TerminalIdentityMenuAction } from '../lib/terminal-identity-menu'
import {
  terminalSelectionSuppressionHint,
  type MouseTrackingMode
} from '../lib/terminal-selection-mode'

export function TerminalContextMenu({
  children,
  hasSelection,
  identityActions,
  mouseTrackingMode,
  pathActions,
  onClear,
  onCopy,
  onCopyScrollback,
  onCopyViewport,
  onPaste,
  onSearch,
  onSelectAll,
  onScrollToBottom
}: {
  children: ReactNode
  hasSelection: boolean
  /**
   * 这一格 Agent 的身份动作（发消息 / 复制 Session 地址），由 `terminalIdentityMenuActions` 算出。
   *
   * **必填且不给默认值**，理由与下面的 `mouseTrackingMode` 完全一样：可选在这里买到的只是 tsc 的
   * 沉默——删掉 JSX 上那行属性、或写成 `{undefined && …}`，整条能力静默消失而编译照过
   * （记忆 optional-prop-only-buys-silence）。
   *
   * 组件不判「这一格是不是 Agent」：那个判定在 lib 里（非 Agent 返回空数组），这里只渲染结果。
   * 两处各判一次就是同一个决定做了两遍，而漂移的那天不会有断言变红。
   */
  identityActions: TerminalIdentityMenuAction[]
  /** Actions for the file path under the context-menu pointer, if one was hit. */
  pathActions: TerminalFileMenuAction[]
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
  /** 复制可视区那一屏。**不经过选区**，故鼠标上报开着时照常可用（见下方菜单项注释）。 */
  onCopyViewport: () => void
  /** 复制整个回滚缓冲。同上，不经过选区。 */
  onCopyScrollback: () => void
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
          {/* 两条**不经过选区**的复制路。它们读 `terminal.buffer.active`（xterm 的公开数据 API），
              与 SelectionService 无关，所以鼠标上报开着、上面那条 Copy 变灰时，这两条照常工作——
              这才是 #638 的出路：不是把选区修回来，是给一条根本不需要选区的路。
              永不 disabled：它们的可用性不取决于有没有选区。紧跟提示之后，因为用户正是在读那句
              「为什么 Copy 是灰的」时需要看见替代动作。 */}
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onCopyViewport}>
            <ClipboardCopy size={14} /><span>Copy visible output</span>
          </ContextMenu.Item>
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onCopyScrollback}>
            <ScrollText size={14} /><span>Copy all output</span>
          </ContextMenu.Item>
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onPaste}>
            <ClipboardPaste size={14} /><span>Paste</span><kbd>{chords.paste}</kbd>
          </ContextMenu.Item>
          <ContextMenu.Item className="tab-context-menu__item" onSelect={onSelectAll}>
            <TextSelect size={14} /><span>Select all</span>
          </ContextMenu.Item>
          {/* 身份那一簇：**回答的不是同一个问题**。上面五项答「画面上有什么」（选区/可视区/回滚/粘贴/全选），
              这一簇答「这是谁」——所以隔一条分隔线，不混进复制文本那一簇，否则用户会以为它复制的是
              终端内容。
              非 Agent 的那一格 `identityActions` 是空数组，此时**连分隔线一起不挂**：一条分隔线下面
              什么都没有，读起来像有项没渲染出来。 */}
          {identityActions.length > 0 ? (
            <Fragment>
              <ContextMenu.Separator className="tab-context-menu__separator" />
              {identityActions.map((action) => (
                <ContextMenu.Item
                  className="tab-context-menu__item"
                  key={action.key}
                  onSelect={() => void action.onSelect()}
                >
                  <action.icon size={14} /><span>{action.label}</span>
                </ContextMenu.Item>
              ))}
            </Fragment>
          ) : null}
          {pathActions.length > 0 ? (
            <Fragment>
              <ContextMenu.Separator className="tab-context-menu__separator" />
              {pathActions.map((action) => (
                <ContextMenu.Item
                  key={action.key}
                  className="tab-context-menu__item"
                  title={action.title}
                  onSelect={action.onSelect}
                >
                  <action.icon size={14} /><span>{action.label}</span>
                </ContextMenu.Item>
              ))}
            </Fragment>
          ) : null}
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
