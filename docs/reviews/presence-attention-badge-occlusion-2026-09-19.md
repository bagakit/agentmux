# 计划评审：叠压头像簇里注意力角标被邻座盖住

- 日期：2026-09-19
- 评审对象：presence 簇注意力角标 `?`/`!` 落在被叠压的右缘、在多 Agent 簇里不可见（T-001）
- 结论：**approved**

## 缺陷事实（动代码前逐条查证）

1. **注意力角标钉在会被盖住的那条缘上。** `dock.css` 的
   `.agent-avatar[data-attention='needs-you']::after` / `[data-attention='error']::after`
   把角标定位在 `top:-3px; right:-3px`，尺寸 `width:8px; height:8px`
   （`apps/desktop/src/renderer/src/styles/dock.css`，`[data-attention]::after` 组）。
   头像本体 `.agent-avatar` 是 `18px × 18px`（`dock.css:122-123`）。

2. **簇的叠压方向是右压左。** `.selector-presence__slot + .selector-presence__slot`
   给后一枚 `margin-left: calc(-1 * var(--sp-3))`（`--sp-3 = 6px`，
   `apps/desktop/src/renderer/src/styles/selector.css:68` + `tokens.css:49`），
   而 `SelectorList.tsx:67` 给每个 slot `zIndex: index + 1` 随 DOM 序递增。
   于是每一枚的**右** 6px 被右邻座整枚盖在上面。

3. **几何结论：非最后一枚的角标整枚不可见。** 以头像右缘为 0、向外为正：
   角标横向占 `[-5px, +3px]`（`right:-3` 且宽 8 → 内缘 `-(8-3)=-5`、外缘 `+3`）。
   右邻座（18px 宽、高 z-index、左缘落在 `-6px`）覆盖所有 `x ≥ -6px`，
   即 `[-6px, +12px]`，把角标 `[-5px, +3px]` **整枚**罩住。
   所以除簇里最后一枚（或只有一枚 Agent）外，`?`/`!`——「这个 Agent 在等你 / 出错了」这个
   全产品最响的通报——在任何多 Agent 簇里都看不见。任务原描述「约 5px 落在 6px 遮挡带内」
   是**低估**：实际是整枚被盖。

4. **四角当前的占用与冲突面。** 右下角是 provider 归并计数
   （`.selector-presence__slot small { right:-3px; bottom:-3px }`，`selector.css:77-83`），
   与注意力角标同在被盖的右侧带里；左两角当前空闲、落在可见（不被叠压）的那条缘上。
   `f-27a8f3deq` / T-002 计划新增的显示名字母牌还要再占一个角。
   → 结论：三种标记（注意力角标、归并计数、未来的字母牌）的落角必须**一次性统一决定**，
   放到可见的左侧带，而不是每种标记各自就近挑一个角——各挑一个只会让下一种标记继续掉进
   被盖的右侧带。

## 处置

- 单 Task（T-001）：把落角决定收成一处，注意力角标移到可见的左侧带；
  归并计数与未来的字母牌沿用同一份落角决定。
- 与 `f-27a8f3deq`（认出并寻址某个 Agent）刻意分开：那个 Feature 是**新增**一个判别通道
  （显示名字母牌）；本 Feature 修的是**既有标记被几何盖住**这个缺陷。两者共用「落角一次性决定」
  这条约束，故在 goal 与本文档里交叉引用，但 Closure（要解的问题）不同。

## 验收可证伪性

- 关键回归：构造 ≥3 枚的簇，断言**非最后一枚**的注意力角标落在可见（左）侧带、不落在被叠压的
  右侧带。单枚簇今天就通过、证明不了任何事，所以必须是多枚场景。
- 变异：把落角改回 `top-right`，该断言必须转红。
