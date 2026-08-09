# T-030 Production 内存与资源回收原始证据

测量日期：2026-08-10（Asia/Shanghai）。

## 条件

- Production Electron 43.3.0，默认 `1480 × 940` BrowserWindow。
- 优化前 user-data：`/tmp/agentmux-t030-cycles.4I5fat`，CDP `9232`。
- 优化后 user-data：`/tmp/agentmux-t030-optimized.aius1J`，CDP `9233`。
- 两个目录都只包含同一个 Local Workspace：`/Users/bytedance/proj/priv/bagakit/agentmux`。
- 每个稳定样本在 UI 动作完成后等待 5 秒；`all_closed` 样本等待 30 秒。没有调用 GC、Heap Snapshot 或任何产品内存开关。
- Playwright CDP attach 会创建一个额外 `about:blank` target。所有内存样本都在 detach 后关闭该 target，再等待稳定点；不把测试驱动的 Renderer 计入 AgentMux。
- 系统中另有 `codex · mac-cleaner` 的 AgentMux tmux Session，Workspace 为 `/Users/bytedance/proj/zhouliqihan/mac-cleaner`。它属于用户的其他项目，全程保留，并通过 `AGENTMUX_WORKSPACE_PATH` 从本轮精确计数排除。

## 测量命令

RSS 单位是 KiB。Physical Footprint 只用于同类进程的对照；不把包含共享页的各进程 RSS 直接相加为“应用总内存”。

```bash
child_pids=$(pgrep -P "$main_pid" | paste -sd, -)
ps -p "$main_pid,$child_pids" -o pid=,ppid=,rss=,etime=,command=

vmmap -summary "$main_pid" | rg 'Physical footprint|Physical footprint \(peak\)'
vmmap -summary "$main_renderer_pid" | rg 'Physical footprint|Physical footprint \(peak\)'

curl -s "http://127.0.0.1:$cdp_port/json/list" \
  | jq -r '.[] | [.type,.title,.url] | @tsv'

tmux list-sessions \
  -F '#{session_name}\t#{AGENTMUX_SESSION_LABEL}\t#{AGENTMUX_WORKSPACE_PATH}'
```

Renderer target 的 CDP WebSocket 额外执行 `Runtime.getHeapUsage` 和 `Memory.getDOMCounters`，记录 `usedSize` / `totalSize` / `embedderHeapUsedSize` / `backingStorageSize` 以及 `documents` / `nodes` / `jsEventListeners`。

## 优化前 RSS 与 Renderer 计数

| 场景 | Main | GPU | Utility | Main Renderer | Browser Renderer | JS Heap used bytes | DOM Nodes | JS Listeners | CDP targets |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| cold workspace idle | 211504 | 93456 | 45408 | 179344 | — | 11809440 | 592 | 231 | AgentMux page |
| 5 轮 Terminal 全关 | 171280 | 80448 | 41792 | 208400 | — | 20737508 | 755 | 465 | AgentMux page |
| 5 轮 Editor 全关 | 166896 | 81008 | 41824 | 221776 | — | 24068724 | 814 | 481 | AgentMux page |
| 5 轮 Browser 全关 | 167536 | 81328 | 47056 | 212864 | — | 25278448 | 933 | 586 | AgentMux page |
| 单 Editor 打开 | 167776 | 80960 | 47120 | 223600 | — | 25337384 | 1296 | 690 | AgentMux page + editor worker |
| 单 Terminal 打开 | 169456 | 85728 | 47120 | 220768 | — | 24925180 | 1301 | 541 | AgentMux page |
| 单 Browser 打开 | 172752 | 82624 | 47184 | 217136 | 96144 | 25784288 | 1489 | 1044 | AgentMux page + Example Domain |
| 全关后稳定 30s | 139328 | 71872 | 44192 | 169696 | — | 24925408 | 935 | 528 | AgentMux page |

Physical Footprint 对照：

| 场景 | Main | Main Renderer |
| --- | ---: | ---: |
| cold workspace idle | 79.3 MiB | 63.4 MiB |
| 5 轮 Editor 全关 | — | 115.2 MiB |
| 5 轮 Browser 全关 | — | 114.6 MiB |
| 全关后稳定 30s | 94.8 MiB | 116.1 MiB |

## 优化前资源计数

### Terminal：5 轮

| 轮次 | 打开时当前 Workspace Session | 关闭后 Session | Terminal DOM | 关闭后 Tab |
| --- | --- | ---: | --- | ---: |
| 1 | `b7835e42-7928-4093-920a-4c4f85e6f395` | 0 | 1 → 0 | 0 |
| 2 | `11e872eb-d61e-4368-a769-ed48638fd3c8` | 0 | 1 → 0 | 0 |
| 3 | `241d89ed-da67-46b1-8fd4-6078b83f4768` | 0 | 1 → 0 | 0 |
| 4 | `401622f9-5262-47b1-9137-6a1a89a9aa18` | 0 | 1 → 0 | 0 |
| 5 | `afd84822-3551-4689-aab3-0d5fb2d26b25` | 0 | 1 → 0 | 0 |

每轮同时验证精确 tmux Session 不存在。Core `forgetSession` 会同时删除 watcher、input tail、Session 与 Activity。

### Editor：5 轮

每轮打开时 Monaco Editor DOM=1、Editor textbox=1；关闭后两者=0、Tab=0、Dirty=0。`@monaco-editor/react@4.7.0` 当前默认 `keepCurrentModel=false`，其安装源码在 unmount 时直接执行 `editor.getModel()?.dispose()` 与 `editor.dispose()`；关闭稳定后 Monaco worker target 也回到 0。File owner 的现有回归测试证明 Close/Discard 同时删除 Document 与 Dirty key，重开重读磁盘。

### Browser：5 轮

每轮都显示 `Example Domain`，Browser DOM 1 → 0，Tab 1 → 0，关闭后 `https://example.com/` target 与 Browser Renderer 均为 0。但每次关闭都稳定产生一条 Main 错误：React cleanup 在 `BrowserViewManager.close()` 之后发送 `setBounds(id, null)`，Main 把预期的幂等 hide 当成 `Unknown browser`。

## 归因与最小改动

1. Browser 关闭后 hide 属于预期 teardown：`setBounds(id, null)` 在 Browser 已不存在时改为幂等 no-op；未知 Browser 的非空 bounds 仍然报错。测试同时锁住两条边界。
2. Editor/Monaco 是可选重型 Surface，却由 Renderer entry 和 Workbench 静态导入。使用 React 已有 `lazy` / `Suspense` 将 EditorPane + Monaco 收口为首次打开文件时才加载的 chunk；不新增依赖、预加载开关或第二套 Editor 状态。

Build 产物对照：

| 产物 | 优化前 | 优化后 |
| --- | ---: | ---: |
| 主 Renderer JS | 9237.72 KiB | 1503.83 KiB |
| EditorPane JS | 静态合入主 chunk | 7725.87 KiB |
| 主 Renderer CSS | 296.05 KiB | 71.47 KiB |
| EditorPane CSS | 静态合入主 CSS | 224.58 KiB |

## 优化后对照

| 场景 | Main RSS | GPU RSS | Utility RSS | Main Renderer RSS | JS Heap used bytes | DOM Nodes | JS Listeners | CDP targets |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| cold workspace idle | 157024 | 66288 | 36960 | 102496 | 3456280 | 588 | 226 | AgentMux page |
| Editor/Terminal/Browser 各 5 轮后全关稳定 30s | 178208 | 92496 | 47360 | 231264 | 24136556 | 895 | 825 | AgentMux page |

Physical Footprint：

| 场景 | Main | Main Renderer |
| --- | ---: | ---: |
| cold workspace idle | 81.5 MiB | 41.1 MiB |
| 各 5 轮后全关稳定 30s | 90.0 MiB | 102.1 MiB |

冷启动相比优化前：Main Renderer RSS 从 179344 KiB 降到 102496 KiB（约 -42.8%），Physical Footprint 从 63.4 MiB 降到 41.1 MiB（约 -35.2%），JS Heap used 从 11809440 bytes 降到 3456280 bytes（约 -70.7%）。Main Physical Footprint 为 79.3 → 81.5 MiB，在测量波动内，不宣称 Main Process 改善。

使用过 Monaco 后，动态 chunk 不会从 V8 中卸载，因此不宣称“关闭 Editor 恢复冷启动内存”。各 5 轮后 Renderer RSS 受 Chromium/V8 保留容量影响，优化后该单点反而更高；Physical Footprint 为 116.1 → 102.1 MiB。这证明冷启动收益，不足以支持更广的“使用后内存总是更低”结论。

优化后再次执行 Editor、Terminal、Browser 各 5 轮：

- Editor 每轮 1 → 0，Tab/Dirty 每轮回到 0，首次动态加载正常。
- Terminal 每轮产生唯一 Session ID，关闭后 Core/tmux/Terminal DOM/Tab 全部回到 0。
- Browser 每轮加载 `Example Domain`，关闭后 WebContents target/Browser Renderer/DOM/Tab 全部回到 0；Main 日志不再产生 `Unknown browser` teardown 错误。
- 主 Renderer Console：0 error / 0 warning；DPR=2，Root overflow X/Y=0。
- 视觉证据：`t030-optimized-editor.png`。

## 诚实残余信号

- 基线期的第一次组合脚本遇到一次 raw Terminal `history-limit` 时 tmux Session 已消失。Runtime 回滚后 Core/tmux 计数都为 0；随后真实 tmux integration 5/5、手动等价 tmux 启动 5/5、优化前 UI 5/5 与优化后 UI 5/5 全部通过，无法稳定复现。本轮不为一次非确定信号加 retry/fallback，保留为后续重现时的故障证据。
- DOM Nodes / JS Listeners 在加载过重型 Surface 后高于冷启动，但本轮没有观测到随 5 轮继续增加的孤儿 WebContents、Session、tmux、Monaco worker/model 或 Tab/Document 行为。不以单点 DOM 计数伪装泄漏结论。
- 不为追求更低数字缩减 Terminal 10,000 行 scrollback、Core 2,000 行 snapshot 或 tmux 50,000 行 history-limit；本场景没有证明它们是常驻泄漏，而且它们直接保护 Terminal 恢复与可用性。
