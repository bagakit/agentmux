# Message Tools 右侧操作整体

## 已批准范围

用户明确要求所有右下角图标（包括发送、打断）整合，截图指出现有多个底色块“不够整体”，并要求打断与结束 Session 的图标区分。延续已授权提交、验证及更新。采用同一个操作组与举手图标是实现选择，不改变发送、打断或邮箱语义。

## 验收

用量、发送、打断、邮箱／头像在同一操作组，各自可访问与独立触发；组外观连续，三态等高，窄屏可用；打断只调用原 interrupt，不调用 stop Session。行为测试、CSS 非空扫描、变异变红、产品调用者和真实浏览器几何／视觉验证。只改 Composer 表面，不创建新状态或通用工具栏框架。

## 交付验证

66 条相关组件回归、15 条样式与非空扫描守卫通过，Desktop typecheck 通过。5 个变异（组可达、举手图标、interrupt 接线、连续底色、头像光晕）均变红，见 `evidence/composer-session-controls-mutations-20260920.json`。产品调用链为 SessionPane → AgentSessionComposer → AgentComposer，排除定义文件仍有实际调用。

真实浏览器验证 Composer 宽度 280/520/960px × 三态共 9 个组合：操作组与 4 个点击目标均 24px 高，右侧间距均 5px，无横向溢出，子按钮透明、头像无光晕；点击举手触发当前回复中断回调，邮箱打开后清未读。截图 `/tmp/session-controls-final.png`。Gallery 的嵌套滚动使浏览器自动滚动越界，验证时仅把外围 sample article 固定在视口内；组件自身布局与样式未替换。
