# Note Markdown 与元数据

本文描述 Note 当前文件格式及其 owner。产品约束归 [知识工作流](../design/behavior/knowledge-workflows.md#recallnotebook-与块知识)，
公共调用入口归 [公共能力来源](public-capabilities.md)。语法实现由共享 [Markdown codec](../../packages/client-ui/src/note/note-markdown.ts)
及 [Core 身份头](../../packages/core/src/note-format.ts) 持有。

文件格式与后续演进须遵守知识工作流中「文件自足是 Note 的基础原则」。本文记录当前格式与原 owner 的机制。`notebook.scan` 可只读重建指定物理目录中的正文索引；产品、界面与安装的完成状态仍以对应 Feature 的验收为准。

## 正文和身份

`.note.md` 是唯一持久正文，编辑树只在内存中存在。普通无身份头的 `.md` 沿普通 Markdown 文件处理。
身份头保存稳定 Note ID 和可读页名 `title`；路径和显示名称不代替身份。`title` 是持久页名事实，Notebook 目录中的标题是投影。

```md
---
schema: agentmux.note.md.v1
note-id: "original-note-id"
title: "研究记录"
---

## 研究结论 ^heading1

保留原始观察。 ^paragraph1

参见 [[相关发现]]<!--amux-ref:occurrence1;query=%E7%9B%B8%E5%85%B3%E5%8F%91%E7%8E%B0;target=note:otherNote--> ^paragraph2
```

段落／标题支持尾部 `^blockID`，也支持紧随原块的独立锚点行；canonical serializer 使用独立行。
代码、引用容器和分隔线的锚点位于该块后的独立行。嵌套内容的锚点仍处于原容器内。
列表项有自己的 `<!--amux-item:itemID-->`，与其首段落的 block ID 分别保留；
空段落用 `<!--amux-empty:blockID-->`。ID 字段采用 URI component 编码、解码一次，comment 字段的连字符也编码，避免 `--`。

已有 ID 必须保留；普通新增段落可省略锚点。读取、挂载或观察不分配持久身份，显式保存经原 writer 为缺失块分配 ID。
未锚定块仍可读，`unanchoredBlockCount` 使图观察保持 partial；不能借父块身份伪造 source endpoint 或把未确认标题当成唯一目标。
重复身份不自动改写或选首；同文件重复块／引用 ID 按原 schema 报解析问题，跨资源重复 Note ID 在图中保持歧义。
引用块留在原文件，只有显式提取独立 Note 才拆文档。

## 文件标题与目录投影

新建原文件同时保存初始标题。已有无 `title` 的文件仍可读；扫描返回未知标题，不从日期文件名推断日记语义。
普通保存显式提供的文件标题优先。草稿省略标题时，先保留准确当前文件中的标题；只有确认原文件也缺标题或明确新建时，
才补准确已登记资源的已知目录标题。读取失败或身份不符不能把旧目录标题当作当前文件事实。

原 `notebook.apply` 的 `rename-page` 和侧栏改名共用文件标题 owner，只改 YAML，保原 Note ID、正文字符、锚点、链接、
BOM 和换行，不因改名补块 ID、改写正文排版或将块作者改为改名者。它复用原历史 journal 和可重入写入 lease；
显式路径的 Core Store 同样串行执行。原操作检查先于新的目录 revision 判定：标题 B 已写成而目录发布失败，
若文件后来变成 C，重试旧 B 只观察并投影当前 C，不再写回 B。未确认的原操作不凭当前标题或摘要追认完成。

普通 `file.write` 后尽力刷新同一目录投影。`noteTitleProjection` 独立报告已投影、未登记或未确认，不否定已写成正文。
投影可能观察到更晚 revision，但必须属于同一准确 Note 和资源。`notebook.inspect --operation-id` 的 `titleOperation`
分别保原历史操作、当前文件和目录投影事实。无本地文件 owner 的 Host 经既有转发到真实 owner；本地 owner 已存在时，
观察失败保原结果和恢复路径，不改由另一 writer 执行。

单篇原文件移动确认后，`relocate` 在原目录事务中同时重映射该准确 Note／旧资源的作者和历史查询地址，
不加载或改写历史正文；事件 ID、顺序、原请求指纹和 `originalResource` 均保留。元数据目标已有同 Note 记录时，
整个目录／元数据事务保留原状并明确冲突，原文件移动及其待对账意图仍由原 Files／恢复入口持有。

## 链接和引用

原始 `[[页面]]`、`[[页面 #标题]]` 和 `[[页面 #^blockID]]` 可直接写入正文。
原 writer 只把唯一且已确认的目标绑定为稳定 ID。代码、反斜线转义和未完成 token 保持字面文本。
已有绑定不会因改名或同名页面重新解析。已绑定链接在原编辑器中也是可直接选择、输入和撤销的普通 wiki 文本；
普通点击定位输入，Ctrl／⌘-click 打开准确目标。编辑 query 撤销该 occurrence 的旧 target，并更换查询代次；
迟到的旧查询不能重新附着目标，删除语法保留普通文字和原块。

| 形式 | 表达 |
| --- | --- |
| `[[query]]<!--amux-ref:R;query=encoded-query;target=note:noteID-->` | 已绑定页面与 occurrence |
| `[[query]]<!--amux-ref:R;query=encoded-query;target=note:noteID#blockID-->` | 已绑定块与 occurrence |
| `[[query]]<!--amux-ref:R-->` | 有稳定 occurrence 的未绑定查询 |
| `::note-ref{#sourceBlock ref="R" target="note:noteID#blockID"}` | 结构化块引用 |
| `::note-embed{#sourceBlock ref="R" target="note:noteID#blockID"}` | 在原位置嵌入目标块 |

这些标记保存字段，不包含隐藏的 JSON／base64 内容树。粗体、斜体、删除线、代码、列表、引用和换行使用 Markdown；
下划线、非标准链接属性、列表类型等原 schema 字段使用有限 HTML／comment 扩展。
当前编辑 schema 不支持的表格、图片、task list 或未知结构保持原 Source 并明确解析问题，不能静默压平或删除。

绑定标记的 `query` 是选定目标时的查询快照，使用上述 comment 字段编码。普通文件工具只改可见 query 后，
parser 发现快照不符便将该 occurrence 读成未绑定，再由原 writer 按新 query 确认；旧目标 ID 不能锁住新文字。
未改 query 的目标改名仍保准确绑定。原 `[label](note:ID#block)<!--amux-ref:R-->` 可读取，下一次规范保存统一写 wiki 形式；
显式旧 JSON 转换将原 atom 的文字展开为可编辑内容，必要的 wiki 字面转义保全任意原 label、target 和 occurrence。
两者都消费同一 schema／codec，不保另一条可写正文格式。

## 元数据与公共消费

原 [NotebookStore](../../packages/core/src/notebook-store.ts) 的 `notebooks.sqlite` 持有目录、关注、操作指纹／轨迹、块归因与不可变正文历史，
不保存第二份可写当前正文。Canvas 布局仍由原 client owner 持有。普通目录读取不扫描全部作者历史；graph／resolve 从原文件派生关系。

`file.read/write/create` 复用原 Files 的准确资源与 revision CAS；`notebook.content`／`inspect --content` 观察同一已保存正文。
`noteProvenance` 绑定 Note ID、完整 resource、正文 revision 和稳定 block ID。可信 actor 来自原调用权限边界，不能从正文声明作者。
创建者与最近编辑者分别记录，空值保持未知；外部编辑导致 revision 失配时保留已知创建者、最近作者未确认。

正文写成而元数据未确认时，回执仍为 `written`，并带 `noteAttribution`／`noteProvenance` 的未确认状态。
消费者采用 canonical content／revision 并保护后来输入，读取同一对象对账，不为补作者记账重复写正文。
`unknown` 写入保留原尝试 bytes／revision，确认原结果后才决定下一次保存。

`notebook graph` 提供页面层级、incoming／outgoing 与准确 source／target；原始文本 occurrence 的位置是当前保存修订内的
block inline PM UTF16 offset，不是 Markdown 字节位置。它不是跨文件原子快照；未读、歧义和未锚定状态不能被空边列表代签。
`notebook apply` 的 `follow/unfollow` 只改变可信调用者自己的持久关注，不表示在线或通知授权。
完整 Agent 操作指引由 [CLI Note guide](../../packages/core/src/agentmux-cli-note-guide.ts) 持有，
经 `amux --skill` 的模块目录发现，再由 `amux notebook --skill`／Notebook help 读取。

## 仅从原 Markdown 重建索引

`amux notebook scan --workspace ID --path DIR [--query TEXT]` 经原 Files 读取指定物理目录，不要求原 Notebook 数据库。
结果包含每个准确文件的 Note ID、可用标题、revision、大纲、显式前向关系和全文命中；反链可由同一前向关系派生。
同名页保候选，重复 Note ID 保不同资源行，不选首或合并。无锚点的新正文也可命中，`blockId:null` 明确它没有稳定跳转目标；
读取不分配身份。未读／无效文件、缺标题、未锚定内容和预算耗尽保 partial／unknown，不能用已见单个候选确认全范围唯一。

这是有明确范围的只读观察，不注册页面、不重写正文或替换原目录，也不从缺失证据重造 Notebook 收纳、可信作者、关注与历史。
普通 ignored 文件包括在内，符号链接报告后不跟随。默认候选文件和目录各 200、总接受原文 4 MiB；可显式提高，
各上限 20000／20000／64 MiB。全文 `limit` 默认 30、上限 1000；`total` 是已观察范围内匹配的文本块数。
取消只结束本读者并停止后续原文件读取；已经发出的原目录列举仍由 Files 持有。单次列举当前会返回全部名字，
不能将扫描预算称作底层目录 IO 或分配的硬上限。它不是跨文件原子快照，索引也不是新的正文或关系权威。

## 持久正文历史

[原 Note writer](../../apps/desktop/src/main/note-file-writer.ts) 沿既有 NotesStorage 锁和 Files revision CAS 保存正文，
在同一原元数据 owner 中准备历史事件并分别确认正文与历史结果。当前 Markdown 是唯一当前正文；历史保存不可变的前后内容快照，
不是可独立写入的另一份当前文档，也不是从当前 Markdown 可重建的缓存。

[历史模型](../../packages/core/src/note-history.ts) 的 `eventId` 区分每次编辑；`revision` 仍是正文摘要。
相同字节再次写入、A → B → A 不能复用旧事件或把旧作者当成本次操作者。事件保留原 Note、准确资源、前后 revision、
可确认的 parent、可信 actor、时间及操作类型。`resource` 随已确认的目录搬迁更新查询归属，`originalResource` 保原事件地址。
连续同一操作者的活动可归为同一 `batchId`，聚合不删除底层事件。

原 SQLite 数据库以压缩、按摘要去重的内容保存历史，以事件序列索引准确 Note／资源；时间线查询只读取请求窗口的元数据。
历史内容与原目录、关注和归因一同备份、校验和搬迁。已确认历史 schema 的表缺失或内容损坏是未确认，不能重建空表冒充没有历史；
原目录和健康正文读写仍可用。历史准备或结果记账失败不否定已写成的正文，回执分别返回正文结果与 `noteHistory`。
`prepared`／`unconfirmed` 保原事件地址，不能凭匹配字节追认本次提交或自动重写正文。

`file.history`／`amux file history` 读取准确 `file.read` resource 和 Note ID 的历史。默认新到旧返回元数据，
`before` 以最旧返回项的 `sequence` 续页；`batches` 只聚合本次窗口成员，不保证是完整批次。
只有选择准确 `eventId` 并启用 `includeContent`／`--content` 才读取前后内容供比较。内容对超出原 RPC 帧容量时，
仅本次内容读取明确不可用，同一事件的元数据及普通正文读写继续可用，不截断持久历史或改变公共帧上限。
可信作者来自原写入调用边界，查询不能自报 actor。历史不可用或未确认不能返回“已确认空历史”。
该只读入口不执行恢复或撤销；协同产品要求及其交付边界见[人和 Agent 协同编辑](../design/behavior/knowledge-workflows.md#note-中-agent-与人的协同编辑)。

## 精确基线的并发提交

普通 `file.write` 保持原 revision CAS。Note 可同时传 `baseContent` 与 `operationId`；CLI 为
`amux file write ... --base FILE --operation-id ID < proposed.md`。基线必须是原读取的完整 UTF-8 正文，
摘要与 `expectedRevision` 一致，不能用当前文件或编辑后的草稿替代。原 Host 在既有 NotesStorage 锁内确认操作与当前文件，
合并成功后仍由原 Files CAS 防止外部写入竞争，不增加另一条保存队列。

两向差异由 [JsDiff 的 Myers 实现](https://github.com/kpdecker/jsdiff) 计算；
[node-diff3](https://github.com/bhousel/node-diff3) 持有三向区域与重叠判定，仓库 patch 提供两向 differ 注入，并以等价迭代避免大区域越过 JavaScript 调用参数栈限。
精确行缓冲保留换行和空白，不做模糊补丁。Host 的 CPU 合并经 Core Worker 执行，避免阻塞主事件循环；
一侧删除／替换基线稳定块 ID、另一侧修改该原块内容或稳定父级时保持身份冲突，不能把旧块的修改移植给替换后的块。

成功的增强提交返回 canonical `content`、revision 与同一历史事件 ID。操作指纹绑定原资源、Note、基线、原提交字节和可信 actor；
同 ID 的已提交重试只读回原回执，不能再覆盖后来正文。已确认未应用的操作不再执行；`prepared`／`unconfirmed` 不凭正文匹配猜完成。
增强提交必须先确认持久准备；普通 CAS 在历史记账失败时仍沿原可用能力保存。

重叠、身份或结构冲突保留基线／当前／提议三份正文。三份正文连同真实 RPC request ID 超出原帧容量时，
回执仍保已确认的 conflict、revision、历史状态和事件 ID，以 `noteConflictUnavailable` 明确本次正文传输不可用；
可分开读取同一原文件及可用的选定历史事件。当前正文读取失败是 `NOTE_BASELINE_UNAVAILABLE`，不是已确认内容冲突；
合并 Worker 不可用也保未知、原文件和输入，不盲写或换 ID 自动重放。

## 存量转换与恢复

原 `.note.json` 和 JSON 目录只作显式一次转换输入。原 NotesStorage journal 配合
[Host 转换适配器](../../apps/desktop/src/main/note-legacy-conversion.ts) 校验原身份、全部语义与 source／target hashes，
先保全原字节备份并确认目标正文、元数据、目录和空间资源，再清理旧活动文件。
不覆盖不同目标，不自动合并重复身份；中断沿原 operation ID 继续，不另造 Note。

`resourceChanges` 提供准确 from／to 以及 `conversion.sourceRevision/targetRevision`，Desktop／Mobile 以此续接原资源。
原 Tab／Region／块、dirty draft 和未知保存尝试都保留；转换旧草稿时保全原文与原 revision，不把未知尝试换新 revision 自动重放。
远程、缺失或不支持的来源维持原资源并记录 `conversionIssues`，健康本地 Note 仍可转换、阅读和保存。
显式重试重新观察原来源并更新问题。正常正文读写不保留旧 JSON fallback。
