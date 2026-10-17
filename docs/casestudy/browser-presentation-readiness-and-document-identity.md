# 原页面可读，Browser 呈现仍黑屏

## 定性

P0，范围是原 Browser 的呈现可用性：页面仍能观察和采图，显示入口却被内部资格校验阻断；本轮用户再次 Retry 仍得到同一拒绝，尚无已验证的带内画面恢复动作。该等级不表示 Agent、Run、网站或原页面已经损坏。

本案例记录两组已复现的机制：资源加载进度与可变 wrapper 不能代替原文档身份；原生 wrapper 的历史 `detached` 标志也可能不再表示当前文档失效。旧事故命中的准确条件未知，本轮原生反例也不证明用户现场发生过 Renderer crash。

## 用户可见症状

> 「我随便找了个 agent 执行打开页面, 结果这样」

旧截图显示 `Page connection needs attention`／`Retry connection`，展开为 `browser:registerPresentation` 的 `Untrusted Browser presentation document`。同一 Browser 的 `pageInfo`、`snapshotText` 成功。更新后重新展示原 Browser 曾恢复可见，任务没有重放；旧错误未保存具体拒绝条件，恢复可见不能归因某项修复。

### 复发：Retry 仍被 frame-detached 拒绝

用户再次反馈多个 Browser 黑屏，原始错误已具体到 `Untrusted Browser presentation document (frame-detached)`；用户再次 Retry，仍得到同错。同一原 Browser 的 `pageInfo`、`snapshot`、`captureScreenshot` 正常。运行包 `954c` 与当时 Main 的注册路径逐字相同，已有修复尚未安装不足以解释本次复发。

这两次现场共有呈现登记失败的症状，但因果范围不同：旧现场的 predicate 未知；本轮明确被 `frame.detached` 拒绝，真实原生实验另证实了该属性可以滞留。用户现场是否经历同一种 crash／reload 触发仍未知。

## 影响面

| 能力 | 实际范围 |
| --- | --- |
| STOPS：当前工作面连接 Browser 呈现 | 登记请求被拒，实时画面不可用；本轮显式 Retry 同错。 |
| KEEPS WORKING：原 Browser 后端 | 本轮同一对象的 `pageInfo`、`snapshot` 与 `captureScreenshot` 成功；它们不证明 App 中的画面可见。 |
| KEEPS WORKING：Agent／Runtime 及原页面身份 | 呈现校验不执行停止 Run、删除 Session、重新创建页面或重放业务。失败没有给这些动作授权；本案例也未据此证明所有 Agent 操作正常。 |
| 未确认：其他 Browser 宿主 | 原生子窗口、认证 frame 与进程统计还使用 `detached`；本轮未验证它们具有相同故障。 |

以下不受本次修复改变：原页面加载与导航 owner、Profile／Session、业务 operation、Core／公开 Browser CLI 合同。[Main 登记入口](../../apps/desktop/src/main/ipc.ts)只取得原请求者身份并调用呈现 owner；[Stage](../../apps/desktop/src/renderer/src/components/BrowserPresentationStage.tsx)的连接失败与显式重试不创建另一 Browser。源码层面的不变与现场已观察到的后端可用分别成立，不能相互代签。

## 止血措施

保留原 Browser，沿原 `pageInfo`、`snapshot` 或 `captureScreenshot` 继续观察页面内容。它们是当前可用路径，不等同于实时呈现恢复。

连接 Retry 仍报 `frame-detached` 时，目前没有已验证能在原工作面恢复实时画面的带内动作。保留错误与原工作面，不刷新网页来碰运气、不停止健康 Agent，也不重放打开页面的任务。旧现场更新后恢复可见的经验，不能作为本轮有效恢复方案。

## 引入时间线

以下来自原 owner 的 Git 历史；只保留 SHA 与 message，不记录绝对时间。定位使用：

```sh
git log -S 'frame.detached' --format='%h %s' -- apps/desktop/src/main/browser-view-manager.ts
git log -L '/private requirePresentationDocument/,/^  private attachPresentationRequester/:apps/desktop/src/main/browser-view-manager.ts' --format='%h %s'
git log --follow --format='%h %s' -- apps/desktop/src/main/browser-view-manager.ts
```

| SHA | Message |
| --- | --- |
| `7eab25ef69` | `feat(browser): expose presentation leases on the existing resource owner` |
| `1762d9ab02` | `fix(desktop): retain exact window resources through owner teardown` |
| `7c17ca1f73` | `fix(browser): explain the native presentation rejection` |
| `d20b285758` | `fix(browser): bind presentation to the original native document` |

`7eab25ef69` 引入登记与持续租约的两处 `detached` 判据，同时要求主 frame 加载完成。随后改过这段的三个提交，分别处理销毁后的原 owner 访问、拒绝原因可见性、加载与跨异步文档身份；均保留了 `detached` 判据。`git log -L` 支持这份同段改动清单，其他位置的同名字面量不被算作呈现资格的引入。

`git log --follow --format='%h %s' -- docs/casestudy/browser-presentation-readiness-and-document-identity.md` 还定位到原案例提交 `2dcdef9410`，message 为 `docs(browser): explain presentation readiness and document identity`；它记录了旧机制与未知边界，不能证明已覆盖之后发现的 crash／reload 形态。

## 根因分析

**直接原因分开确认。** 旧实现把 `isLoadingMainFrame()` 作为资格，并在异步准备之后才取得原请求 frame；[Stage](../../apps/desktop/src/renderer/src/components/BrowserPresentationStage.tsx)还等待整窗 `load`。原生实验分别证实：合法原文档仍加载无关资源时会被拒绝；导航后原 wrapper 可保持对象相等而更新属性，旧请求可能被当作新文档请求。

本轮的已证机制是 stock Electron `43.7.7` 中真实私有 Renderer crash 后沿同一 WebContents reload：

| 原生观察 | 支持的结论 |
| --- | --- |
| crash 时 `isDestroyed()` 为 true，token／URL 访问失败 | 原生死亡状态仍能与活体区分。 |
| reload 后 senderFrame、当前 mainFrame、保留 wrapper 相等；`isDestroyed()` 为 false，新 `frameToken`，`detached` 仍为 true | 历史 detached 值不能单独否定当前文档活性；wrapper 相等也不能保存旧代次。 |
| 恢复文档发送真实 sandbox preload IPC，frame 与 WebContents 执行均成功 | 该组合不是测试手改 getter 或伪造 frame；它仍不代签完整生产登记与画面恢复。 |

[正式 v43.7.8 的原生实现](https://github.com/electron/electron/blob/v43.7.8/shell/browser/api/electron_api_web_frame_main.cc#L177)中，`MarkRenderFrameDisposed` 置 detached／disposed，`UpdateRenderFrameHost` 换 token 后只清 disposed；`IsDestroyed` 返回 disposed。这一已核正式补丁不包含 detached reset，不能靠升级到它宣称修复。

**更深的判断错误**是把加载进度、wrapper 引用和历史标记当作当前资格的充分代理，没有分别确认活性、准确主体与原文档代次。[RED-LINES](../../RED-LINES.md#写拦截前回答四个问题)已经要求流程失败不能拿走健康能力；规则没有约束住这里，是因为验证覆盖了加载和导航竞态，却没有覆盖真实 crash 后复用 wrapper 的原生状态组合。

既有原生与 mounted 测试可以正确验证各自场景，仍会遗漏这一组合。补上真实生命周期反例才会让错误代理暴露；增加等待、重复 Retry 或再抄一份规则不能补齐它。

## 改进措施

1. **保留已完成的加载／原文档身份修正。** IPC 在第一个 `await` 前冻结 `{processId, frameToken}`，原 `PresentationDocument` 共用该身份；删除加载门槛，提交时清理真正更替的旧文档。
   - 是否足够 root：覆盖 Main 登记、持续资格与 Stage 挂载三处加载依赖，并守住原 IPC 的跨异步身份；没有覆盖本轮 sticky detached。
   - 能否彻底避免：能阻止已复现的加载误拒与旧请求借新文档；不能据此宣布旧现场黑屏根因已修。
   - 是否降低系统熵：删除加载等待，身份留在原 owner；没有新 Store、轮询或第二恢复协议。
2. **两处呈现资格直接消费当前原生活性。** [BrowserViewManager](../../apps/desktop/src/main/browser-view-manager.ts)的 `requirePresentationDocument` 与 `isPresentationDocumentCurrent` 用 `isDestroyed()` 替换历史 `detached` 判据，保留准确 sender／主 frame／顶层、原 token pair、Session／URL、旧租约失效及输入权限。
   - 是否足够 root：覆盖本次同一呈现 owner 的两处误判入口；限定扫描发现的其他 14 处 native-frame `detached` 使用未改，未将它们全部认作已证缺陷。
   - 能否彻底避免：针对已复现的历史标记误拒修正依据；完整生产消费者已通过下述验证；安装后的现场恢复仍须单独确认。
   - 是否降低系统熵：直接替换两个谓词，无版本例外、fallback、配置或额外状态；无效补丁升级与更大版本迁移未被加入本次修复。
3. **把恢复后的真实当前文档接到原消费者回归。** 原生反例与[资源 owner 测试](../../apps/desktop/test/browser-presentation-resource.test.ts)分别守机制与生产行为，登记成功后继续检查 lease、grant／ACK 及原输入选择。
   - 是否足够 root：为上述两处资格谓词补同一生命周期形态；不是全 Electron／全 Browser 的恢复覆盖声明。
   - 能否彻底避免：测试只能更早发现复发，不能阻止上游产生其他生命周期缺陷；本轮实际生产变异均命中 owning AssertionRED，恢复原实现后通过。
   - 是否降低系统熵：增加有承重断言的窄回归，不改变运行时状态与原恢复路径，不建立另一套测试 owner。

长期要求继续只归[Browser 工作面合同](../design/behavior/browser-workface.md#browser-工作面-1)与[呈现媒体资源合同](../specs/browser-presentation-resource-contract.md)，案例解释原因，不重复制定授权规则。

## 验证

- 加载／原文档身份修正：历史生产 sandbox preload → 完整 IPC → Browser manager 已验证未完成子资源时登记、同／不同 URL 更替、延迟旧请求得到 `document-changed` 且新租约继续可用。三个原生变异分别恢复加载门槛、删除身份比较、将快照移到等待之后，均得到对应 AssertionRED；另两个 owner 变异守住提交前与提交时清理。相关 79 项测试与恢复原实现的验证通过，结论只属于原候选。[身份与提交回归](../../apps/desktop/test/browser-presentation-resource.test.ts)及[Stage 回归](../../apps/desktop/test/browser-presentation-registration-recovery.test.tsx)保留这些行为入口。
- 当前活性修正：本轮两个文件共 81 项 focused 测试通过，其中资源 owner 57 项、Stage 24 项。`apps/desktop/test/browser-presentation-resource.test.ts:420` 的恢复 case 使用已证原生状态形态，覆盖旧 lease／请求拒绝、新 lease 更新、capture grant／ready ACK、保焦点输入选择及原 source／Session 保留；`:444` 的实际 destroyed case 保护当前有效 lease。它们使用测试 native 对象，不能代替真实 Electron 生产链。
- 本轮完整生产链已通过：真实 crash／同 WebContents reload 后，当前 senderFrame 仍为 `detached=true`、`isDestroyed=false`，经 production sandbox preload → 完整 `registerIpc` → BVM 完成 register／update、实际 live video track、以真实非空 track IDs 发送 ready ACK 及输入位置 select。原 Browser source、Session、navigation 保持；真实 foreign WebContents、实际已死亡子 frame、普通导航后的旧 lease、跨准备等待的旧文档 pair 均被拒绝。承重入口为 `apps/desktop/src/main/ipc.ts:2207`、`browser-view-manager.ts:850` 与 `:874`。
- 两个私有编译变异分别恢复旧判据：登记入口得到 `frame-detached`，持续资格在真实 update 得到 `Unknown Browser presentation lease`，各命中对应 owning AssertionRED。baseline 与恢复原实现后均通过四组真实 case，恢复 bundle 与 baseline 字节相同；四个原进程均确认退出，无超时或残留，私有数据已清理。未改共享生产源码来运行变异。

## 遗留

- **PARTIAL：现场归因。** 旧现场准确拒绝条件未知；本轮明确是 `frame-detached` 拒绝，但用户 requester 是否发生同类 crash 未证。原生反例证明机制，不回填现场历史。
- **PARTIAL：显示与安装。** 本轮已证完整生产链、实际 live track 与 ACK；它们仍不代签 OS 整窗可见、系统／物理输入、物理 track ended 或已安装客户端现场恢复。
- **明确未修的同类使用。** 限定到本次读取的文件，BVM／IPC 的进程归属有 3 处、原生 popup 有 5 处、WebAuthn access／accounts 有 6 处 native-frame `detached` 使用；[进程 owner](../../apps/desktop/src/main/browser-view-manager.ts)、[IPC](../../apps/desktop/src/main/ipc.ts)、[popup](../../apps/desktop/src/main/browser-popup-windows.ts)、[WebAuthn access](../../apps/desktop/src/main/browser-webauthn-access.ts)与[accounts](../../apps/desktop/src/main/browser-webauthn-accounts.ts)各归原职责。这 14 处不是全仓总数；[通用原生编辑菜单](../../apps/desktop/src/main/text-edit-context-menu.ts)另定位到 4 处，本轮未评审。本案未证明这些入口触发相同误拒，故没有机械全删或宣称全 Browser 已修。
