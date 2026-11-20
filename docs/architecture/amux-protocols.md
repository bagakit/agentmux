# AMUX 协议管理架构

Core 持有 AMUX 的编译模板和文本生成 API。产品要求见[AMUX 协议与内置 Prompt](../design/behavior/amux-protocols.md)，精确字节形状见[可读协议](../specs/amux-protocol.md)。

## 模板到调用者

`packages/core/protocols/` 中的 `.amux.prompt.md` 分别持有协议或内置 prompt 的元数据、文本模板和必要的显示样本。构建把这些文件编译为 Core 静态模块。源文件变更由同一生成步骤刷新，生成物可用构建检查核对。运行时由 [Core AMUX 模块](../../packages/core/src/amux-protocol.ts) 提供目录、原模板与参数化渲染。Desktop 协议参考和 CLI 的 Settings guide 直接消费这个目录。CLI guide 用 Markdown 引用需要复用的无参数片段，编译时从同一模板展开。

模板参数由调用方按原业务类型取值。协议的 formatter 继续负责 canonical 转义、JSON 编码和内容分界，再把编码后的值交给模板渲染。用户正文只在原输入的正文边界拼接。模板参数的一次替换保留值中的字面模板字符。模板名称和变体是编译定义，构建可校对缺少的参数和样本。新增或修改模板后一并运行 `node packages/core/scripts/generate-guides.mjs`。语言和平台适配可沿同一模板身份增加匹配的内容。

## 原 owner 与冻结输入

Core 共享 reader 验证各协议的固定结构及数据，保留原 span 和正文。可编辑说明通过文本边界读取。业务 owner 核对真实来源、授权和操作事实，客户端在同一份目录上展示原格式和预览。引用只描述原资料及其发现入口。

原 input、continuity 和 launch owner 分别冻结本次实际交付的 wire、来源与回执。跨版本重试按原归属、操作和已保存的结构化来源核对，重用原说明和输入。模板编辑只参与新输入。历史格式沿原 owner 的实际读取能力对账。
