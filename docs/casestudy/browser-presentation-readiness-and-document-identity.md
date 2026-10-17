# Browser 呈现误拒：加载进度不能代替文档身份

一次“Agent 已打开网页，右侧 Browser 却黑屏”的反馈，暴露了呈现校验中的过度防御和文档身份缺口。已复现的机制是：合法请求会被资源加载状态拒绝，可变 frame 引用又不能保存请求发起时的文档身份。现场那次错误具体命中了哪个条件仍未知；本文不把更新后恢复可见当作根因证明。

## 网页已加载，失败的是呈现登记

用户让 Agent 打开页面，右侧显示 `Page connection needs attention` 和 `Retry connection`。展开后，错误来自 `browser:registerPresentation`，内容为 `Untrusted Browser presentation document`；同一 Browser 的 `pageInfo`、`snapshotText` 已成功，页面后端仍为 ready。

这些结果属于不同对象：网页可读不保证客户端已完成呈现，呈现登记失败也不证明网站或 Agent 失效。客户端更新后，原 Browser 重新展示已能看到页面，任务没有重放；但旧错误没有保留失败的具体原生条件，不能据此归因某项更新。

事故时，[Main IPC](../../apps/desktop/src/main/ipc.ts) 先等待 `prepareForConsumption`，再读取请求的 frame；[BrowserViewManager](../../apps/desktop/src/main/browser-view-manager.ts) 将窗口、sender、frame、加载状态和 URL 的不同拒绝压成同一句错误。[Stage](../../apps/desktop/src/renderer/src/components/BrowserPresentationStage.tsx) 还等待整份 App 文档的 `load`，随后才安排登记。

## 两个代理条件都不够准确

隔离 stock Electron 中的实际 IPC 给出了以下反例。没有改写 native getter，也没有操作用户的页面或 Run。

| 观察 | 能证明什么 |
| --- | --- |
| 原 sender、准确顶层 frame、未 detached、两边 URL 相同，但 DOM ready／window load 时 `isLoadingMainFrame()` 仍为 true | 加载进度不能证明请求者不可信。等待某个回调也不等于已取得 Main 的加载完成事实。 |
| 同 URL 刷新和同源不同 URL 导航后，保存的 frame 对象仍与当前 `mainFrame` 相等，其属性却已原地更新 | 保存 wrapper 引用没有冻结原文档；只比对象和 URL 会遗漏代次变化。 |
| 上述文档更替中，原生 `frameToken` 改变；对应 `processId` 在这些样例中保持不变 | 必须保存请求当时的原生值。token 的作用域属于 renderer process，二者应一起核对。 |

生产代码已有导航撤销，不能因此说所有旧租约都会泄漏。具体缝隙是：导航开始先撤销旧呈现，旧文档仍可能在提交前重新登记；若提交时没有核对原生身份，或异步等待后才读取 token，旧请求就可能被新文档接收。

## 删除错误门槛，守住准确边界

这里的过度防御是把“全部资源加载完成”当成呈现资格。页面和准确请求者仍可工作，拦住它们的是自己的流程，符合 [RED-LINES 四问](../../RED-LINES.md#写拦截前回答四个问题) 要求移除的限制。单纯删除校验也不成立：身份缺口必须由真实原生事实补齐。

修复沿原 owner 完成：

- IPC 在第一个 `await` 前捕获真实 sender/frame 的 `{processId, frameToken}`；登记时只核对这个原请求，不能事后改认新文档。
- 原 `PresentationDocument` 保存不可变的原生值。登记、采集授权、ACK 和输入的当前文档检查共用它；导航提交只清理身份已变化的旧文档，不误撤先完成登记的新文档。
- 删除 Main 的加载完成门槛和 Stage 的整窗 `load` 等待，只保留一次供稳定 host 挂接的任务；没有增加轮询、超时、自动重试或另一份 Store。
- 拒绝给出具体原因，不回显页面内容；sender、顶层 frame、session、URL、准确 occurrence 和输入边界继续成立，原 Browser 与显式恢复入口保留。

长期要求只定义在[Browser 工作面合同](../design/behavior/browser-workface.md)，本页解释这次修复的由来，不建立另一份策略。

## 验证与结论边界

真实生产 sandbox preload → 完整 IPC → Browser manager 调用链验证了：普通子资源仍未结束时，准确原文档可以登记并更新租约；同 URL 和不同 URL 更替使旧租约失效；只暂停一次真实准备过程，完成导航并登记新租约后，再释放旧请求，旧请求得到 `document-changed`，新租约继续可用。原 Browser 只创建一次，原生 source 和 session 保持。

三个原生变异分别恢复加载门槛、删除原身份比较、把快照移到等待之后，均命中对应断言。两个身份变异中，旧请求确实错误取得了新租约，并被测试抓住。[资源测试](../../apps/desktop/test/browser-presentation-resource.test.ts) 另守住提交前的采集拒绝和提交时立即撤销；[Stage 测试](../../apps/desktop/test/browser-presentation-registration-recovery.test.tsx) 验证加载期间登记、原内容保留、显式重试与任务取消。相关测试共 79 项通过，恢复原实现的验证通过，独立 review 无阻塞发现。

这批证据覆盖文档资格、异步竞态和原产品消费者；不代签所有 Electron 版本、系统输入、整窗视觉或已安装客户端。历史黑屏的准确失败条件仍未知，已确认并修正的是可复现的门槛与身份机制。教训是：先说清本次操作真正需要什么事实，再删掉替代事实的门槛；不能用更多等待掩盖身份缺失。
