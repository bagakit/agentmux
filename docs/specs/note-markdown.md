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
代码、数学块、局部 Source、引用容器和分隔线的锚点位于该块后的独立行。嵌套内容的锚点仍处于原容器内。
列表项有自己的 `<!--amux-item:itemID-->`，与其首段落的 block ID 分别保留；
空段落用 `<!--amux-empty:blockID-->`。ID 字段采用 URI component 编码、解码一次，comment 字段的连字符也编码，避免 `--`。

已有 ID 必须保留；普通新增段落可省略锚点。读取、挂载或观察不分配持久身份，显式保存经原 writer 为缺失块分配 ID。
未锚定块仍可读，`unanchoredBlockCount` 使图观察保持 partial；不能借父块身份伪造 source endpoint 或把未确认标题当成唯一目标。
重复身份不自动改写或选首；同文件重复块／引用 ID 按原 schema 报解析问题，跨资源重复 Note ID 在图中保持歧义。
普通段落仍留在原文件；文内块地址与独立共享文件身份是不同层次。首次保留的共享复用由原 Files 提取 owner 创建独立 Markdown，并将原位置替为整文件嵌入；宿主不保存展开后的正文副本。

## 共享 Markdown 文件

共享内容复用同一 Note 文件格式，frontmatter 增加 `kind: shared-block`；`note-id` 标识整个共享文件，不借用内部首段落或标题身份。

```md
---
schema: agentmux.note.md.v1
note-id: "shared-content-id"
kind: shared-block
title: "共享结论"
---

这份内容可以自然改写。

- 可以增加列表
- 也可以新增段落
```

正文增删、分段与格式调整不改变文件级引用目标。内部段落可以有自己的文内锚点，但它们不是整个共享文件的地址；缺少新段落锚点不否定已确认的文件身份。首次共享标题时，原 Files 提取 owner 以当前准确源稿确定章节范围：同一容器中从该标题至下一个同级或更高标题之前，包含所有下级内容；替换整个范围为一个嵌入，撤销还原整个范围。GUI 和 `file.share` 共用该语义，不新增区间索引或正文副本。原根块地址由原位置嵌入节点承接；提取章节、列表或引用容器时，原位置以 `forwarded="child1,child2"` 明确记录所有移走的已有块地址和嵌入节点已有转发地址到共享文件的转发（编辑树字段为 `forwardedBlockIds`），ID 逐项 URI 编码，不为新段落补造旧地址。其他位置复用不复制这些转发声明，重复或失效的声明不能选首解析。再次提取保内层原声明，链式解析每一跳仍检查唯一性，不因外层去重把原本歧义的地址变成唯一。

就近复制任务项内正文时，以整个原任务项为共享范围，保勾选状态、原项与子块身份；单元格内正文以整个原表格为范围，复制反馈说明该范围。普通及任务列表的提取、混排和撤销沿同一共享 owner，不能把 include 塞进要求首段落的项或单元格。公共 `file.share` 的显式原块目标保持原义，不将非法的内部段落请求静默提升；计划确认尚未发布时明确拒绝，原稿和请求保留。检查历史未知请求不能凭后来结构拒绝追认它未发布。

首次提取的 `origin` 随共享文件保存来源身份、资源路径、原 revision、原块和 operation，以及必要的请求指纹、`sourceOperationId` 与目标提交定位线索。它是可读 YAML 恢复元数据，不包含隐藏的 JSON 正文、可信作者声明或自报成功状态；每个实际文件写入的持久结果仍沿原 Files 和历史操作回执确认。未知时保原请求和文件，不从当前恰好有内容追认丢失的成功回执。

复制和悬停不创建文件。待兑现的粘贴及未知请求保在原 FileDocument 的草稿／恢复事实中，未保存撤销不产生共享实体；它们不是另一份持久当前正文或关系 Store。实际保存沿 `file.share` 共用提取 owner，分别报告共享文件、原位置和目标文档的结果；检查入口及准确参数由 [Files 共享合同](../../packages/core/src/public-rpc-file-share.ts) 与生成的 CLI help 持有。

`file.share.inspect` 的 `request` 模式观察保留的原完整请求；`shared` 模式只需准确 `file.read` 目标，核对 Markdown 声明与可信原创建事件，再分别观察该文件的创建、来源替换和目标提交。单个文件不能重建丢失的未保存全文或整批提取请求，因此不据此宣称整批完成或自动补写。

保存后移除共享嵌入沿 `file.share.undo` 提交完整目标草稿、原基线、操作 ID 和所选 `referenceIds`；`preserveNoteIds` 表达客户端已知草稿、待处理输入或输入法组合仍需保留的内容身份，包括草稿中已绑定的引用目标，不传另一份正文；它只提供保留提示，空数组不证明没有本地草稿。一次保存同时新增共享内容时，原 `file.share` 接受 `undoReferenceIds` 和相同保留提示，经同一 owner 只提交一次最终目标草稿。普通文字的删除不自动作为整库清理请求。`file.share.inspect` 的 `undo` 模式检查原完整撤销请求，不能另造 operation 或根据文件恰好缺失追认删除。

回收判断从完整受管 Host 的原 Markdown 派生全部使用，包括未登记、归档、隐藏及其他共享文件中的引用。它结合原不可变历史与原生排他创建的准确文件代次，核对共享内容没有后来修改；同字节的改写也不能冒充原代次。受管 Note 写入及影响范围的文件管理操作借用原 Note lease，各阶段复核已经观察的文件事实。任意外部文件工具仍按文件系统的乐观并发边界工作，这不构成跨文件原子事务；扫描不完整、身份歧义、已知草稿或实际竞争均返回具体保留原因。没有新增正文、关系或提取事务 Store。

撤销回执分别保目标保存、原位置还原和准确共享文件删除结果。删除只针对已核实的原普通文件，不递归、不覆盖同名替代对象；其原历史事件为 `operation: delete`，当前 `content`／`revision` 为 `null`，删除前正文与可信归属仍在原历史中。`committed` 可表示移除已保存且共享内容因其他使用被明确保留；`partial` 保留已完成的原位置还原及后续明确未回收的阶段事实，允许继续普通编辑。仍未知的写入或删除保原请求和 ID，先检查同次操作。临时保留路径只提供检查线索，不证明文件存在、未删除或操作完成。

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
| `::note-include{#sourceBlock ref="R" target="note:sharedID" path="block-shared.note.md"}` | 原位置或其他 Note 整体嵌入同一共享 Markdown |

`note-include` 的 `target` 指向文件级 `note-id`，`path` 是 Workspace 相对定位线索；跨 Workspace 可带 `workspace="WS_ID"`，无此字段时以宿主 Workspace 定位。路径和 Workspace 都不是身份，不能把第一次路径命中当唯一性证明。整套文件搬到新 Workspace 后，纯文件索引仍按文件内 Note ID 重建关系。同一观察 owner 从原文件重建位置与重复身份，读取头和准确资源后确认整个共享内容；文件改名、移动后仍以原 ID 定位。多个 Note 中的原位编辑共用原共享文件的草稿、revision 和保存 owner，各宿主只保存 include。共享正文的删除、一次嵌入的移除与提取撤销分别处理，不因移除一个位置递归删除共享内容。

这些标记保存字段，不包含隐藏的 JSON／base64 内容树。粗体、斜体、删除线、代码、列表、引用和换行使用 Markdown；
下划线、非标准链接属性、列表类型等原 schema 字段使用有限 HTML／comment 扩展。
图片、表格和任务列表沿下述原 Markdown 语义保存。边界准确的未支持结构保留为局部 Source；身份损坏或范围不明时保留整份 Source 并明确解析问题，不能静默压平或删除。

绑定标记的 `query` 是选定目标时的查询快照，使用上述 comment 字段编码。普通文件工具只改可见 query 后，
parser 发现快照不符便将该 occurrence 读成未绑定，再由原 writer 按新 query 确认；旧目标 ID 不能锁住新文字。
未改 query 的目标改名仍保准确绑定。原 `[label](note:ID#block)<!--amux-ref:R-->` 可读取，下一次规范保存统一写 wiki 形式；
显式旧 JSON 转换将原 atom 的文字展开为可编辑内容，必要的 wiki 字面转义保全任意原 label、target 和 occurrence。
两者都消费同一 schema／codec，不保另一条可写正文格式。

## 图片、表格与任务列表

图片使用 `![alt](source "title")`，保持原地址、替代文字与标题。图片可与文字、公式和链接混排，
身份及作者归原段落，不为一张图片拆分段落或创建另一份正文。附件使用普通 Markdown 链接；
资源导入与读取归原 Files owner，正文不保存渲染数据或二进制副本。

表格使用 GFM 管道表，列对齐使用分隔行的冒号。表格整体沿独立尾行 `^blockID`，
每个单元格段落在格内沿既存尾部 `^blockID`；空格也可仅有该锚点。单元格是一个行内流，
其换行保存为 `<br>`，文字、格式、图片、公式与准确 Note 引用沿原行内规则。
普通增删行列可使表头离开首行、移除表头或产生不同对齐的新单元格；仅在与 GFM 默认值不同时，
在准确格内添加 `<!--amux-cell:header;align=right-->` 一类字段。第一字段仅为 `header` 或 `cell`，
`align` 仅为 `null`、`left`、`center` 或 `right`，分别保存该格类型与原对齐；
它们不承载隐藏内容树，也不把坏字段当作普通文字继续猜测。没有字段时首行是表头，其他行是普通格，
对齐取该列的 GFM 声明。

任务项使用 `[ ]` / `[x]` 保存勾选状态，沿原列表项 `<!--amux-item:itemID-->` 与子段落锚点，
支持嵌套及有序、无序列表中的普通项混排。任务勾选是原编辑事务，保存后仅更新原任务项的最近作者；
子段落未变时保留其作者。只读呈现不提交勾选。表格、任务文本及图片替代文字进入原索引；
图片地址、替代文字和标题中的 wiki 字面量不形成 Note 引用。

## 局部 Source 与 HTML

具有准确边界的原始 HTML、未支持的围栏元信息和其他 Markdown 结构保存为 `noteRawBlock`，
字段为原文 `source` 与 `format`（`html` 或 `markdown`）。HTML 按完整元素的原始位置保留，
不跨空行拆散标签；未知行内语法保留其完整段落，段落原锚点仍属于该块。
若嵌套结构无法局部表示，则保留完整外层结构；不能把已有内层身份迁移到另一块。
边界含糊、缺少明确 HTML 闭合、重复或非法身份、无法保全原 owner 的注解继续进入整份 Source 恢复。
这不是吞掉解析异常的通用降级路径。

规范保存使用可读的 `note-raw html` 或 `note-raw markdown` 围栏，原块锚点在围栏后独立一行。
围栏的反引号数量大于原文内任意连续反引号，至少三个。开行使用 LF；原文之后额外增加一个 LF
作为容器分隔，再闭合围栏。读取移除这一个 LF，原文自有的 CRLF、末尾 CR／LF、空格和反引号全部保留。
容器缩进由 Markdown 容器拥有；局部 `source` 不含该缩进。`note-raw` 的格式与闭合必须明确，
不能猜测未闭合围栏中的身份。原文内部的身份样式文本和 wiki 文字均为字面内容。

编辑局部 Source 通过原块事务更新 `source`，不在输入过程中自动重解析。即使改成多个普通段落，
保存后仍是同一 Source 块，保留原 blockId 与作者。周边支持的段落继续富文本编辑，原 writer 仅为实际变更块
记作者；局部原文可参与全文搜索，但不生成 Note 引用或绑定。普通 `html`／`svg` 代码围栏仍为代码块，
显式静态预览只消费原文，不把清洗后的 DOM 写回正文。

## 数学表达式

行内公式使用 `$x^2$`，块公式使用独立的 `$$` 开闭围栏；块锚点仍位于关闭围栏后的独立行。
共享 Markdown codec 通过已安装的 `remark-math` 解析和序列化表达式，编辑树分别使用
`noteMathInline` 和 `noteMathBlock` 的 `latex` 字符串；块公式持有与其他语义块相同的 `blockId` 和原可信作者记录。
需要时 serializer 使用更长的美元分隔符以保留表达式内的美元字符。清空的行内公式写作 `$ $`，保空白公式和原段落，不能写成块开头 `$$`。

```md
能量为 $E = mc^2$。 ^energy-paragraph

$$
\int_0^1 x^2 \, dx = \frac{1}{3}
$$

^energy-equation
```

反斜线转义的美元与代码中的美元保持字面内容；普通文本中的未配对美元不生成公式。
表达式内的 `[[…]]` 不参与页面链接绑定或引用索引，公式源码仍参与块的可读文本检索。
渲染器不决定正文合法性：无法排版的表达式仍可修改和保存，错误只影响该处预览。
原 Files／Notebook 公共读写复用相同 codec、准确资源和 revision，不增加数学专用保存接口。

## 元数据与公共消费

原 [NotebookStore](../../packages/core/src/notebook-store.ts) 通过[本地文件后端](../../packages/core/src/notebook-files.ts)持有目录、关注、操作指纹／轨迹、块归因与不可变正文历史。
笔记库中的 `notebooks.root.json` 发布当前文件引用与库身份；相邻的 `notebooks.root.json.files/` 按摘要保存
`catalog/` 目录 JSON、`metadata/` 准确 Note／资源的归因与事件 JSON、`operations/` 原事件定位 JSON，以及 `bodies/` 历史 Markdown。
当前正文仍由原 `.note.md` 文件持有，不保存第二份可写当前正文。Canvas 布局仍由原 client owner 持有。
普通目录读取只取当前目录文件；准确归因与历史查询不读取无关 Note 的元数据或全部历史正文。graph／resolve 从原文件派生关系。

文件后端先持久保存不可变依赖，再原子发布根文件，并以相邻 `.identity` 文件确认库身份。
首次遇到旧 SQLite／目录 JSON 时，由[只读导入器](../../packages/core/src/notebook-sqlite-import.ts)与原 owner 保全输入原字节，
核对完整目录、归因、操作及历史正文后切换；正常读写不再使用数据库。中断的导入保留绑定原目标及输入的 `.importing.json`，
源发生变化时保原件与同次导出，不用旧导出覆盖新输入。已确认的根或依赖文件缺失、损坏时保持未确认，不回退旧数据库或空目录。
库复制到新目录后，原 owner 核对受管正文身份并更新属于原库的本地资源地址；外部引用与历史 `originalResource` 保留原地址。
文件自足与内容保全要求归[Note 基础原则](../design/behavior/knowledge-workflows.md#recallnotebook-与块知识)。

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

`amux notebook scan --workspace ID --path DIR [--query TEXT]` 经原 Files 读取指定物理目录，不要求 Notebook 的目录与元数据文件。
结果包含每个准确文件的 Note ID、可用标题、revision、大纲、显式前向关系和全文命中；反链可由同一前向关系派生。
同名页保候选，重复 Note ID 保不同资源行，不选首或合并。无锚点的新正文也可命中，`blockId:null` 明确它没有稳定跳转目标；
读取不分配身份。未读／无效文件、缺标题、未锚定内容和预算耗尽保 partial／unknown，不能用已见单个候选确认全范围唯一。

这是有明确范围的只读观察，不注册页面、不重写正文或替换原目录，也不从缺失证据重造 Notebook 收纳、可信作者、关注与历史。
普通 ignored 文件包括在内，符号链接报告后不跟随。默认候选文件和目录各 200、总接受原文 4 MiB；可显式提高，
各上限 20000／20000／64 MiB。全文 `limit` 默认 30、上限 1000；`total` 是已观察范围内匹配的文本块数。
取消只结束本读者并停止后续原文件读取；已经发出的原目录列举仍由 Files 持有。单次列举当前会返回全部名字，
不能将扫描预算称作底层目录 IO 或分配的硬上限。它不是跨文件原子快照，索引也不是新的正文或关系权威。

## 持久正文历史

[原 Note writer](../../apps/host/src/note-file-writer.ts) 沿既有 NotesStorage 锁和 Files revision CAS 保存正文，
在同一原元数据 owner 中准备历史事件并分别确认正文与历史结果。当前 Markdown 是唯一当前正文；历史保存不可变的前后内容快照，
不是可独立写入的另一份当前文档，也不是从当前 Markdown 可重建的缓存。

[历史模型](../../packages/core/src/note-history.ts) 的 `eventId` 区分每次编辑；`revision` 仍是正文摘要。
相同字节再次写入、A → B → A 不能复用旧事件或把旧作者当成本次操作者。事件保留原 Note、准确资源、前后 revision、
可确认的 parent、可信 actor、时间及操作类型。`resource` 随已确认的文件／目录搬迁更新查询归属，`originalResource` 保原事件地址。
连续同一操作者的活动可归为同一 `batchId`，聚合不删除底层事件。

文件后端在 `bodies/<sha256>.md` 保存按摘要去重的历史原文；准确 Note／资源的元数据文件保留事件序列，原操作索引随同一根文件发布。
时间线查询读取该 Note／资源的事件元数据并返回请求窗口；选取具体内容时才读取相应历史正文。
历史内容与原目录、关注和归因一同备份、校验和搬迁。已确认的历史文件缺失或内容损坏是未确认，不能重建空记录冒充没有历史；
原目录和健康正文读写仍可用。历史准备或结果记账失败不否定已写成的正文，回执分别返回正文结果与 `noteHistory`。
`prepared`／`unconfirmed` 保原事件地址，不能凭匹配字节追认本次提交或自动重写正文。

`file.history`／`amux file history` 读取准确 `file.read` resource 和 Note ID 的历史。默认新到旧返回元数据，
`before` 以最旧返回项的 `sequence` 续页；`batches` 只聚合本次窗口成员，不保证是完整批次。
只有选择准确 `eventId` 并启用 `includeContent`／`--content` 才读取前后内容供比较。内容对超出原 RPC 帧容量时，
仅本次内容读取明确不可用，同一事件的元数据及普通正文读写继续可用，不截断持久历史或改变公共帧上限。
可信作者来自原写入调用边界，查询不能自报 actor。历史不可用或未确认不能返回“已确认空历史”。
历史读取本身不执行恢复或撤销；协同产品要求及其交付边界见[人和 Agent 协同编辑](../design/behavior/knowledge-workflows.md#note-中-agent-与人的协同编辑)。

## 编辑器与原文件会话

Desktop 的 Note 和 Source 继续共用原 `FileDocument`、文件监听、保存队列与持久草稿；移动端的 Note 编辑继续使用原编辑状态。
文件的已保存基线、后来本地输入、已发出的保存意图分别保留。远端原文与本地草稿使用同一精确 diff3 和稳定块身份检查，
纯解析、合并及结果结构检查在 browser Worker 中执行。不能确认安全合入时保三份正文，不能将观察失败冒充对方没有修改。

富文本收到新快照时，按稳定结构及实际内容差异生成多个 ProseMirror Step，映射选区和已有撤销历史，远端事务不进入本地撤销组。
等待快照映射期间继续输入，每次变化携带该事务实际编辑前的内容；原文件会话将这段输入映到自己的最新草稿。
尚未映完的基线、目标和输入随原草稿持久保存，同一编辑链的连续输入可聚合；来自不同实际基线的输入按原增量依次映射，保存等待其结果。
任一阶段重叠时保最新显示稿和各份原稿，可展开、选择保留稿并检查原未知请求；选择正文不重放或删除原请求，也不能用旧编辑器全文覆盖已接收的新稿。
输入法组合期间保原编辑器，结束后先发布最终输入，再接收待映射内容。Worker 失败保输入与同一目标，并提供重试入口。
段落重排或匿名结构变化无法确认位置映射时，保原编辑器和撤销上下文，可只读比较显示稿与新稿；明确选择继续编辑显示稿时，
先把新稿保入原保留稿，再切换当前草稿，不自动写文件、重置编辑器或补造块身份。

`written` 与 canonical 内容是否可用分别处理。内联内容明确不可用时保已写 revision／事件和原意图，
读取同一 revision 的原文或已提交原事件后再确认内容；不能拿提交稿补成 canonical。`unknown` 不由当前字节相同追认为已提交，
也不自动重发原请求。Source 暂时写坏身份头或显式重建文件时仍保同一准确文件的尝试，身份不明保持未知，不能因此回到匹配字节即确认的路径。
用户可明确采用当前原文件继续编辑，同时保留旧草稿及原请求，旧请求结果仍保持未知。
共享编辑器的本机草稿持久化失败时，原保存基线、请求和输入继续留在本工作面。其他工作面的更新保为另稿，
同一原事件的已确认回执才沿原提交稿对账；不能把保留下来的旧全文直接配上另一稿的新 revision 再保存。

Note 的版本窗口仅在展开且当前可见时读取元数据，按真实活动分组、续页；选定一个事件才读取原始前后内容，使用现有只读 diff 编辑器比较。
恢复和批次撤销通过原文档保存队列调用下述公共动作；本地草稿和后来输入保留，重叠时交回原文档冲突处理。

## 整篇恢复与批次撤销

`file.restore`／`amux file restore` 选择同一准确 Note／资源的已提交 `eventId`，将该事件的 **after 内容**恢复为新版本。
它要求准确当前 `expectedRevision` 与新的 `operationId`；保所选历史原始字节，包括 BOM、换行及未受富文本 schema 支持的原文，
不重新规范化、绑定链接或分配身份。整篇恢复有意替换完整已保存正文；原版本和后来版本仍在历史中。

`file.undo`／`amux file undo` 选择 `batchId` 与已观察的 `batchLastEventId`，由原 owner 索引读取完整成员，
不能把一页时间线当成完整活动。批次必须是同一可信作者、连续且均已提交的普通编辑；尾部变化需要重新选择。
撤销以批次末尾为共同基线，将批次前内容与当前正文作精确逆向合并，保留后来不冲突的编辑；
重叠、块身份或合并后结构冲突保原三份正文与 `not-applied`，不写盘。已确认创建批次的逆操作是清空正文，
保原 Note ID、当前标题、目录和永久引用；它不是删页。

两种动作均经原 Host 的可重入 lease、历史准备及 Files CAS，生成独立 `restore`／`undo` 事件与明确 `source`，
不并入普通编辑批次。原创建者由事件及准确原 revision 的可信作者记录恢复，最近编辑者是本次操作者；
parent 未知不丢弃独立已知创建者。GUI 和 CLI 共享原权限、可信 actor 和回执，调用者不能自报作者。
同 operation 的已提交重试只回原回执，不覆盖后来正文；已拒绝保持终局，未确认不凭当前字节追认或重放。

已写成的 Note 内容和元数据若与真实 RPC request ID 一同超过原帧容量，仍保 `written`、revision、原历史事件及 replay 状态，
以 `contentUnavailable` 明确本次 canonical 内容传输不可用，不截断持久正文或扩大帧上限。该回执不带伪造的 canonical 内容或正文归因／标题投影；
消费者保原操作及后来草稿，读取同一准确原文件和 revision 对账，不能用提交草稿充作已经确认的保存正文。

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
