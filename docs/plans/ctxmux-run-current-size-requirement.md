# ctxmux 需求：Run 的**当前** PTY 尺寸

> 证据来源：本机实跑的 AgentMux 生产状态（46 个 Agent Session、48 个 ctxmux Run）
> + 一个卡死 Run 的 215803 字节原始重放实测 + `@ctxmux/sdk` 全量协议面扫描。
> 提出日期：2026-09-13。

## 0. 一句话

`RunInfo` 报出了这个 Run 此刻的 pid、state、字节游标、attachment 数，
**唯独没有它此刻几列几行**——于是任何进程外的观察者都无法正确重建这个 Run 的屏幕。

## 1. 缺口

协议里 `size` 只出现在四处，没有一处能回答「这个 Run 现在多大」：

| 位置 | 语义 | 能否当当前尺寸 |
|---|---|---|
| `RunSpec.size` | **启动时**的 PTY 尺寸，此后不变 | ❌ |
| `Request::resize.size` | 我**请求**的尺寸（出向命令） | ❌ |
| `ControlReceipt::resize.applied_size` | 这一次 resize 实际生效的尺寸 | ⚠️ 仅自己刚 resize 完可得 |
| `TmuxPaneInfo.size` | tmux 发现面的 pane 尺寸 | ❌ native backend 没有 |

`AttachedSnapshot` / `AttachedHeader` 携带的也是同一个 `RunInfo`，
所以**连 attach 的那一刻都问不出来**。

这不是用法问题，是可重放性的语义漏洞：协议让消费者知道「字节是什么」，
却不让它知道「这些字节是按什么宽度排的」。而没有宽度，字节无法还原成屏幕。

## 2. 它在生产上造成了什么（已实锤）

AgentMux 判断「Agent 是否闲下来、可以收下一条 prompt」的方式，是把 Run 的输出字节
重放进一块进程内的 headless xterm，再看 composer 行（codex 是 `›`）是否为空。
建这块 xterm 需要尺寸，取的就是 `RunInfo`（`spec.size`）——**永远是启动值 80x24**。

而 codex 实际在按 87 行排版（原始字节里 `ESC[85;87H`、`ESC[81;87r`，最大行号 87）。

同一批 215803 字节，喂进不同尺寸：

```
  80x24   composerText('›') = null      ← 观察者看到的（折行不同，认不出 composer）
  200x87  composerText('›') = ""        ← 真相（空 composer，已就绪）
```

后果：`readyThroughByte` 永远填不上，此后**每一条 prompt** 被
`AGENT_PROMPT_NOT_READY` 拒掉，且没有出路。

**全局判别器（46 个会话，零例外）**：握手期开的 `initial-composer` 纪元 **7 个全部 ready**；
Stop hook 开的 `native-stop` 纪元 **24 个全部 pending**。
因为握手发生在渲染器 attach 之前——那一刻 Run 真的还是 80x24，所以那一枚是准的;
窗口一 fit、一 resize，之后每一枚纪元都由一具瞎掉的观察者盯着。

ctxmux 状态库里 48 个 Run 的 `spec.size` **全是 80x24**，无一例外。

## 3. R1（必需）：`RunInfo` 增加当前尺寸

```rust
/// Current PTY dimensions, tracking every applied resize.
current_size: TerminalSize,
```

**判据**：`start(size: 80x24)` → `resize(200x87)` → 此后 `status()` 与 `attach()`
返回的 `RunInfo.current_size` 必须是 `200x87`，而 `spec.size` 仍是 `80x24`。

两者都要在场，**不要拿新字段覆盖旧字段**：`spec.size` 回答「它是怎么启动的」，
`current_size` 回答「它现在是什么」，是两个不同的问题，都有真实消费者。

### 最小复现

```
1. start 一个 Run，size = 80x24
2. resize 到 200x87（receipt.applied_size 正确返回 200x87）
3. status(runId) → RunInfo
4. 观察：RunInfo 里没有任何字段等于 200x87；spec.size 仍是 80x24
   ⇒ 一个刚 attach 的新客户端无法得知这个 Run 现在多宽
```

## 4. R2（强烈建议）：attachment 事件流增加 resize 事件

```rust
RunEvent::Resized { size: TerminalSize }
```

R1 只解决「attach 那一刻」的尺寸。attach **之后**别人（另一个客户端、
同一 App 的另一个窗口）resize 了这个 Run，我这条长命 attachment 收不到任何通知——
我的虚拟屏幕从那一刻起继续按旧尺寸排版，**静默地重新变瞎**。

字节流里其实含有这个信息（TUI 会重画），但要求每个消费者去逆向解析
`ESC[...r` / `ESC[...H` 来猜尺寸，是把协议的责任推给消费者，且每家猜法都不一样。

`RunEvent` 已经有 `gap` / `observation_discontinuity` 这类「你的假设失效了」事件，
`Resized` 与它们同族。

**没有 R2 的话**，消费者只能靠「我是唯一的 resize 发起方」这个假设撑住——
这个假设在多客户端场景静默失效，而失效的表现就是 §2 那种「发不出消息且无出路」。

## 5. 优先级

R1 是**阻断级**：在它落地前，任何进程外屏幕重建都是不可靠的。
R2 是**正确性收口**：决定这个能力是「单写者下正确」还是「无条件正确」。
