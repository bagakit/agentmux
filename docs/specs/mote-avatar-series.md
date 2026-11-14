# Mote 头像系列来源合同

本文是头像系列来源与 Mote 头像读写的公共数据合同：来源目录与声明格式、`space.mote.avatar.*` 方法的输入与回执，以及单次输入的资源边界。行为归[《Mote 头像与主 Mote》](../design/behavior/motes-and-coordination.md#mote-头像与主-mote)，呈现归[同名呈现专题](../design/presentation/motes-and-coordination.md#mote-头像与主-mote)。可执行的类型与严格 codec 是 [mote/avatar-series.ts](../../packages/core/src/mote/avatar-series.ts) 与 [mote/avatar-write.ts](../../packages/core/src/mote/avatar-write.ts)；来源准备归 Desktop [Main](../../apps/desktop/src/main/mote-avatar-series.ts)，已保存的选择经[原生 writer](../../apps/desktop/src/main/mote-avatar-writer.ts) 交给各原 owner。命令参数以所运行版本的 `amux space mote avatar --help` 为准。

## 来源与声明

| 来源 | 位置 | `origin` |
| --- | --- | --- |
| 用户系列 | Host 上的 `~/.agentmux/avatars/<series>/` | `user` |
| 随包系列 | 安装包内的 `resources/avatar-series/` | `builtin` |

两种 `origin` 即使目录名相同也是不同来源。发现只读取目录元数据与声明，不读取每个图稿文件；catalog 如实报告缺失或不可用的根与本地问题。

系列目录中的普通 PNG、JPEG 文件无需声明即可作为条目。可选的 `series.json`（`schema: "agentmux.avatar-series.v1"`）只有 `schema`、`title`、`entries` 三个顶层字段；每个条目为 `{id, title, definition}`，`id` 即 `entryId`。完整示例与作者步骤见[头像系列说明](../../apps/desktop/resources/avatar-series/README.md)。`series.json` 可以混合三种 `definition`：

| `kind` | 字段 | 含义 |
| --- | --- | --- |
| `image` | `file` | 同一目录内的图片文件 |
| `face2d` | `face` | 现有纯数据的[二维脸型 schema](../../packages/core/src/mote/face.ts)（`shape`、`palette`、`eyes`、`brows`、`mouth`、`accessory` 等） |
| `glb` | `file`、可选的 `materials`、`morphs`、`framing` | 自包含的 GLB 模型 |

- `materials` 的每项为 `{index, role}`，绑定原生材质索引；`morphs` 的每项为 `{id, label, meshIndex, targetIndex}`，绑定原生 mesh 与 morph target 索引；`framing.nodeIndex` 选择取景所用的原模型节点。未声明的可选控件不出现。索引必须真实存在于该模型中；名字与 label 只是显示文本。
- `file` 是同一普通目录内的精确相对路径。链接、远程资源、可执行代码与自定义 shader 都不是来源能力。
- 未声明的普通图片仍然可用；格式错误的条目不会隐藏其他图片。
- GLB 的几何、rig 与 morph 由固定版本的 Three.js GLTFLoader 加载，材质控件基于标准 PBR／Toon 材质。来源 owner 核对真实容器、引用与声明的机器索引；渲染仍可能报告本地不支持的模型，来源准备从不声称已经得到渲染像素。

## 发现与准备

`space.mote.avatar.list` 不带参数，返回 `{roots, series, issues}`：

- root 为 `{origin, path, state}`，`state` 取 `available`／`missing`／`unavailable`。
- series 为 `{origin, seriesId, title, entries}`，entry 为 `{entryId, title, definition}`；未声明的 PNG／JPEG 以文件名作为 `entryId`。
- issue 为 `{code, message, recovery}`，可带一个准确的 `source`。同一集合内同类的重复错误合并为一条，带准确的正整数 `count` 与至多三个真实示例；合并后的条目在 message 中指明声明或目录，不虚构条目定位。所有有效条目仍留在 catalog 中。

`space.mote.avatar.preview` 的输入为 `{source: {origin, seriesId, entryId}}`，可选 `expectedRevision: "sha256:<64 hex>"` 要求一个已准备过的准确版本。结果为 `{source, definition, payload, issues}`：

- `source` 保留定位符，并带 `revision`，由规范化的 definition 与所选文件的实际字节导出；与 `expectedRevision` 不同时明确报告冲突。
- `payload`：图片为原生解码器生成的有界 PNG 预览；二维脸为原 face；GLB 为校验后的原字节 `dataBase64`。SDK 的严格结果解码器保留所请求的定位符与版本。
- 预览只返回所选来源的声明摘要与 issues，不附带无关的同级错误。

这些读取方法与可信 Desktop IPC、默认 Host 转发路径共用同一个 Main 业务 owner。发现与预览不创建 Mote、AgentSession 或 Run，也不发布外观。

## 创建与打开用户系列

`space.mote.avatar.series.create` 的输入为 `{seriesId, title}`，在 Host 用户头像根下创建一个此前不存在的目录，内含 `starter.png`、`series.json`（一个图片条目与一个原创脸型预设）与 `README.md`。`starter.png` 在改动用户目录之前，先从随包的 low-poly 猫头鹰读取并校验。结果为 `{seriesId, title, path, files, state: "created"}`，`files` 列出准确的相对文件名。

- 已存在的目录、文件或链接使这次创建被拒绝，不替换其内容。
- 之后的写入失败保留已经新建的部分内容；没有自动重试、清理、头像发布或 Agent 操作。
- 没有完整回复时，读 catalog 观察当前来源；目录存在不能确认一次丢失的创建回执。

`space.mote.avatar.series.reveal` 的输入为 `{seriesId}`，核对用户根下该普通目录后调用 Host 的 OS 文件夹端口。结果 `{seriesId, path, outcome: "requested"}` 只确认请求已发出，不确认窗口已打开、可见或获得焦点。端口缺失或 OS 失败只影响这一个动作，已创建的文件与读取方法照常可用。

创建与打开使用与读取方法相同的类型化来源／控制 owner 和可信 Desktop IPC，都不接受任意根目录或路径。

## 读取与保存一个 Mote 的头像

目标为 `{workspaceId, topicId, objectKey}`，可从 `app.snapshot` 的 `motes` 来源取得：`objectKey` 取同一条目的 `spaceId`；`spaceId` 为 `null` 时没有可确认的目录身份，不能猜测。

`space.mote.avatar.read` 的输入为 `{target, operationId?}`。结果包含当前 `choice`、不透明的 `revision`、issues，以及可用时已保存的有界 PNG。系列选择保留来源定位符与内容版本、definition、编辑参数和原图片引用；其他方式创作的选择（包括本编辑器无法解释的记录）照常可读。

默认 Node Host 不连接 Desktop 也能读取：它按本地 Mote 配置与目录身份读取已保存的不可变 PNG，保留同一个 choice revision 与可选的保存回执。PNG 缺失或损坏是单独的观察；系列来源不可用不会使已保存的 PNG 失效。Node 不生成主题、矢量或 3D 外观：需要这种能力的选择报告 `MOTE_AVATAR_SOURCE_UNAVAILABLE`，本地资源未确认时报告 `MOTE_AVATAR_SOURCE_UNCONFIRMED`。完整的读取、保存、编辑器与系列 owner 在 Desktop。头像读取失败不妨碍消息正文的投递。

`space.mote.avatar.save` 的输入为 `{target, operationId, beforeRevision, source, definition, parameters, pngDataUrl}`：

- `beforeRevision` 取自对同一目标的 read，`source` 是准确准备过的来源版本，`operationId` 是这次请求的 UUID。
- `pngDataUrl` 是调用方所选的 256×256 PNG 帧，由 Main 校验并经对象图片 owner 保存。服务不独立渲染，也不认证这些像素描绘了所给的 GLB 参数。
- 配置 owner 发布选择并持有每个对象的发布修订，因此 A→B→A 的编辑仍与较早的基线冲突；对其他对象的编辑照常合并。

结果为 `{state, operation?, issue?, current}`：

| `state` | 含义 |
| --- | --- |
| `saved` | 配置已发布并得到磁盘持久确认 |
| `refused` | 这次请求被拒绝；草稿与当前外观保持可用 |
| `unknown` | 发布或确认无法核实；保留完整请求与操作 |

来源准备、PNG 生成、当前选择的观察与已确认的发布是不同事实。

操作身份：

- 以 `{target, operationId}` 读取可检查一次结果不确定的保存；以同一 UUID 原样重发同一份冻结请求即为重试，换了正文的同一 UUID 被拒绝。
- 操作 journal 记录在该 Mote 目录内，只记录这次请求的历史，不是另一份当前选择的存储。
- 发布已经不确定或已被记录时，重试不会再次发布。历史上已确认的回执可以与之后的 `current.choice` 并存，消费者以之后的选择为准。

系列模组缺失或改变时，已保存的 PNG 与参数保持不变。read 的可选 `source.state` 为 `available`、`unavailable` 或 `changed`；重新打开编辑器需要准确的已保存来源版本。发现、读取与保存都不改变 Mote 的身份、工作区、SOUL、Session、Run、Tab 或 Region。

## 单次输入的资源边界

| 对象 | 上限 |
| --- | --- |
| 图片输入 | 8 MiB、单边 4096 像素、解码后 16M 像素；预览 2 MiB（[object-avatars.ts](../../apps/host/src/object-avatars.ts)） |
| GLB 模型 | 32 MiB，保护解析与渲染内存，base64 后仍能放进 64 MiB 的 RPC 帧 |
| GLB 内嵌图片 | 每张沿用图片输入上限；内嵌图片的解码像素合计不超过 16M，纹理槽按各自引用的图片像素另行合计，也不超过 16M（同一图片被多个槽引用时重复计入） |
| 保存的 PNG | base64 之前 512 KiB |
| 单条操作记录 | 读取上限 32 MiB，与集合数量或历史操作数量无关 |

这些是单次来源准备的上限，不是 catalog 的累计上限。发现不按条目总数或固定扫描时限截断有效集合。
