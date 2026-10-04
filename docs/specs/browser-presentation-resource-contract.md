# Browser 展示媒体资源合同

本文说明现有 Browser 呈现接口如何绑定原页面、呈现 lease、媒体 capture 与输入位置。产品约束只由交互 SSOT[《Zone→Tabs→Regions 的实体与展示绑定》](../design/behavior/spaces-and-layout.md#zonetabsregions-的实体与展示绑定)定义；视觉只引用[Browser 呈现约束](../design/presentation/browser-workface.md)。精确接口与运行期校验来源见 [Browser 展示媒体 ABI](browser-presentation-abi.md)，本文不保存另一份类型或任务流程。

## 页面、呈现与媒体分别由谁持有

| 对象 | 当前 holder 与边界 |
| --- | --- |
| 原 Browser 页面 | [BrowserViewManager](../../apps/desktop/src/main/browser-view-manager.ts) 的原 BrowserEntry／WebContents／view／Profile／navigation／viewport；foreign 展示不改资源 Workspace |
| 呈现身份 | 原公共 occurrence 的 `presentationId` 与 exact location；BVM 只持实际注册的瞬态 lease，不建立第二持久位置目录 |
| requester | 真实受信 IPC 的 App WebContents／Session／main frame／完整已加载文档；Renderer payload 不提供这些 Electron identity 或权限 |
| 媒体流与 tracks | [BrowserPresentationStage](../../apps/desktop/src/renderer/src/components/BrowserPresentationStage.tsx) 中原媒体 holder；一个 Browser 的 capture 可共享给多个 video，Main 持许可及失效事实 |
| 输入位置 | 原 Native view 的当前有效 lease；不因多个画面副本生出第二 viewport、导航或输入 owner |

原 source 的正常导航／reload 继续更新 BrowserSnapshot 和画面。真正的 entry／view／WebContents／Profile 替换或释放，与 requester 文档失效分别沿原资源 scope 处理；不能用 source navigationId 把活体媒体流永久钉到首个页面文档，也不能把 file opaque origin 当作 requester 的充分身份。 Profile 切换仅在成功 commit 后撤旧 capture 许可并替换原资源；失败保留旧页与原授权。

## 登记、ARM、ACK 与撤销

原 `AgentMuxDesktopApi.browser` 经 preload、`registerIpc.handleWithEvent` 到 BVM。display handler 对准确 pending scope 提供 video-only 原页面，关闭 system picker，不改原 Source Profile 权限；每 requester 仅一项未 settled arm，避免没有业务 request ID 的 callback 串源。

`armPresentationCapture` 对尚未显示的原生来源先沿当前可见 lease 初始化缺失的正面积 bounds，将同一 view 放到 App Renderer 下方完成采集启动所需绘制；已有来源尺寸不随被动镜像改变。这一步不取得输入 lease、不聚焦、不将原生页放到工作面上方。`finishPresentationCapturePreparation` 在 ready／failed／stopped／revoked 后结束准备，保留期间发生的真实选择，也不重新挂回已被 Profile 切换或释放移除的旧来源；被动来源隐藏失败时保留在 Renderer 下方，清理异常不截断撤销通知或留下不可重试的 pending capture。原媒体 API 与权限检查保持同一来源。

错误主 frame／文档／Session、foreign opaque handle、已释放 source 或没有合法可见正面积 geometry，拒绝该次 capture。已有 capture 不因最初 issuer lease 隐藏或取消而收掉另一个可见 consumer 的流；最后可见 consumer 撤去才收媒体。媒体失败不作为原页面加载、导航或人工输入的前置条件，失败及显式重试规则见[《Browser 工作面》](../design/behavior/browser-workface.md#browser-工作面-1)中的多位置呈现边界引用。

ACK 是可信 App holder 的媒体报告：ready／stopped 带实际非空 track IDs，failed 独立，stopped 不重启已撤 scope；已 ready 后核同一集合。迟到流可直接报告真实 stopped，不能先假报 ready。物理 ended 需要实际观察，Main 发 revoke、ACK 无异常或移除 DOM 都不等同于已观测停轨；requester 结束后无法读旧 track 时保持 unknown。

媒体与 input 位置事件只经独立 `BROWSER_PRESENTATION_EVENT_CHANNEL` 到原 holder。原 BrowserEvent 与 Store 实体 reducer 保持自己的职责；media revoke 不移除 Tab／Region。listener 只退自身，handler／lease 清理沿原 BVM／dispose，旧 scope 的迟到报告不能复活新许可。

## 可见性、输入与尺寸

一个 stage 的可见性变化只影响该位置；其他合法可见位置的画面和原资源继续存在。stage cleanup 不调用全 Browser 的 null bounds／release。原窗口预算沿实际可见 bindings 集合消费，不另建保活策略；隐藏及目录中的引用不增加 capture、fit、bytes 或 Reader 工作。

明确选择沿原 activation 迁 Native view 到准确有效 lease；被动显示、render、hover 或恢复不凭首项夺焦点，不改变 Agent driving／humanControl、权限或 overlay lease。被动 stage 以 contain 显示同一权威画面，原 viewport 与 Native 几何 owner 保持唯一。后台选择保人工输入的位置与 caret，第一击则消费原类型化准备／提交／取消协议，不能自动重放未知输入。

首次点击、IME、selection、clipboard、原页面正面积及普通恢复，各自需要对应的实际事实。stream 像素、source CDP、`selected` 或输入派发回执不能互相代签；媒体或输入未确认时保留原工作面与服务窗。研究工具的私有 props、mock API 或旧 candidate 不作为当前公共 ABI、已安装 App 或 Native 验收结论。
