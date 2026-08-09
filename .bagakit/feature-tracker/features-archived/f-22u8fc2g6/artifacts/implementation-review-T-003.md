# f-22u8fc2g6 独立实现审查（T-003 收尾）

日期：2026-08-29
审查者：主 session（未参与实现）
方法：对着工作树真实代码核对，不采信自述

## T-001 把对话框做平 —— 通过

`styles.css:1698`：

```css
.composer { margin: 6px 8px; overflow: hidden; border-radius: var(--radius);
            background: transparent; box-shadow: none; }
```

- **描边已移除**：没有 `border: 1px solid`。层级由 Surface 明度与工具动作承担，
  符合设计合同「描边不作为控件的主要视觉手段」。
- **可访问性未退化**：`:focus-within`（:1701）仍给出
  `box-shadow: var(--focus-ring), inset 0 0 0 1px var(--focus-line)`，
  focus 时依然有清晰可见的 focus ring。「更平」没有以牺牲可聚焦性为代价。
- **圆角走既有 token**：`var(--radius)`，未新增第四档；静态圆角契约检查
  （`surface-radius-contract.test.ts`）保持通过。
- margin 收敛为 `6px 8px`，与相邻元素节奏一致，不再形成一圈明显留白。

审批卡片（:1721 起）同样不使用描边——原本「卡片描边会与紧邻其下的 Composer 争夺
同一条边界」的冲突，随 Composer 去掉描边而消失，两者边界关系仍清晰。

## T-002 让按钮说出它真正做的事 —— 通过

`AgentComposer.tsx:112-115`：

```
aria-label="Interrupt the current turn"
title="Interrupt the current turn — the session keeps running"
```

- 该按钮调用 `onInterrupt` → Core semantic interrupt，**中断当轮**，Run 与 session 继续存活。
- 可访问名与 tooltip 说的都是「当前这一轮」，并明写 the session keeps running，
  不再是会被读成「我会丢掉整个 session」的 "Stop"。
- 代码注释（:105、:108）明确记录这是 mark-and-wording 修正，
  `onInterrupt`、位置与权重都未改变——避免用户在 Agent 跑动中误按。
- 终止整个 Run/session 仍是 Tabbar 的既有动作，两者对象不同、未合并、未共用措辞。

## 门禁

`pnpm check` 实测全绿：typecheck + 1208 passed / 0 failed / 3 skipped + build 成功。
未放宽超时、未放松断言、未改动打包 E2E 配置。

## 结论

无 blocking 发现。设计 SSOT 已记录 Composer 表面不使用描边、与审批卡片的边界关系，
以及 ■ 中断当轮 vs Tabbar 终止 session 两者不得合并（interaction:78）。
