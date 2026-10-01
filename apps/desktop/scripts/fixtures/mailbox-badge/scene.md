# 邮箱 Inbox 数字与 Notices 提示

约束来自 behavior/presentation conversation-input《入口提示的清楚含义》。复用真实 WorkspaceWorkbench、SessionPane、AgentSessionComposer、SessionMailbox、Avatar、TerminalView、xterm、ordered-byte/input 回路和共享 client-ui CSS；完整 Reader 使用共享 ConversationMessage。

640px dark 一行、320px light 紧凑近换行草稿、320px dark 展开长草稿；同一待发事实下依次验证 Inbox 0、1、12、100（99+），再验证 Notices-only 与 mixed。检查数字完整 Range、中性材质、静态 amber 告示、信封水平包络、Progress／头像避让、原24px命中高度、草稿／xterm稳定。少量代表完整图覆盖三种形态、明暗及各提示组合；还保留 working、waiting、disconnected 邻近头像。640px 额外 native hover 不代读、click Inbox 只归零来信而保 Notices attention，切 Notices 原 read owner ack 后告示保留可回看，关闭后原工作面保留；trusted native key 保持原输入通路。

native 入口沿既有私有控制事实，不触碰用户 Run；消息与告示由实际 Store／原 read owner 投影，不作为真实 CLI 事件证明。现导入共享 CSS 的唯一非空 Inbox 槽宽声明改成calc(2ch + 2px)，完整99+必须实际 Assertion RED，再原字节 restored GREEN；原 Range 容差不放宽。restored不重复保存PNG。源码／编译身份、完整 PNG、raw logs及私有 process/root清理记录留在同轮 receipt；采图不代替独立审美评审。
