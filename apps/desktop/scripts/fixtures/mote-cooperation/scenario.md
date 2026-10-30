# Mote 可见协作：完整 Renderer 采图

从 Feature 工作树根目录运行：

```sh
node apps/desktop/scripts/fixtures/mote-cooperation/capture.mjs
```

采集消费行为 SSOT 的[主 Agent 与内部工作](../../../../../docs/design/behavior/motes-and-coordination.md#主-agent-与内部工作)和呈现 SSOT 的[主交流面](../../../../../docs/design/presentation/motes-and-coordination.md#正向目标与界面层级)。精确标题及后续变更以 owning 文档为准；本文只说明场景和证据边界。

入口复用现有 `mote-closed-tab-target` 私有 API/完整 App bootstrap，保产品 App、Store、浮窗、MoteSpaceFrame、WorkspaceWorkbench、SessionPane、Composer、共享通知及全部产品 CSS。依赖解析只指向实际源码，不替换产品组件。读取路由固定为 `local`，原记录来源为不同的 `host-original`：DOM 原记录引用必须保 source Host，原观察 inspection 必须走准确 route Host，不能互相代换。

Core 原 conversation projector 和 read-page codec 消费有限的原生页面和已资格化平台通知样本；通知样本来自共享通知作者的原 producer fixture。

驱动使用 Electron 原生鼠标事件操作实际可见且命中的按钮，记录可信事件。每个完整截图同时记录原草稿、全部 Region/Session 绑定、当前原 Run、准确导航及 API 调用。展开和导航均断言无 submit/write/paste/respond/launch/stop；unknown 只能减少当下已观察 Session，不能替换原 Run。两个 Mote 共用 Scratch，团队列表必须仅有当前 Mote 的两位成员。

| 完整图 | 实际产品场景 |
| --- | --- |
| `01-main-conversation-wide-dark` | 主交流、原 Composer 草稿、折叠回流；原观察详情读取为零 |
| `01b-original-decision-readable-wide-dark` | 展开回流，读取准确原 Host/member/observation 后显示原决定 |
| `01c-complete-result-references-wide-dark` | 展开同一事件的完整原结果引用 |
| `02-team-expanded-wide-dark` | 原团队展开，排除另一 Mote，准确原待答请求可达 |
| `03-member-original-request-wide-dark` | 进入原成员，挂载原 typed request，不提交答复 |
| `04-returned-main-wide-dark` | 回同一主 Session，保主/成员及无关讨论草稿 |
| `05-original-space-main-wide-dark` | 沿真实 Open in Space 进入同一完整工作面 |
| `06-original-space-team-wide-dark` | 完整 Space 的同一团队投影 |
| `07-unknown-original-team-retained` | 资料读取未确认且一位成员观察缺失，原位置与草稿保留 |
| `08-long-name-space-narrow-dark` | 窄面、长 Mote/成员名称的完整工作面 |
| `09-long-name-main-narrow-light` | 窄面浅色浮窗主交流 |
| `10-long-name-team-narrow-light` | 窄面浅色团队展开 |

结果写入工作树已有 symlink `.bagakit/mote-visible-cooperation/desktop-ui/capture-<id>/`，包含 `receipt.json`、`renderer-result.json`、完整 PNG、编译及源码哈希和 `review.md`。成功采集后才更新 `latest.json`。源码在采集期间变化会使回执失败，不能签收另一个候选。进程和私有 profile 仅清理本轮明确所属的资源。

采集一律标记 `captureOnly: true`、`aestheticReview: not-performed`。独立 reviewer 必须实际打开完整图，判断交流主次、团队密度、身份与状态、请求/回流可读性，问题修正后复拍相同场景。这里没有审美分数、像素门或截图即通过的判断。

所有 Session、Run、空间、原生记录和通知均为明确合成的 API 来源，不连接用户 App 或健康 Run，不启动 CLI/模型，不证明 Provider 实际采用、真实远端、持久恢复、打包或安装。那些证据由各 owning 任务及最终联合交付承担。
