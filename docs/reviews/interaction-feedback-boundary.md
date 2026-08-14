# 边界：f-25k8f8m9k T-004 与 f-25h8fysz9 不是同一件事

2026-09-13 核实。两个 feature 落在同一批文件上（TransientErrorNotice / ServiceWindowNotice /
notification-presentation / error-presentation），所以看起来重叠。实际问的是两个正交的问题，
合并会让任何一方的验收都说不清。

**f-25h8fysz9（结果通报分级）问：这个结局配得上哪一档？怎么措辞？**
今天只有一档。TransientErrorNotice 硬编码 AlertTriangle + role="alert" + aria-live="assertive"，
凡是走到这里的结局都以同等紧迫度尖叫；而 presentError 有 48 个调用点全都汇进这一档。
「你选了一个已经在列表里的文件夹」和「磁盘写失败」现在长得一模一样。

**f-25k8f8m9k T-004（统一局部反馈与注意力投影）问：这条通知属于哪个请求？在哪能找回它？**
它的验收全是身份与定位：跨视图同一请求、关掉 transient 后重放不复活、未解决的持久问题仍能找到、
多视图已回答的请求不继续显示 Needs You、全局摘要定位同一请求。

同样一张卡片，一个决定它多大声、说什么话，一个决定它是谁、在哪找。删掉任一方，另一方的缺陷
原样存在：全部收敛了身份定位，重复选文件夹依然会尖叫；全部分好了档，扇出时依然不知道哪条
对应哪个 agent。

## 执行约定

- f-25h8fysz9 先行（缺陷已被用户实际撞到，且不依赖 T-004 的任何产物）。
- 它**不得**新造第三套通知语汇：ServiceWindowNotice 已经是既有抽象（role="status"、
  aria-live="polite"、data-kind 分色、说清哪步失败/什么状态/怎么恢复，ShellEnvironmentNotice 与
  RuntimeOwnershipNotice 都是它 14 行的代理）。分级要扩既有语汇，不是另起一套。
- 它**不得**动身份/定位/注意力/重放语义——那是 T-004 的轴。
- T-004 立项时不要重复描述分级；引用本文件。

## 一条会咬人的前提（写在这里防止两边各踩一次）

Electron 的 ipcRenderer.invoke 丢掉 .code 和 .detail，只送 message（error-presentation.ts 的头注释
已列为三条拒绝「code→文案表」的理由之一）。所以档位若在 renderer 侧靠 code 判定，会在**恰好产生
用户那次报错的那条路径上**完全失效；靠 message 子串判定则不可强制、改文案即静默回归。
档位必须在 code 还存在的地方（主进程抛出点/处理点）决定，再作为显式字段送到 renderer。
