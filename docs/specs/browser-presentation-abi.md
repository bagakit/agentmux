# Browser 展示媒体 ABI

本文说明当前 Desktop Browser 呈现接口的来源、接线与调用边界。精确字段、参数 union、回执及事件只由 [shared/contracts.ts](../../apps/desktop/src/shared/contracts.ts) 的 `BrowserPresentation*` 类型、`BROWSER_PRESENTATION_EVENT_CHANNEL` 和 `AgentMuxDesktopApi.browser` 定义；本文不另存候选类型或第二套 API。

资源寿命见[资源合同](browser-presentation-resource-contract.md)。产品行为引用[《Zone→Tabs→Regions 的实体与展示绑定》](../design/behavior/spaces-and-layout.md#zonetabsregions-的实体与展示绑定)，视觉引用[Browser 呈现约束](../design/presentation/browser-workface.md)。当前源码接线不代表已安装 App、物理输入、媒体停轨或完整工作面恢复通过验收。

## 唯一来源与调用链

| 来源 | 持有的事实 |
| --- | --- |
| [shared/contracts.ts](../../apps/desktop/src/shared/contracts.ts) | 可序列化 occurrence、geometry、lease、capture、ACK、activation、receipt、presentation event，以及原 Browser API 类型 |
| [preload/index.ts](../../apps/desktop/src/preload/index.ts) 的 `browser` | 六项 invoke 与 `onPresentationEvent` 的参数转发、监听及自身退订 |
| [main/ipc.ts](../../apps/desktop/src/main/ipc.ts) 的 `registerIpc` | 原 `handleWithEvent` 接线；以真实 `event.sender`／`event.senderFrame` 调 BVM，并交回实际结果 |
| [ipc-sender-trust.ts](../../apps/desktop/src/main/ipc-sender-trust.ts) 的 `requireTrustedSender` | 原受信 IPC 入口检查；不替代 BVM 的当前 requester 文档与 lease 校验 |
| [BrowserViewManager](../../apps/desktop/src/main/browser-view-manager.ts) | 运行期校验、lease／capture／input occurrence，以及原 Native 页面资源；不向 Renderer 导出 Electron 对象 |
| [BrowserPresentationStage](../../apps/desktop/src/renderer/src/components/BrowserPresentationStage.tsx) | 原媒体 holder 与 stage 的实际消费者；报告 geometry、媒体 ACK 和输入意图，消费原事件 |

运行期检查位于 BVM 的 `registerPresentation`、`presentationGeometry`、`requirePresentationDocument`、`requirePresentationLease`、`ackPresentationCapture` 和 `activatePresentation`，第一击参数继续由 `validatePresentationPoint`／`validatePresentationModifiers` 等原校验处理。它们是当前实际入口，不另建一个文档 parser 或许可 manager。

## 接口用途

下表用于定位调用，精确签名以 `AgentMuxDesktopApi.browser` 为准。

| 原接口 | 用途与结果 |
| --- | --- |
| `registerPresentation` | 登记准确 Browser、occurrence 与 geometry，取得 Main 颁发的 lease |
| `updatePresentation` | 更新该 lease 的可见性及原 `BrowserBounds`；不改变 Browser 身份 |
| `removePresentation` | 移除该呈现 lease；不作为关闭原 Browser 的入口 |
| `armPresentationCapture` | 为当前合法可见呈现取得原 Browser 的 capture handle |
| `ackPresentationCapture` | 报告实际 ready／stopped track IDs 或 failed；不把报告等同于物理停轨证明 |
| `activatePresentation` | 同时接收 `leaseId` 与 `BrowserPresentationActivation`，返回 `BrowserPresentationActivationReceipt` |
| `onPresentationEvent` | 监听独立 presentation 事件；返回的函数只退订自身 listener |

`activatePresentation` 的选择意图与第一击准备／提交／取消是同一类型化入口。后台选择传 `select` 与 `focus: 'preserve'`，保留原键盘接受者；第一击沿现有 one-shot input scope，核原 view／Profile／navigation／geometry／capture 并限制重复派发。调用者消费实际 receipt，不能把 Promise 完成、`selected` 或 `input-dispatched` 一律解释成页面业务已成功。完整请求和回执 union 仍只见源码类型。

## 身份、几何与媒体边界

- occurrence 使用原 `presentationId` 和 Core 位置字段，与 `browserId` 分别输入；展示位置不改 Browser 资源 Workspace。Main 从真实 IPC sender 取得 Electron identity，payload 不提供 WebContents／Session／frame／origin／Profile 权限或任意 source URL。
- lease／capture 是 Main 颁发的 opaque handle。空、过期、另一 requester 或已失效资源不得借句柄继续取得权限；类型存在不证明当前授权。
- geometry 明确为不可见或可见加正面积有限 bounds。临时测量零不冒原页面关闭；原 viewport 与 Native 几何仍归原 owner。
- 捕获流由 Renderer 的真实 `getDisplayMedia` 取得。BVM 的原 App Session display handler 只准当前 requester 主 frame／完整文档的准确 pending capture，video-only 且不走 system picker；不放行共享 Session 的所有 frame，也不改原 Source Profile 权限。
- 一个 requester 同时仅一项未 settled arm，原 Browser 同一 capture 可供多个合法可见 stage。source 正常导航更新 Browser 事实；requester 完整文档与资源寿命是授权边界，不能把第一次 arm 的位置变成 capture 的唯一 home。
- ready／stopped ACK 的实际 track IDs 非空且不重复，已 ready 后核同一集合；failed 独立。迟到流若已停止，可直接报告 stopped，不制造 ready。stopped 不重新激活撤销的 scope；旧文档或 scope 无法对账时保持 unconfirmed／unknown，不能据无异常返回证明物理 ended。

## 事件与失效

`BROWSER_PRESENTATION_EVENT_CHANNEL` 的生产者是原 BVM；preload 转发给原媒体 holder。`capture-revoked` 与 `input-owner-changed` 描述媒体／输入位置，不交给原 Browser 实体关闭 reducer；实体更新、不可用及关闭继续走 `BrowserEvent` 与原 `onEvent` 通道。

requester 真正卸载、资源替换／释放或最后可见 consumer 撤去时，沿原 BVM 撤许可与清理。每个 listener 只卸自身；dispose 不让过期 ACK 或迟到 Promise 复活新 scope。Main 发出撤销与 Renderer 物理 track ended 分开表达，缺后者观察时保留未知和服务窗，不能停掉健康原页面。

原 App 加载与来源仍沿 [top-frame-navigation.ts](../../apps/desktop/src/main/top-frame-navigation.ts) 及实际 Main 加载入口。新调用者必须消费这些已有身份与授权边界，不能靠同名 preload／handler、任意 file origin 或 mock 数据冒真实 Native 资格。页面输入、IME、selection、clipboard、停轨及普通恢复分别需要对应实际事实，源码接口说明不代签这些结果。
