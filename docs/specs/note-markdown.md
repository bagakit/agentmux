# Note Markdown 与元数据

本文描述 Note 当前文件格式及其 owner。产品约束归 [知识工作流](../design/behavior/knowledge-workflows.md#recallnotebook-与块知识)，
公共调用入口归 [公共能力来源](public-capabilities.md)。语法实现由共享 [Markdown codec](../../packages/client-ui/src/note/note-markdown.ts)
及 [Core 身份头](../../packages/core/src/note-format.ts) 持有。

## 正文和身份

`.note.md` 是唯一持久正文，编辑树只在内存中存在。普通无身份头的 `.md` 沿普通 Markdown 文件处理。
身份头保存稳定 Note ID；标题、路径和显示名称不代替身份。

```md
---
schema: agentmux.note.md.v1
note-id: "original-note-id"
---

## 研究结论 ^heading1

保留原始观察。 ^paragraph1

参见 [相关发现](note:otherNote#targetBlock)<!--amux-ref:occurrence1--> ^paragraph2
```

段落／标题支持尾部 `^blockID`，也支持紧随原块的独立锚点行；canonical serializer 使用独立行。
代码、引用容器和分隔线的锚点位于该块后的独立行。嵌套内容的锚点仍处于原容器内。
列表项有自己的 `<!--amux-item:itemID-->`，与其首段落的 block ID 分别保留；
空段落用 `<!--amux-empty:blockID-->`。ID 字段采用 URI component 编码、解码一次，comment 字段的连字符也编码，避免 `--`。

已有 ID 必须保留；普通新增段落可省略锚点。读取、挂载或观察不分配持久身份，显式保存经原 writer 为缺失块分配 ID。
未锚定块仍可读，`unanchoredBlockCount` 使图观察保持 partial；不能借父块身份伪造 source endpoint 或把未确认标题当成唯一目标。
重复身份不自动改写或选首；同文件重复块／引用 ID 按原 schema 报解析问题，跨资源重复 Note ID 在图中保持歧义。
引用块留在原文件，只有显式提取独立 Note 才拆文档。

## 链接和引用

原始 `[[页面]]`、`[[页面 #标题]]` 和 `[[页面 #^blockID]]` 可直接写入正文。
原 writer 只把唯一且已确认的目标绑定为稳定 ID。代码、反斜线转义和未完成 token 保持字面文本。
已有绑定不会因改名或同名页面重新解析。

| 形式 | 表达 |
| --- | --- |
| `[label](note:noteID)<!--amux-ref:R-->` | 已绑定页面与 occurrence |
| `[label](note:noteID#blockID)<!--amux-ref:R-->` | 已绑定块与 occurrence |
| `[[query]]<!--amux-ref:R-->` | 有稳定 occurrence 的未绑定查询 |
| `::note-ref{#sourceBlock ref="R" target="note:noteID#blockID"}` | 结构化块引用 |
| `::note-embed{#sourceBlock ref="R" target="note:noteID#blockID"}` | 在原位置嵌入目标块 |

这些标记保存字段，不包含隐藏的 JSON／base64 内容树。粗体、斜体、删除线、代码、列表、引用和换行使用 Markdown；
下划线、非标准链接属性、列表类型等原 schema 字段使用有限 HTML／comment 扩展。
当前编辑 schema 不支持的表格、图片、task list 或未知结构保持原 Source 并明确解析问题，不能静默压平或删除。

## 元数据与公共消费

原 [NotebookStore](../../packages/core/src/notebook-store.ts) 的 `notebooks.sqlite` 持有目录、关注、操作指纹／轨迹及块归因，
不保存第二份正文。Canvas 布局仍由原 client owner 持有。普通目录读取不扫描全部作者历史；graph／resolve 从原文件派生关系。

`file.read/write/create` 复用原 Files 的准确资源与 revision CAS；`notebook.content`／`inspect --content` 观察同一已保存正文。
`noteProvenance` 绑定 Note ID、完整 resource、正文 revision 和稳定 block ID。可信 actor 来自原调用权限边界，不能从正文声明作者。
创建者与最近编辑者分别记录，空值保持未知；外部编辑导致 revision 失配时保留已知创建者、最近作者未确认。

正文写成而元数据未确认时，回执仍为 `written`，并带 `noteAttribution`／`noteProvenance` 的未确认状态。
消费者采用 canonical content／revision 并保护后来输入，读取同一对象对账，不为补作者记账重复写正文。
`unknown` 写入保留原尝试 bytes／revision，确认原结果后才决定下一次保存。

`notebook graph` 提供页面层级、incoming／outgoing 与准确 source／target；原始文本 occurrence 的位置是当前保存修订内的
block inline PM UTF16 offset，不是 Markdown 字节位置。它不是跨文件原子快照；未读、歧义和未锚定状态不能被空边列表代签。
`notebook apply` 的 `follow/unfollow` 只改变可信调用者自己的持久关注，不表示在线或通知授权。
完整 Agent 操作指引由 [CLI Note guide](../../packages/core/src/agentmux-cli-note-guide.ts) 随 `amux --skill` 提供。

## 存量转换与恢复

原 `.note.json` 和 JSON 目录只作显式一次转换输入。原 NotesStorage journal 配合
[Host 转换适配器](../../apps/desktop/src/main/note-legacy-conversion.ts) 校验原身份、全部语义与 source／target hashes，
先保全原字节备份并确认目标正文、元数据、目录和空间资源，再清理旧活动文件。
不覆盖不同目标，不自动合并重复身份；中断沿原 operation ID 继续，不另造 Note。

`resourceChanges` 提供准确 from／to 以及 `conversion.sourceRevision/targetRevision`，Desktop／Mobile 以此续接原资源。
原 Tab／Region／块、dirty draft 和未知保存尝试都保留；转换旧草稿时保全原文与原 revision，不把未知尝试换新 revision 自动重放。
远程、缺失或不支持的来源维持原资源并记录 `conversionIssues`，健康本地 Note 仍可转换、阅读和保存。
显式重试重新观察原来源并更新问题。正常正文读写不保留旧 JSON fallback。
