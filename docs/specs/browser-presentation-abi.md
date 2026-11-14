# Browser 展示媒体 ABI

本文说明当前 Desktop Browser 呈现接口的来源、接线与调用边界。精确字段、参数 union、回执及事件只由 [shared/contracts.ts](../../apps/desktop/src/shared/contracts.ts) 的 `BrowserPresentation*` 类型、`BROWSER_PRESENTATION_EVENT_CHANNEL` 和 `AgentMuxDesktopApi.browser` 定义；本文不另存候选类型或第二套 API。

资源寿命见[资源合同](browser-presentation-resource-contract.md)。产品行为引用[《多位置呈现、局部遮挡与输入交接》](../design/behavior/browser-workface.md#多位置呈现局部遮挡与输入交接)，视觉引用[Browser 呈现约束](../design/presentation/browser-workface.md)。当前源码接线不代表已安装 App、物理输入、媒体停轨或完整工作面恢复通过验收。

## 唯一来源与调用链

| 来源 | 持有的事实 |
| --- | --- |
| [shared/contracts.ts](../../apps/desktop/src/shared/contracts.ts) | 可序列化 occurrence、geometry、lease、capture、ACK、activation、receipt、presentation event，以及原 Browser API 类型 |
| [preload/index.ts](../../apps/desktop/src/preload/index.ts) 的 `browser` | 六项 invoke 与 `onPresentationEvent` 的参数转发、监听及自身退订 |
| [main/ipc.ts](../../apps/desktop/src/main/ipc.ts) 的 `registerIpc` | 原 `handleWithEvent` 接线；登记时在首次异步准备前，从真实 `event.sender`／`event.senderFrame` 捕获原文档的原生身份快照，交 BVM 校验并返回实际结果 |
| [ipc-sender-trust.ts](../../apps/desktop/src/main/ipc-sender-trust.ts) 的 `assertAppDocumentSender`（由 `ipc.ts` 的 App registrar 统一调用） | 原受信 IPC 入口检查；不替代 BVM 的当前 requester 文档与 lease 校验 |
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

## 参数的身份与几何语义

- occurrence 用 `presentationId` 和 Core 位置字段表达，与 `browserId` 分别传入；展示位置不改变 Browser 的资源 Workspace。Main 从真实 IPC sender 取得 Electron identity，payload 不携带 WebContents、Session、frame、origin、Profile 权限或任意 source URL。
- lease 与 capture 是 Main 颁发的 opaque handle。类型存在不证明当前授权；空、过期、属于另一 requester 或资源已失效的句柄都不能继续取得权限。
- geometry 要么是不可见，要么是可见加正面积的有限 bounds。临时测得的零尺寸不表示页面已关闭；viewport 与 Native 几何仍归 Browser owner。

capture 的取得与共享、ACK 的 track 规则、撤销与清理的寿命，唯一见[资源合同《登记、ARM、ACK 与撤销》](browser-presentation-resource-contract.md#登记armack-与撤销)。

## 事件通道

`BROWSER_PRESENTATION_EVENT_CHANNEL` 的生产者是 BVM，preload 把它转发给媒体 holder。`capture-revoked` 与 `input-owner-changed` 描述媒体与输入位置，不交给 Browser 实体的关闭 reducer；实体的更新、不可用与关闭继续走 `BrowserEvent` 与 `onEvent` 通道。`onPresentationEvent` 返回的函数只退订自身 listener。

原 App 加载与来源仍沿 [top-frame-navigation.ts](../../apps/desktop/src/main/top-frame-navigation.ts) 及实际 Main 加载入口。新调用者必须消费这些已有身份与授权边界，不能靠同名 preload／handler、任意 file origin 或 mock 数据冒真实 Native 资格。页面输入、IME、selection、clipboard、停轨及普通恢复分别需要对应实际事实，源码接口说明不代签这些结果。
