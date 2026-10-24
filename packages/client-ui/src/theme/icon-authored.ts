import type { IconShape } from './icon-catalog.js'

/** Drawing and presentation guidance share one author entry. Guidance is display data,
 * never a source of Runtime state, operation success or control eligibility. */
export type AuthoredIconDesign = {
  rest: string
  motion: (
    | { kind: 'still'; animation: 'none' }
    | { kind: 'loop'; animation: 'work' | 'stream' | 'execute' | 'wait' | 'orbit' }
    | { kind: 'once'; animation: 'feedback' }
  ) & { description: string; trigger: string }
}

type AuthoredIconDefinition = {
  shapes: readonly IconShape[]
  design: AuthoredIconDesign
}

/** Static mark and interactive avatar use the same 24-unit rest geometry. */
export const MOTE_COMPANION_PARTS = {
  "body": "M4.7 2.8C7.1 3.05 9.1 4.05 10.45 5.3C11.55 4.95 12.75 4.75 14.05 4.8C18.65 4.95 21.2 8.25 21.2 12.7C21.2 17.65 17.5 21 11.95 21C6.45 21 2.8 17.8 2.8 13.15C2.8 11.05 3.4 9.25 4.3 7.8L4.7 2.8Z",
  "leftEye": "M8.45 10.45C7.65 10.45 7.05 11.2 7.05 12.2C7.05 13.2 7.65 13.95 8.45 13.95C9.25 13.95 9.85 13.2 9.85 12.2C9.85 11.2 9.25 10.45 8.45 10.45Z",
  "rightEye": "M15.55 9.9C14.65 9.9 14 10.75 14 11.85C14 12.95 14.65 13.8 15.55 13.8C16.45 13.8 17.1 12.95 17.1 11.85C17.1 10.75 16.45 9.9 15.55 9.9Z"
} as const

/** AgentMux drawings on the original 24-unit grid. Keep the theme pen, complete
 * still silhouette and negative space at 12–14px. Only declared parts can move. */
export const AUTHORED_ICON_DEFINITIONS = {
  "subagent-report": {
    shapes: [["circle", {"cx":"5","cy":"5","r":"2"}], ["path", {"d":"M5 7v8a2 2 0 0 0 2 2h3"}], ["rect", {"x":"10","y":"11","width":"11","height":"10","rx":"2"}], ["path", {"d":"M13 15h5m-5 3h3"}]],
    design: {
      rest: "原生分支节点连到一份回报，短内容线在小尺寸仍可辨；不复用主 Agent 头像",
      motion: { kind: "still", animation: "none", description: "类别标签保持静止，开合仅由相邻箭头表达。", trigger: "按原生协作回报类别显示；不表示身份认证、运行状态或任务完成。" }
    }
  },
  "layout-split-left": {
    shapes: [["rect",{"x":"3","y":"4","width":"9","height":"16","fill":"currentColor","opacity":".12","stroke":"none"}],["rect",{"x":"3","y":"4","width":"18","height":"16","rx":"2"}],["path",{"d":"M12 4v16"}],["path",{"d":"M10 12H5.5m2.5-2.5L5.5 12 8 14.5"}]],
    design: {
      rest: "固定分区框与指向新增落点的箭头；兼容原“移到新组”的方向语义",
      motion: { kind: "still", animation: "none", description: "方向、格局与比例在小尺寸保持完整静止轮廓；原菜单的 hover、focus 与动作结果提供反馈。", trigger: "按原布局动作显示；图形不表示执行、当前选择或操作回执。" }
    }
  },
  "layout-split-right": {
    shapes: [["rect",{"x":"12","y":"4","width":"9","height":"16","fill":"currentColor","opacity":".12","stroke":"none"}],["rect",{"x":"3","y":"4","width":"18","height":"16","rx":"2"}],["path",{"d":"M12 4v16"}],["path",{"d":"M14 12h4.5m-2.5-2.5 2.5 2.5-2.5 2.5"}]],
    design: {
      rest: "固定分区框与指向新增落点的箭头；兼容原“移到新组”的方向语义",
      motion: { kind: "still", animation: "none", description: "方向、格局与比例在小尺寸保持完整静止轮廓；原菜单的 hover、focus 与动作结果提供反馈。", trigger: "按原布局动作显示；图形不表示执行、当前选择或操作回执。" }
    }
  },
  "layout-split-up": {
    shapes: [["rect",{"x":"3","y":"4","width":"18","height":"8","fill":"currentColor","opacity":".12","stroke":"none"}],["rect",{"x":"3","y":"4","width":"18","height":"16","rx":"2"}],["path",{"d":"M3 12h18"}],["path",{"d":"M12 10V6m-2.5 2.5L12 6l2.5 2.5"}]],
    design: {
      rest: "固定分区框与指向新增落点的箭头；兼容原“移到新组”的方向语义",
      motion: { kind: "still", animation: "none", description: "方向、格局与比例在小尺寸保持完整静止轮廓；原菜单的 hover、focus 与动作结果提供反馈。", trigger: "按原布局动作显示；图形不表示执行、当前选择或操作回执。" }
    }
  },
  "layout-split-down": {
    shapes: [["rect",{"x":"3","y":"12","width":"18","height":"8","fill":"currentColor","opacity":".12","stroke":"none"}],["rect",{"x":"3","y":"4","width":"18","height":"16","rx":"2"}],["path",{"d":"M3 12h18"}],["path",{"d":"M12 14v4m-2.5-2.5L12 18l2.5-2.5"}]],
    design: {
      rest: "固定分区框与指向新增落点的箭头；兼容原“移到新组”的方向语义",
      motion: { kind: "still", animation: "none", description: "方向、格局与比例在小尺寸保持完整静止轮廓；原菜单的 hover、focus 与动作结果提供反馈。", trigger: "按原布局动作显示；图形不表示执行、当前选择或操作回执。" }
    }
  },
  "layout-columns-3": {
    shapes: [["rect",{"x":"3","y":"4","width":"18","height":"16","rx":"2"}],["line",{"x1":"9","y1":"4","x2":"9","y2":"20"}],["line",{"x1":"15","y1":"4","x2":"15","y2":"20"}]],
    design: {
      rest: "严格3列×1行；统一外框、笔触和留白",
      motion: { kind: "still", animation: "none", description: "方向、格局与比例在小尺寸保持完整静止轮廓；原菜单的 hover、focus 与动作结果提供反馈。", trigger: "按原布局动作显示；图形不表示执行、当前选择或操作回执。" }
    }
  },
  "layout-grid-4": {
    shapes: [["rect",{"x":"3","y":"4","width":"18","height":"16","rx":"2"}],["line",{"x1":"12","y1":"4","x2":"12","y2":"20"}],["line",{"x1":"3","y1":"12","x2":"21","y2":"12"}]],
    design: {
      rest: "严格2列×2行；统一外框、笔触和留白",
      motion: { kind: "still", animation: "none", description: "方向、格局与比例在小尺寸保持完整静止轮廓；原菜单的 hover、focus 与动作结果提供反馈。", trigger: "按原布局动作显示；图形不表示执行、当前选择或操作回执。" }
    }
  },
  "layout-grid-9": {
    shapes: [["rect",{"x":"3","y":"4","width":"18","height":"16","rx":"2"}],["line",{"x1":"9","y1":"4","x2":"9","y2":"20"}],["line",{"x1":"15","y1":"4","x2":"15","y2":"20"}],["line",{"x1":"3","y1":"9.33333","x2":"21","y2":"9.33333"}],["line",{"x1":"3","y1":"14.6667","x2":"21","y2":"14.6667"}]],
    design: {
      rest: "严格3列×3行；统一外框、笔触和留白",
      motion: { kind: "still", animation: "none", description: "方向、格局与比例在小尺寸保持完整静止轮廓；原菜单的 hover、focus 与动作结果提供反馈。", trigger: "按原布局动作显示；图形不表示执行、当前选择或操作回执。" }
    }
  },
  "layout-balance": {
    shapes: [["rect",{"x":"3","y":"4","width":"8","height":"12","rx":"1.5"}],["rect",{"x":"13","y":"4","width":"8","height":"12","rx":"1.5"}],["path",{"d":"M3 19h18m-18-1v2m18-2v2"}]],
    design: {
      rest: "等尺寸分区＋共同基线，表示均分比例，不是增加固定格数",
      motion: { kind: "still", animation: "none", description: "方向、格局与比例在小尺寸保持完整静止轮廓；原菜单的 hover、focus 与动作结果提供反馈。", trigger: "按原布局动作显示；图形不表示执行、当前选择或操作回执。" }
    }
  },
  "goal-consensus": {
    shapes: [["path",{"d":"M5 3h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H8l-5 3V5a2 2 0 0 1 2-2Z"}],["path",{"d":"M9 15V6.5"}],["path",{"d":"M9 6.5h8l-2 3 2 3H9Z","fill":"currentColor","stroke":"none","data-semantic-icon-part":"agreement-flag"}]],
    design: {
      rest: "对话框中的实心旗帜表达讨论并约定共同方向，小尺寸保留清晰旗面与对话尾；不表示已经确认或完成",
      motion: {"kind": "once", "animation": "feedback", "description": "仅旗面沿固定旗杆轻轻展开一次，对话框与旗杆保持静止", "trigger": "本次准确 Goal 与所见 revision 经原 owner 确认后显式反馈；导航、旧确认和结果验收不触发。"}
    }
  },
  "survey-explore": {
    shapes: [["path",{"d":"M10 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4M3 8h18"}],["circle",{"cx":"15.5","cy":"14.5","r":"4"}],["path",{"d":"m18.5 17.5 3 3"}],["path",{"d":"m14 13.2 2 2","data-semantic-icon-part":"survey-reflection"}]],
    design: {
      rest: "开放浏览框与留白探查镜，表达浏览中主动查阅；不混同指南针、书册或纯浏览器",
      motion: {"kind": "once", "animation": "feedback", "description": "仅镜内短反光线轻扫并归位，浏览框、镜圈与镜柄固定", "trigger": "当前原 Survey 成果 written 且 notebookRegistered 后反馈一次；打开记录面、未知登记、导航和旧成果静止。"}
    }
  },
  "note-page": {
    shapes: [["path",{"d":"M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z"}],["path",{"d":"M14 3v6h6M8 17h6"}],["path",{"d":"M8 13h8","pathLength":"1","data-semantic-icon-part":"note-content"}]],
    design: {
      rest: "单份折角页与两条错长内容线；区别于 Notebook 书册集合和关系图",
      motion: {"kind": "once", "animation": "feedback", "description": "仅正文上方一条线短描一次，纸框、折角与另一条线固定", "trigger": "本次准确资源与正文 revision 获得 written 回执后反馈；旧回执、目录、焦点与点击保存不触发。"}
    }
  },
  "note-related-blocks": {
    shapes: [["path",{"d":"M5 3H3v7h2M19 3h2v7h-2M8 6.5h8M5 14H3v7h2M19 14h2v7h-2M8 17.5h5"}]],
    design: {
      rest: "两段分开的横向摘录与少量括定提示，表达相关原块；区别于完整单页、书册和邻域关系图",
      motion: { kind: "still", animation: "none", description: "阅读范围由原正文与按钮状态表达，摘录轮廓保持完整静止", trigger: "原相关块阅读动作；点击与视图切换不代表读取成功、正文写入或持续活动。" }
    }
  },
  "note-block": {
    shapes: [["rect",{"x":"4","y":"6","width":"16","height":"12","rx":"2"}],["path",{"d":"M8 10.5h8M8 14h5"}]],
    design: {
      rest: "无折角的横向圆角块卡与内部两条错长短线，表达单个语义内容块；区别于折角整页、书册与 Note 区域外框",
      motion: { kind: "still", animation: "none", description: "块身份与关联状态由卡片边界和连线表达，图形保持完整静止", trigger: "按原 Note 语义块节点显示；不表示读取成功、保存或连接执行。" }
    }
  },
  "shared-block": {
    shapes: [["rect",{"x":"6","y":"5","width":"12","height":"14","rx":"2"}],["path",{"d":"M2 12h4M18 12h4M9.5 10h5M9.5 14h3"}]],
    design: {
      rest: "带左右连接短线的共享内容块卡，表达同一份独立原内容被多处引用；区别于单块与复制页",
      motion: { kind: "still", animation: "none", description: "共享与桥接事实由原观察模型与连线表达，图形保持完整静止", trigger: "按已确认的共享 Markdown 实体显示；不随悬停或选择产生循环动画。" }
    }
  },
  "work-writing": {
    shapes: [["path",{"d":"M4 6h8 M4 12h5"}],["path",{"d":"M9 20l1-4 9-9 3 3-9 9-4 1Z","data-semantic-icon-part":"writing-pen"}]],
    design: {
      rest: "两条文字线固定，斜笔承担动作；12px下保留笔尖与纸外留白",
      motion: { kind: "loop", animation: "work", description: "仅笔短划、抬起、停顿；文字线与外框固定", trigger: "原当前状态 owner 确认正在产出时显式选择；标题、历史和只读快照静止。" }
    }
  },
  "content-stream": {
    shapes: [["path",{"d":"M4 6h16 M4 12h11 M4 18h7"}],["path",{"d":"M15 15v6","data-semantic-icon-part":"stream-caret"}]],
    design: {
      rest: "三条渐短正文线与右下光标，必须始终能读成文字流",
      motion: { kind: "loop", animation: "stream", description: "仅右下光标沿短字符步长推进/回位，正文三线固定；不明灭整个图形", trigger: "准确当前流尚未结束时显式选择；记录中的 streaming 标签不授予实时资格。" }
    }
  },
  "browser-executing": {
    shapes: [["path",{"d":"M11 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6"}],["path",{"d":"M3 9h4l2-3h5l2 3h5"}],["path",{"d":"M14 16h8m-3-3 3 3-3 3","data-semantic-icon-part":"execution-arrow"}]],
    design: {
      rest: "浏览器框与前进箭头分离；窗口框固定",
      motion: { kind: "loop", animation: "execute", description: "仅执行箭头小步前送/回位，浏览器框和tab顶栏固定", trigger: "原当前 operation 非终局且 control 为 agent、phase 为 running 时显式选择；历史静止。" }
    }
  },
  "work-history": {
    shapes: [["path",{"d":"M6 7.5v3 M6 13.5v3 M11 6h9 M11 12h7 M11 18h9"}],["circle",{"cx":"6","cy":"6","r":"1.5"}],["circle",{"cx":"6","cy":"12","r":"1.5"}],["circle",{"cx":"6","cy":"18","r":"1.5"}]],
    design: {
      rest: "左侧三个节点和右侧记录线构成时间记录，非当前工作信号",
      motion: { kind: "still", animation: "none", description: "当前消费表达对象/记录或入口，未提供持续活动事实；实际面板/选中/布局变化已表达动作结果，保持图标静止减少重复反馈。", trigger: "沿现有对象身份、分类、导航、记录或工具入口；hover/focus沿宿主短反馈" }
    }
  },
  "status-dot": {
    shapes: [["circle",{"cx":"12","cy":"12","r":"10","fill":"currentColor","stroke":"none"}]],
    design: {
      rest: "实心圆是微几何，多种角色靠宿主状态文字、准确语义和已有色 token 区分",
      motion: { kind: "still", animation: "none", description: "存活、空闲、排队、终止、未知或需要输入均不等价于正在工作。永久循环会误导，原正文/动作仍准确。", trigger: "沿原已确认状态或控件值显示；存活、排队、未知等事实不自动启用动画。" }
    }
  },
  "redaction-block": {
    shapes: [["rect",{"x":"3","y":"6","width":"18","height":"12","rx":"2","fill":"currentColor","stroke":"none"}]],
    design: {
      rest: "实心圆角矩形表示遮盖；遮盖结果必须保持实心",
      motion: { kind: "still", animation: "none", description: "特殊填充几何或身份不应套循环、禁止遮罩或斜杠。", trigger: "原工具/resize/身份槽职责，不存在可泛化的busy事实" }
    }
  },
  "resize-corner": {
    shapes: [["path",{"d":"M5 19 19 5M11 19l8-8M17 19l2-2"}]],
    design: {
      rest: "右下三条递短斜纹表示可拖拽缩放，与斜向指针及角部命中区一致",
      motion: { kind: "still", animation: "none", description: "特殊填充几何或身份不应套循环、禁止遮罩或斜杠。", trigger: "原工具/resize/身份槽职责，不存在可泛化的busy事实" }
    }
  },
  "workflow-progress": {
    shapes: [["circle",{"cx":"12","cy":"12","r":"8.25","opacity":".16"}],["circle",{"cx":"12","cy":"12","r":"8.25","pathLength":"100","stroke-dasharray":"30 70","data-semantic-icon-part":"progress-arc"}]],
    design: {
      rest: "完整静态圆轨与短弧，静止时仍可读“过程”，不是百分比",
      motion: { kind: "loop", animation: "orbit", description: "只使短弧绕原静态圆轨走一圈，弧长不变化，不声称进度", trigger: "原 Workflow 状态为 running 且非 recorded 时显式选择；不以弧长表示完成比例。" }
    }
  },
  "mote-companion": {
    shapes: [["path",{"d":MOTE_COMPANION_PARTS.body + MOTE_COMPANION_PARTS.leftEye + MOTE_COMPANION_PARTS.rightEye,"fill":"currentColor","stroke":"none","fill-rule":"evenodd"}]],
    design: {
      rest: "单侧抬起的安定轮廓与两枚偏置眼孔，表达专注、机灵而克制的持久搭档；12–24px保持完整",
      motion: { kind: "still", animation: "none", description: "类型、历史与导出静止；可见自动头像的靠近、聚焦和按下回应由原头像 owner 驱动局部部件。", trigger: "身份不推导工作、在线、权限或完成事实。" }
    }
  },
  "mote-identity": {
    shapes: [["path",{"d":"M5.5 2.75H12.25C17.3 2.75 21.25 6.95 21.25 12C21.25 17.05 17.3 21.25 12.25 21.25C7.2 21.25 2.75 17.05 2.75 12V6C2.75 4.2 3.7 2.75 5.5 2.75ZM8 8.25C9.3 6.3 12 5.7 14.1 6.8C16.2 7.9 16.75 10.4 15.55 12.35C14.75 13.7 13.7 14 13.05 15.35C12.6 16.25 12.5 17.1 12.6 17.9C10 17.2 8 15.25 7.3 12.9C6.8 11.15 7.1 9.65 8 8.25Z","fill":"currentColor","stroke":"none","fill-rule":"evenodd"}]],
    design: {
      rest: "左上宽平肩、短直边与圆弧外壳形成偏置剪影，内凹负空间在12–24px保持清楚",
      motion: { kind: "still", animation: "none", description: "类型与自动默认标记保持静止；已选头像姿态由原外观来源和宿主持有。", trigger: "身份不推导工作、在线、权限或完成事实。" }
    }
  },
  "badge-token": {
    shapes: [["path",{"d":"M11.3 3.5a1 1 0 0 1 1.4 0l7.8 7.8a1 1 0 0 1 0 1.4l-7.8 7.8a1 1 0 0 1-1.4 0l-7.8-7.8a1 1 0 0 1 0-1.4Z","fill":"currentColor","stroke":"none"}]],
    design: {
      rest: "单实体切角菱形，在6／8px徽标槽中保留清楚轮廓，不借用Mote身份",
      motion: { kind: "still", animation: "none", description: "Executor装饰选择保持静止，与Provider品牌和运行状态独立。", trigger: "沿已保存spark徽标选择呈现，不授予运行或身份能力。" }
    }
  },
  "mote-mark": {
    shapes: [["path",{"d":"M7.1 3.8c1.6-1.6 4.5-2 6.5-.9l5 2.8c1.6.9 2.5 2.7 2.1 4.6l-.9 5.2c-.3 1.6-1.4 2.9-2.9 3.5l-4.5 2c-1.9.9-3.8.4-5.1-1.1l-3.6-4.2c-1.1-1.3-1.3-3.1-.7-4.7l2.2-5.1c.4-.8 1.1-1.5 1.9-2.1Zm8.2 2.9c-4.4 1.4-6.7 4.8-5.2 7.9.7 1.4 2 2.3 3.7 2.7-1.5-1.9-2.2-3.4-1.6-5.2.5-1.9 2-3.7 3.1-5.4Z","fill":"currentColor","fill-rule":"evenodd"}]],
    design: {
      rest: "填充剪影和镂空保持原身份，与细线图标区分",
      motion: { kind: "still", animation: "none", description: "特殊填充几何或身份不应套循环、禁止遮罩或斜杠。", trigger: "原工具/resize/身份槽职责，不存在可泛化的busy事实" }
    }
  },
  "process-live": {
    shapes: [["rect",{"x":"3","y":"4","width":"18","height":"16","rx":"3"}],["path",{"d":"M9 8l7 4-7 4Z"}]],
    design: {
      rest: "窗口内播放形；表示process running，不等于正在产出",
      motion: { kind: "still", animation: "none", description: "存活、空闲、排队、终止、未知或需要输入均不等价于正在工作。永久循环会误导，原正文/动作仍准确。", trigger: "沿原已确认状态或控件值显示；存活、排队、未知等事实不自动启用动画。" }
    }
  },
  "process-idle": {
    shapes: [["rect",{"x":"3","y":"4","width":"18","height":"16","rx":"3"}],["path",{"d":"M8 12h8"}]],
    design: {
      rest: "窗口内短横，外框与process-live同族",
      motion: { kind: "still", animation: "none", description: "存活、空闲、排队、终止、未知或需要输入均不等价于正在工作。永久循环会误导，原正文/动作仍准确。", trigger: "沿原已确认状态或控件值显示；存活、排队、未知等事实不自动启用动画。" }
    }
  },
  "activity-unconfirmed": {
    shapes: [["path",{"d":"M8 4H6a3 3 0 0 0-3 3v3 M16 4h2a3 3 0 0 1 3 3v3 M3 14v3a3 3 0 0 0 3 3h2 M21 14v3a3 3 0 0 1-3 3h-2"}]],
    design: {
      rest: "同族窗口尺度的四角未闭合观测框；空心留白表示活动未确认，不借 Idle 横线或普通 presence 空圆",
      motion: { kind: "still", animation: "none", description: "不确定或不支持报告不是加载、工作或需要输入；保完整静止四角，不旋转、闪动或补造活动。", trigger: "原调用方已将当前活动资格投影为未知或不支持报告；不表示 Run 不存在或已中断。" }
    }
  },
  "process-interrupted": {
    shapes: [["rect",{"x":"3","y":"4","width":"18","height":"16","rx":"3"}],["path",{"d":"M6.5 10h3.5 M14 14h3.5"}]],
    design: {
      rest: "原进程框内两段明确断开、略错位的水平轨迹；保连续性中断含义，不借 Stop 方块、暂停双线或失败叉",
      motion: { kind: "still", animation: "none", description: "中断是原运行事实，不是正在恢复或自动重试；两段轨迹保持静止，不补造原因或进度。", trigger: "沿原 owner 已确认的 interrupted Run／进程投影；不能从观察失败或文案猜中断。" }
    }
  },
  "operation-wait": {
    shapes: [["path",{"d":"M6 3h12 M6 21h12 M7 3v4c0 2 3 3 5 5-2 2-5 3-5 5v4 M17 3v4c0 2-3 3-5 5 2 2 5 3 5 5v4","data-semantic-icon-part":"hourglass-frame"}],["path",{"d":"M8.5 6h7c0 2-1.75 3.5-3.5 5.25C10.25 9.5 8.5 8 8.5 6Z","fill":"currentColor","stroke":"none","data-semantic-icon-part":"hourglass-upper"}],["path",{"d":"M8.5 18h7c0-2-1.75-3.5-3.5-5.25C10.25 14.5 8.5 16 8.5 18Z","fill":"currentColor","stroke":"none","transform":"translate(0 18) scale(1 0) translate(0 -18)","data-semantic-icon-part":"hourglass-lower"}],["circle",{"cx":"12","cy":"12","r":".55","fill":"currentColor","stroke":"none","opacity":"0","data-semantic-icon-part":"hourglass-grain"}]],
    design: {
      rest: "沙漏外框、上沙、下沙、颗粒分部；静止上满下空",
      motion: { kind: "loop", animation: "wait", description: "上沙减少/下沙增加/颗粒落下，耗尽停顿后框和沙一起短翻面；大部分周期外框固定", trigger: "原等待面确认 busy、visible 且非 parked 时显式选择；不是进度或倒计时。" }
    }
  },
  "input-needed": {
    shapes: [["path",{"d":"M19 4H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2v3l5-3h7a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Z M7 9h5 M16 8v6"}]],
    design: {
      rest: "对话框与输入提示竖线，保可回答含义",
      motion: { kind: "still", animation: "none", description: "存活、空闲、排队、终止、未知或需要输入均不等价于正在工作。永久循环会误导，原正文/动作仍准确。", trigger: "沿原已确认状态或控件值显示；存活、排队、未知等事实不自动启用动画。" }
    }
  },
  "terminal-reading": {
    shapes: [["rect",{"x":"3","y":"4","width":"18","height":"16","rx":"2"}],["path",{"d":"M7 8l3 3-3 3 M13 9h4 M13 14h4"}]],
    design: {
      rest: "终端框、prompt和行文；区别字体大小与输入执行",
      motion: { kind: "still", animation: "none", description: "当前消费表达对象/记录或入口，未提供持续活动事实；实际面板/选中/布局变化已表达动作结果，保持图标静止减少重复反馈。", trigger: "沿现有对象身份、分类、导航、记录或工具入口；hover/focus沿宿主短反馈" }
    }
  },
  "diff-fold-lines": {
    shapes: [["path",{"d":"M4 4h16 M4 8h5 M4 16h5 M4 20h16 M15 9l-3 3 3 3"}]],
    design: {
      rest: "上下行与内收箭头；压缩中段而非地图",
      motion: { kind: "still", animation: "none", description: "图形经实际CSS mask投影，无独立内部部位；真实内容/折叠/缩放变化已经给出结果，静止图标更清楚。", trigger: "原Monaco/Excalidraw控件值与动作；不新增内部动画renderer" }
    }
  },
  "demonstration-edit": {
    shapes: [["path",{"d":"M10 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4 M3 9h12"}],["path",{"d":"M12 21l1-4 6-6 3 3-6 6Z","data-semantic-icon-part":"demonstration-pen"}]],
    design: {
      rest: "浏览器页框+独立斜笔，不与创建加号混淆",
      motion: { kind: "once", animation: "feedback", description: "仅编辑笔一次短划后回静止，页面框固定", trigger: "原目标编辑舞台确认进入后可单次反馈；点击或 onImport 回调不证明已编辑或保存。" }
    }
  },
  "project-manage": {
    shapes: [["path",{"d":"M3 7V5h6l3 3h9v12H3Z M7 12h10 M7 16h10 M10 10v4 M14 14v4"}]],
    design: {
      rest: "文件夹与两个调节柄，区别新建项目",
      motion: { kind: "still", animation: "none", description: "当前消费表达对象/记录或入口，未提供持续活动事实；实际面板/选中/布局变化已表达动作结果，保持图标静止减少重复反馈。", trigger: "沿现有对象身份、分类、导航、记录或工具入口；hover/focus沿宿主短反馈" }
    }
  },
  "idea-bulb": {
    shapes: [["path",{"d":"M9 18h6 M10 21h4 M8 15a7 7 0 1 1 8 0l-1 3H9Z"}]],
    design: {
      rest: "灯泡轮廓和灯座，静态即可读构思",
      motion: { kind: "still", animation: "none", description: "当前消费表达对象/记录或入口，未提供持续活动事实；实际面板/选中/布局变化已表达动作结果，保持图标静止减少重复反馈。", trigger: "沿现有对象身份、分类、导航、记录或工具入口；hover/focus沿宿主短反馈" }
    }
  },
  "assignee-select": {
    shapes: [["circle",{"cx":"9","cy":"7","r":"4"}],["path",{"d":"M2 21v-2a7 7 0 0 1 12-5 M15 18l2 2 5-6"}]],
    design: {
      rest: "人物与勾选尾部，区别创建人",
      motion: { kind: "still", animation: "none", description: "当前消费表达对象/记录或入口，未提供持续活动事实；实际面板/选中/布局变化已表达动作结果，保持图标静止减少重复反馈。", trigger: "沿现有对象身份、分类、导航、记录或工具入口；hover/focus沿宿主短反馈" }
    }
  },
  "layout-active-first": {
    shapes: [["rect",{"x":"3","y":"4","width":"11","height":"16","rx":"1.5"}],["rect",{"x":"17","y":"4","width":"4","height":"7","rx":"1"}],["rect",{"x":"17","y":"14","width":"4","height":"6","rx":"1"}],["rect",{"x":"6","y":"7","width":"5","height":"10","rx":".5","fill":"currentColor","stroke":"none"}]],
    design: {
      rest: "突出当前主区与旁侧次区，表示当前优先布局；示意比例而不承诺格数",
      motion: { kind: "still", animation: "none", description: "方向、格局与比例在小尺寸保持完整静止轮廓；原菜单的 hover、focus 与动作结果提供反馈。", trigger: "按原布局动作显示；图形不表示执行、当前选择或操作回执。" }
    }
  },
  "layout-six": {
    shapes: [["rect",{"x":"3","y":"4","width":"18","height":"16","rx":"2"}],["line",{"x1":"9","y1":"4","x2":"9","y2":"20"}],["line",{"x1":"15","y1":"4","x2":"15","y2":"20"}],["line",{"x1":"3","y1":"12","x2":"21","y2":"12"}]],
    design: {
      rest: "严格3列×2行；统一外框、笔触和留白",
      motion: { kind: "still", animation: "none", description: "方向、格局与比例在小尺寸保持完整静止轮廓；原菜单的 hover、focus 与动作结果提供反馈。", trigger: "按原布局动作显示；图形不表示执行、当前选择或操作回执。" }
    }
  },
  "file-styles": {
    shapes: [["path",{"d":"M5 3h9l5 5v13H5Z M14 3v5h5"}],["path",{"d":"M8 12h8 M8 17h8 M11 10v4 M14 15v4"}]],
    design: {
      rest: "折角纸页和调节柄，区别普通code与已保存设置",
      motion: { kind: "still", animation: "none", description: "文件类别在长期列表和标题中不变；打开/加载/失败反馈留原宿主，不让类别自己循环。", trigger: "按原文件分类显示；读取、执行和失败反馈由原宿主表达，保持静止。" }
    }
  },
  "system-open": {
    shapes: [["path",{"d":"M11 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-5 M3 9h7 M14 3h7v7 M21 3l-9 9"}]],
    design: {
      rest: "窗口外框和向外箭头，方向明确",
      motion: { kind: "still", animation: "none", description: "当前消费表达对象/记录或入口，未提供持续活动事实；实际面板/选中/布局变化已表达动作结果，保持图标静止减少重复反馈。", trigger: "沿现有对象身份、分类、导航、记录或工具入口；hover/focus沿宿主短反馈" }
    }
  },
  "message-reply": {
    shapes: [["path",{"d":"M20 20v-5a6 6 0 0 0-6-6H3 M8 4 3 9l5 5"}]],
    design: {
      rest: "折回箭头表达reply，不是发送成功勾",
      motion: { kind: "still", animation: "none", description: "当前消费表达对象/记录或入口，未提供持续活动事实；实际面板/选中/布局变化已表达动作结果，保持图标静止减少重复反馈。", trigger: "沿现有对象身份、分类、导航、记录或工具入口；hover/focus沿宿主短反馈" }
    }
  },
  "devices-network": {
    shapes: [["rect",{"x":"2","y":"4","width":"13","height":"10","rx":"2"}],["rect",{"x":"18","y":"10","width":"4","height":"11","rx":"1"}],["path",{"d":"M5 19h7 M8 14v5 M15 9h5v1"}]],
    design: {
      rest: "桌面屏和手机以连线相接，表示设备关系而非在线",
      motion: { kind: "still", animation: "none", description: "当前消费表达对象/记录或入口，未提供持续活动事实；实际面板/选中/布局变化已表达动作结果，保持图标静止减少重复反馈。", trigger: "沿现有对象身份、分类、导航、记录或工具入口；hover/focus沿宿主短反馈" }
    }
  },
  "message-history": {
    shapes: [["path",{"d":"M5 8V4h16v12h-4 M3 8h14v11H8l-5 3Z M6 12h8 M6 15h5"}]],
    design: {
      rest: "两页对话叠置；区别当前流式回复",
      motion: { kind: "still", animation: "none", description: "当前消费表达对象/记录或入口，未提供持续活动事实；实际面板/选中/布局变化已表达动作结果，保持图标静止减少重复反馈。", trigger: "沿现有对象身份、分类、导航、记录或工具入口；hover/focus沿宿主短反馈" }
    }
  },
  "view-reset": {
    shapes: [["path",{"d":"M3 9V3h6 M15 3h6v6 M21 15v6h-6 M9 21H3v-6"}],["circle",{"cx":"12","cy":"12","r":"3"}]],
    design: {
      rest: "四角界限和中点，表示回到视图，不等同恢复数据",
      motion: { kind: "still", animation: "none", description: "图形经实际CSS mask投影，无独立内部部位；真实内容/折叠/缩放变化已经给出结果，静止图标更清楚。", trigger: "原Monaco/Excalidraw控件值与动作；不新增内部动画renderer" }
    }
  },
  "system-panel": {
    shapes: [["rect",{"x":"3","y":"4","width":"18","height":"16","rx":"2"}],["path",{"d":"M3 9h18 M7 14h3 M14 14h3 M7 17h10"}]],
    design: {
      rest: "窗口框、顶栏和短行；是系统作者身份",
      motion: { kind: "still", animation: "none", description: "当前消费表达对象/记录或入口，未提供持续活动事实；实际面板/选中/布局变化已表达动作结果，保持图标静止减少重复反馈。", trigger: "沿现有对象身份、分类、导航、记录或工具入口；hover/focus沿宿主短反馈" }
    }
  },
  "symbol-constructor": {
    shapes: [["rect",{"x":"4","y":"4","width":"16","height":"16","rx":"2"}],["path",{"d":"M8 12h8 M12 8v8"}]],
    design: {
      rest: "方框内加号是构造约定，不能当创建按钮",
      motion: { kind: "still", animation: "none", description: "类型库存必须快速扫描；CSS mask仅负责绘图，实际hover/suggest控制由Monaco保留。", trigger: "由原编辑器提供类型；不表示执行、取值或选择资格，保持静止。" }
    }
  },
  "symbol-function": {
    shapes: [["path",{"d":"M17 4h-4a3 3 0 0 0-3 3v10a3 3 0 0 1-3 3H5 M6 10h10"}]],
    design: {
      rest: "函数f形；function-variable共享同形是类型库存",
      motion: { kind: "still", animation: "none", description: "类型库存必须快速扫描；CSS mask仅负责绘图，实际hover/suggest控制由Monaco保留。", trigger: "由原编辑器提供类型；不表示执行、取值或选择资格，保持静止。" }
    }
  },
  "symbol-method": {
    shapes: [["path",{"d":"M19 4h-4a3 3 0 0 0-3 3v10a3 3 0 0 1-3 3H7 M8 10h10"}],["circle",{"cx":"4","cy":"10","r":"1"}]],
    design: {
      rest: "函数形加左侧节点区分method",
      motion: { kind: "still", animation: "none", description: "类型库存必须快速扫描；CSS mask仅负责绘图，实际hover/suggest控制由Monaco保留。", trigger: "由原编辑器提供类型；不表示执行、取值或选择资格，保持静止。" }
    }
  },
  "symbol-class": {
    shapes: [["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}],["path",{"d":"M16 8h-5a3 3 0 0 0-3 3v2a3 3 0 0 0 3 3h5"}]],
    design: {
      rest: "容器内C式轮廓，与constructor/interface分开",
      motion: { kind: "still", animation: "none", description: "类型库存必须快速扫描；CSS mask仅负责绘图，实际hover/suggest控制由Monaco保留。", trigger: "由原编辑器提供类型；不表示执行、取值或选择资格，保持静止。" }
    }
  },
  "symbol-interface": {
    shapes: [["path",{"d":"M7 3H3v18h4 M17 3h4v18h-4 M10 7h4 M12 7v10 M10 17h4"}]],
    design: {
      rest: "两侧界限与I线条，保开口",
      motion: { kind: "still", animation: "none", description: "类型库存必须快速扫描；CSS mask仅负责绘图，实际hover/suggest控制由Monaco保留。", trigger: "由原编辑器提供类型；不表示执行、取值或选择资格，保持静止。" }
    }
  },
  "symbol-struct": {
    shapes: [["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}],["path",{"d":"M3 9h18 M3 15h18 M10 9v12"}]],
    design: {
      rest: "格状容器分区，区别class",
      motion: { kind: "still", animation: "none", description: "类型库存必须快速扫描；CSS mask仅负责绘图，实际hover/suggest控制由Monaco保留。", trigger: "由原编辑器提供类型；不表示执行、取值或选择资格，保持静止。" }
    }
  },
  "symbol-variable": {
    shapes: [["path",{"d":"M6 6l12 12 M18 6 6 18"}]],
    design: {
      rest: "交叉x为变量约定，非错误叉",
      motion: { kind: "still", animation: "none", description: "类型库存必须快速扫描；CSS mask仅负责绘图，实际hover/suggest控制由Monaco保留。", trigger: "由原编辑器提供类型；不表示执行、取值或选择资格，保持静止。" }
    }
  },
  "symbol-field": {
    shapes: [["rect",{"x":"3","y":"6","width":"18","height":"12","rx":"2"}],["path",{"d":"M9 6v12 M13 12h4"}]],
    design: {
      rest: "分栏字段框和短值槽",
      motion: { kind: "still", animation: "none", description: "类型库存必须快速扫描；CSS mask仅负责绘图，实际hover/suggest控制由Monaco保留。", trigger: "由原编辑器提供类型；不表示执行、取值或选择资格，保持静止。" }
    }
  },
  "symbol-property": {
    shapes: [["path",{"d":"M4 6h16 M4 18h16 M8 4v4 M16 16v4"}],["circle",{"cx":"12","cy":"12","r":"2"}]],
    design: {
      rest: "两条属性线、端标与中心圆",
      motion: { kind: "still", animation: "none", description: "类型库存必须快速扫描；CSS mask仅负责绘图，实际hover/suggest控制由Monaco保留。", trigger: "由原编辑器提供类型；不表示执行、取值或选择资格，保持静止。" }
    }
  },
  "symbol-module": {
    shapes: [["rect",{"x":"3","y":"5","width":"14","height":"14","rx":"2"}],["path",{"d":"M17 9h4 M17 15h4 M7 9h6 M7 15h6"}]],
    design: {
      rest: "模块盒与右侧接口短线",
      motion: { kind: "still", animation: "none", description: "类型库存必须快速扫描；CSS mask仅负责绘图，实际hover/suggest控制由Monaco保留。", trigger: "由原编辑器提供类型；不表示执行、取值或选择资格，保持静止。" }
    }
  },
  "symbol-namespace": {
    shapes: [["path",{"d":"M6 3H3v18h3 M18 3h3v18h-3"}],["rect",{"x":"7","y":"7","width":"10","height":"4","rx":"1"}],["rect",{"x":"7","y":"15","width":"10","height":"2"}]],
    design: {
      rest: "外侧括界包住两个成员条",
      motion: { kind: "still", animation: "none", description: "类型库存必须快速扫描；CSS mask仅负责绘图，实际hover/suggest控制由Monaco保留。", trigger: "由原编辑器提供类型；不表示执行、取值或选择资格，保持静止。" }
    }
  },
  "symbol-enum": {
    shapes: [["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}],["path",{"d":"M8 7h9 M8 12h6 M8 17h9 M8 7v10"}]],
    design: {
      rest: "E式三档列表在容器内",
      motion: { kind: "still", animation: "none", description: "类型库存必须快速扫描；CSS mask仅负责绘图，实际hover/suggest控制由Monaco保留。", trigger: "由原编辑器提供类型；不表示执行、取值或选择资格，保持静止。" }
    }
  },
  "symbol-enum-member": {
    shapes: [["path",{"d":"M4 4h16 M4 9h16 M4 20h16"}],["rect",{"x":"4","y":"13","width":"16","height":"3","rx":"1"}]],
    design: {
      rest: "多条同级线中一条有框",
      motion: { kind: "still", animation: "none", description: "类型库存必须快速扫描；CSS mask仅负责绘图，实际hover/suggest控制由Monaco保留。", trigger: "由原编辑器提供类型；不表示执行、取值或选择资格，保持静止。" }
    }
  },
  "symbol-string": {
    shapes: [["path",{"d":"M4 9V5h4v4 M16 9V5h4v4 M7 15h10"}]],
    design: {
      rest: "引号与基线，字串约定",
      motion: { kind: "still", animation: "none", description: "类型库存必须快速扫描；CSS mask仅负责绘图，实际hover/suggest控制由Monaco保留。", trigger: "由原编辑器提供类型；不表示执行、取值或选择资格，保持静止。" }
    }
  },
  "symbol-type-parameter": {
    shapes: [["path",{"d":"M5 6 2 12l3 6 M19 6l3 6-3 6 M8 7h8 M12 7v10"}]],
    design: {
      rest: "两侧尖括号与T",
      motion: { kind: "still", animation: "none", description: "类型库存必须快速扫描；CSS mask仅负责绘图，实际hover/suggest控制由Monaco保留。", trigger: "由原编辑器提供类型；不表示执行、取值或选择资格，保持静止。" }
    }
  },
  "symbol-boolean": {
    shapes: [["rect",{"x":"3","y":"6","width":"18","height":"12","rx":"6"}],["circle",{"cx":"9","cy":"12","r":"3"}]],
    design: {
      rest: "胶囊内圆是boolean类型约定",
      motion: { kind: "still", animation: "none", description: "类型库存必须快速扫描；CSS mask仅负责绘图，实际hover/suggest控制由Monaco保留。", trigger: "由原编辑器提供类型；不表示执行、取值或选择资格，保持静止。" }
    }
  },
  "symbol-constant": {
    shapes: [["path",{"d":"M17 6h-7a4 4 0 0 0-4 4v4a4 4 0 0 0 4 4h7 M4 21h16"}]],
    design: {
      rest: "C式常量轮廓与底线",
      motion: { kind: "still", animation: "none", description: "类型库存必须快速扫描；CSS mask仅负责绘图，实际hover/suggest控制由Monaco保留。", trigger: "由原编辑器提供类型；不表示执行、取值或选择资格，保持静止。" }
    }
  },
  "symbol-object": {
    shapes: [["path",{"d":"M8 3H6v7l-3 2 3 2v7h2 M16 3h2v7l3 2-3 2v7h-2 M10 12h4"}]],
    design: {
      rest: "大括号与中心短线",
      motion: { kind: "still", animation: "none", description: "类型库存必须快速扫描；CSS mask仅负责绘图，实际hover/suggest控制由Monaco保留。", trigger: "由原编辑器提供类型；不表示执行、取值或选择资格，保持静止。" }
    }
  },
  "symbol-keyword": {
    shapes: [["path",{"d":"M6 4v14 M17 4l-9 7 9 7 M4 22h16"}]],
    design: {
      rest: "K式字形与底线",
      motion: { kind: "still", animation: "none", description: "类型库存必须快速扫描；CSS mask仅负责绘图，实际hover/suggest控制由Monaco保留。", trigger: "由原编辑器提供类型；不表示执行、取值或选择资格，保持静止。" }
    }
  },
  "symbol-reference": {
    shapes: [["path",{"d":"M19 14v7H5V3h7 M15 3h6v6 M21 3l-9 9"}]],
    design: {
      rest: "纸页与向外引用箭头",
      motion: { kind: "still", animation: "none", description: "类型库存必须快速扫描；CSS mask仅负责绘图，实际hover/suggest控制由Monaco保留。", trigger: "由原编辑器提供类型；不表示执行、取值或选择资格，保持静止。" }
    }
  },
  "source-review": {
    shapes: [["path",{"d":"M10 21H5V3h11v5 M8 7h4"}],["circle",{"cx":"16","cy":"14","r":"4"}],["path",{"d":"M19 17l3 4"}]],
    design: {
      rest: "纸页与放大镜，和编辑笔区分",
      motion: { kind: "still", animation: "none", description: "当前消费表达对象/记录或入口，未提供持续活动事实；实际面板/选中/布局变化已表达动作结果，保持图标静止减少重复反馈。", trigger: "沿现有对象身份、分类、导航、记录或工具入口；hover/focus沿宿主短反馈" }
    }
  },
  "annotation-add": {
    shapes: [["path",{"d":"M12 3H4v18h16v-8 M4 15h6"}],["path",{"d":"M17 3v8 M13 7h8","data-semantic-icon-part":"feedback-mark"}]],
    design: {
      rest: "带文字页与局部加号，非开始录制",
      motion: { kind: "once", animation: "feedback", description: "仅加号短笔画展开并归位一次，纸页轮廓固定", trigger: "原 annotation owner 确认新标注加入当前草稿后可单次反馈；不表示已持久保存。" }
    }
  },
  "quick-reply-add": {
    shapes: [["path",{"d":"M11 4H3v13h4v4l5-4h9v-4"}],["path",{"d":"M16 3v8 M12 7h8","data-semantic-icon-part":"feedback-mark"}]],
    design: {
      rest: "对话框与局部加号，区别添加文件",
      motion: { kind: "once", animation: "feedback", description: "仅对话框加号一次短展开，对话框不跳动", trigger: "原配置 owner 确认新增编辑面打开或新项加入后可单次反馈；打开与保存分别表达。" }
    }
  },
  "path-copy": {
    shapes: [["path",{"d":"M8 8h13v13H8Z M16 8V3H3v13h5 M12 17l5-5"}]],
    design: {
      rest: "叠页+斜路径笔画，区别空间地址",
      motion: { kind: "still", animation: "none", description: "复制成功由原writeClipboardText实际回执/原反馈承接；失败不因图标预播变成功。后续若已有稳定copy反馈宿主，可复用direction-once，当前不增加。", trigger: "实际复制菜单默认静止；当前菜单闭合后无稳定动画宿主，不新留菜单制造反馈" }
    }
  },
  "address-copy": {
    shapes: [["path",{"d":"M8 8h13v13H8Z M16 8V3H3v13h5 M12 17h5 M12 13h5"}]],
    design: {
      rest: "叠页与水平地址行，区别文件路径",
      motion: { kind: "still", animation: "none", description: "复制成功由原writeClipboardText实际回执/原反馈承接；失败不因图标预播变成功。后续若已有稳定copy反馈宿主，可复用direction-once，当前不增加。", trigger: "实际复制菜单默认静止；当前菜单闭合后无稳定动画宿主，不新留菜单制造反馈" }
    }
  },
  "context-pages": {
    shapes: [["path",{"d":"M7 7h14v14H7Z M17 7V3H3v14h4 M11 11h6 M11 16h6"}]],
    design: {
      rest: "两页叠放及正文线，纯对象库存",
      motion: { kind: "still", animation: "none", description: "当前消费表达对象/记录或入口，未提供持续活动事实；实际面板/选中/布局变化已表达动作结果，保持图标静止减少重复反馈。", trigger: "沿现有对象身份、分类、导航、记录或工具入口；hover/focus沿宿主短反馈" }
    }
  },
  "skill-guide": {
    shapes: [["path",{"d":"M5 3h14v18H5Z M8 7h8 M8 11h8 M8 16l2 2 5-4"}]],
    design: {
      rest: "指南页、行文与检查记号，表达指导材料",
      motion: { kind: "still", animation: "none", description: "当前消费表达对象/记录或入口，未提供持续活动事实；实际面板/选中/布局变化已表达动作结果，保持图标静止减少重复反馈。", trigger: "沿现有对象身份、分类、导航、记录或工具入口；hover/focus沿宿主短反馈" }
    }
  },
  "slash-command": {
    shapes: [["path",{"d":"M9 3 4 21 M14 7l6 5-6 5"}]],
    design: {
      rest: "斜杠+prompt尖角，是命令类别",
      motion: { kind: "still", animation: "none", description: "当前消费表达对象/记录或入口，未提供持续活动事实；实际面板/选中/布局变化已表达动作结果，保持图标静止减少重复反馈。", trigger: "沿现有对象身份、分类、导航、记录或工具入口；hover/focus沿宿主短反馈" }
    }
  },
  "tool-invoke": {
    shapes: [["path",{"d":"M13 3 21 7.5v9L13 21l-5-3v-3 M8 9V6l5-3 M2 12h12 M10 8l4 4-4 4"}]],
    design: {
      rest: "右侧通用工具模块与进入模块的请求箭头；不限定为终端或某一种工具",
      motion: { kind: "still", animation: "none", description: "调用记录保持完整静止；记录出现不代表仍在执行，箭头只表达输入方向。", trigger: "原结构明确为工具调用记录；不从工具名、输入或展示文案推断当前执行。" }
    }
  },
  "tool-return": {
    shapes: [["path",{"d":"M11 3 3 7.5v9L11 21l5-3v-3 M16 9V6l-5-3 M10 12h12 M18 8l4 4-4 4"}]],
    design: {
      rest: "左侧同族工具模块与离开模块的结果箭头；不使用表示成功的勾选",
      motion: { kind: "still", animation: "none", description: "结果记录保持完整静止；返回内容不等于成功，不补推完成或配对关系。", trigger: "原结构明确为工具结果记录；明确失败仍由原失败状态与原因表达。" }
    }
  },
  "input-tools": {
    shapes: [["rect",{"x":"3","y":"4","width":"18","height":"16","rx":"2"}],["path",{"d":"M7 9h10 M3 14h18 M8 14v6 M16 14v6"}]],
    design: {
      rest: "分栏输入框与两格底栏",
      motion: { kind: "still", animation: "none", description: "当前消费表达对象/记录或入口，未提供持续活动事实；实际面板/选中/布局变化已表达动作结果，保持图标静止减少重复反馈。", trigger: "沿现有对象身份、分类、导航、记录或工具入口；hover/focus沿宿主短反馈" }
    }
  },
  "process-stopped": {
    shapes: [["circle",{"cx":"12","cy":"12","r":"9"}],["rect",{"x":"8","y":"8","width":"8","height":"8","rx":"1"}]],
    design: {
      rest: "圆内方块，静止终态明确",
      motion: { kind: "still", animation: "none", description: "存活、空闲、排队、终止、未知或需要输入均不等价于正在工作。永久循环会误导，原正文/动作仍准确。", trigger: "沿原已确认状态或控件值显示；存活、排队、未知等事实不自动启用动画。" }
    }
  },
  "queue-pending": {
    shapes: [["rect",{"x":"3","y":"4","width":"14","height":"4","rx":"1"}],["rect",{"x":"5","y":"10","width":"14","height":"4","rx":"1"}],["rect",{"x":"7","y":"16","width":"14","height":"4","rx":"1"}]],
    design: {
      rest: "三条错位队列卡，保持先后",
      motion: { kind: "still", animation: "none", description: "存活、空闲、排队、终止、未知或需要输入均不等价于正在工作。永久循环会误导，原正文/动作仍准确。", trigger: "沿原已确认状态或控件值显示；存活、排队、未知等事实不自动启用动画。" }
    }
  },
  "topic-card": {
    shapes: [["path",{"d":"M4 4h16v12H9l-5 5Z M8 8h8 M8 12h5"}]],
    design: {
      rest: "对话卡片与正文线，有对象轮廓",
      motion: { kind: "still", animation: "none", description: "当前消费表达对象/记录或入口，未提供持续活动事实；实际面板/选中/布局变化已表达动作结果，保持图标静止减少重复反馈。", trigger: "沿现有对象身份、分类、导航、记录或工具入口；hover/focus沿宿主短反馈" }
    }
  },
  "tab-item": {
    shapes: [["path",{"d":"M3 8h18v13H3Z M4 8V3h8v5 M15 5h5v3"}]],
    design: {
      rest: "下方主面与上方标签，区分Region",
      motion: { kind: "still", animation: "none", description: "当前消费表达对象/记录或入口，未提供持续活动事实；实际面板/选中/布局变化已表达动作结果，保持图标静止减少重复反馈。", trigger: "沿现有对象身份、分类、导航、记录或工具入口；hover/focus沿宿主短反馈" }
    }
  },
  "zone-group": {
    shapes: [["path",{"d":"M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5"}],["rect",{"x":"8","y":"8","width":"8","height":"8","rx":"1"}]],
    design: {
      rest: "四角包住中心面，表示分组空间",
      motion: { kind: "still", animation: "none", description: "当前消费表达对象/记录或入口，未提供持续活动事实；实际面板/选中/布局变化已表达动作结果，保持图标静止减少重复反馈。", trigger: "沿现有对象身份、分类、导航、记录或工具入口；hover/focus沿宿主短反馈" }
    }
  },
  "topology-nodes": {
    shapes: [["rect",{"x":"8","y":"3","width":"8","height":"5","rx":"1"}],["rect",{"x":"2","y":"16","width":"7","height":"5","rx":"1"}],["rect",{"x":"15","y":"16","width":"7","height":"5","rx":"1"}],["path",{"d":"M12 8v4 M5 16v-4h14v4"}]],
    design: {
      rest: "一父两子与连接，表达结构不等于实时拓扑图",
      motion: { kind: "still", animation: "none", description: "当前消费表达对象/记录或入口，未提供持续活动事实；实际面板/选中/布局变化已表达动作结果，保持图标静止减少重复反馈。", trigger: "沿现有对象身份、分类、导航、记录或工具入口；hover/focus沿宿主短反馈" }
    }
  },
  "region-panel": {
    shapes: [["rect",{"x":"3","y":"4","width":"18","height":"16","rx":"2"}],["path",{"d":"M7 8h10 M7 12h4"}]],
    design: {
      rest: "带短行的面板矩形，是空间显示位",
      motion: { kind: "still", animation: "none", description: "当前消费表达对象/记录或入口，未提供持续活动事实；实际面板/选中/布局变化已表达动作结果，保持图标静止减少重复反馈。", trigger: "沿现有对象身份、分类、导航、记录或工具入口；hover/focus沿宿主短反馈" }
    }
  },
  "process-stack": {
    shapes: [["path",{"d":"M6 4h15v13 M3 7h15v14H3Z M8 11l5 3-5 3Z"}]],
    design: {
      rest: "后叠窗口与前层play形，表示集合",
      motion: { kind: "still", animation: "none", description: "当前消费表达对象/记录或入口，未提供持续活动事实；实际面板/选中/布局变化已表达动作结果，保持图标静止减少重复反馈。", trigger: "沿现有对象身份、分类、导航、记录或工具入口；hover/focus沿宿主短反馈" }
    }
  },
  "project-folder": {
    shapes: [["path",{"d":"M3 6V4h7l3 4h8v13H3Z M8 12l-2 3 2 3 M16 12l2 3-2 3"}]],
    design: {
      rest: "文件夹与左右code尖角，项目类别",
      motion: { kind: "still", animation: "none", description: "当前消费表达对象/记录或入口，未提供持续活动事实；实际面板/选中/布局变化已表达动作结果，保持图标静止减少重复反馈。", trigger: "沿现有对象身份、分类、导航、记录或工具入口；hover/focus沿宿主短反馈" }
    }
  },
  "prompt-sheet": {
    shapes: [["path",{"d":"M5 3h9l5 5v13H5Z M14 3v5h5"}],["path",{"d":"M8 12h4 M15 11v7 M8 17h3"}]],
    design: {
      rest: "折角纸页与局部输入竖线",
      motion: { kind: "still", animation: "none", description: "当前消费表达对象/记录或入口，未提供持续活动事实；实际面板/选中/布局变化已表达动作结果，保持图标静止减少重复反馈。", trigger: "沿现有对象身份、分类、导航、记录或工具入口；hover/focus沿宿主短反馈" }
    }
  },
  "session-resume": {
    shapes: [["path",{"d":"M3 8V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2"}],["path",{"d":"M2 12h12 M10 8l4 4-4 4","data-semantic-icon-part":"feedback-forward","pathLength":"1"}]],
    design: {
      rest: "原窗口与向内箭头，强调进入原身份",
      motion: { kind: "once", animation: "feedback", description: "只沿进入原窗口的箭头短描一次后静止，窗口轮廓固定", trigger: "原 Core 恢复回执确认原 Session 可用后可单次反馈；pending 不表示恢复完成。" }
    }
  },
  "terminal-restart": {
    shapes: [["path",{"d":"M21 10V4H3v16h8 M7 8l3 3-3 3 M21 13v4h-4"}],["path",{"d":"M20 17a5 5 0 1 0 0 4","data-semantic-icon-part":"feedback-trace","pathLength":"1"}]],
    design: {
      rest: "终端外框/prompt与独立回转弧",
      motion: { kind: "once", animation: "feedback", description: "仅独立回转弧一次短回转/落定，prompt和窗口固定", trigger: "原 Core 重启回执已应用且原工作面绑定可核对后可单次反馈；保原身份与失败路径。" }
    }
  },
  "handoff-agent": {
    shapes: [["path",{"d":"M2 9h8 M6 5l4 4-4 4","data-semantic-icon-part":"feedback-forward","pathLength":"1"}],["rect",{"x":"12","y":"8","width":"9","height":"12","rx":"2"}],["path",{"d":"M16.5 4v4 M15 17h3"}],["circle",{"cx":"15","cy":"13","r":".4"}],["circle",{"cx":"18","cy":"13","r":".4"}]],
    design: {
      rest: "向机器人箭头，保机器人身份",
      motion: { kind: "once", animation: "feedback", description: "仅短描左侧交接箭头一次；机器脸与外壳静止", trigger: "原 Browser owner 确认对应 operation 控制已返回 Agent 后可单次反馈；点击不授予控制。" }
    }
  },
  "operation-replay": {
    shapes: [["path",{"d":"M4 9a9 9 0 1 1 0 7 M3 3v6h6 M10 8l6 4-6 4Z"}]],
    design: {
      rest: "回转箭头与play，当前用于预览标题",
      motion: { kind: "still", animation: "none", description: "当前消费表达对象/记录或入口，未提供持续活动事实；实际面板/选中/布局变化已表达动作结果，保持图标静止减少重复反馈。", trigger: "沿现有对象身份、分类、导航、记录或工具入口；hover/focus沿宿主短反馈" }
    }
  },
  "defaults-restore": {
    shapes: [["path",{"d":"M4 12a8 8 0 1 1 2 6","data-semantic-icon-part":"feedback-trace","pathLength":"1"}],["path",{"d":"M3 5v7h7 M10 8h6 M12 6v4 M9 15h7 M14 13v4"}]],
    design: {
      rest: "回转弧与调节柄，区别回放执行",
      motion: { kind: "once", animation: "feedback", description: "仅外侧恢复弧短回转一次，调节柄稳定停到原默认轮廓", trigger: "原选择 owner 确认默认或 automatic 已应用后可单次反馈；不代签存盘。" }
    }
  },
  "remote-fetch": {
    shapes: [["path",{"d":"M3 4h18v6H3Z"}],["path",{"d":"M12 11v10 M8 17l4 4 4-4","data-semantic-icon-part":"feedback-down","pathLength":"1"}]],
    design: {
      rest: "远端条与向下传输箭头，非拉取合并",
      motion: { kind: "once", animation: "feedback", description: "只沿下载箭头短描一次，远端条不动", trigger: "原 Git fetch 回执成功且仓库读数已应用后可单次反馈；不等于 pull 或 merge。" }
    }
  },
  "sidebar-projects": {
    shapes: [["rect",{"x":"3","y":"4","width":"18","height":"16","rx":"2"}],["path",{"d":"M9 4v16"}]],
    design: {
      rest: "整体窗口和左栏分割线，非布局active-first",
      motion: { kind: "still", animation: "none", description: "当前消费表达对象/记录或入口，未提供持续活动事实；实际面板/选中/布局变化已表达动作结果，保持图标静止减少重复反馈。", trigger: "沿现有对象身份、分类、导航、记录或工具入口；hover/focus沿宿主短反馈" }
    }
  },
  "table-header": {
    shapes: [["rect",{"x":"3","y":"4","width":"18","height":"16","rx":"2"}],["path",{"d":"M3 9h18 M3 14h18 M9 9v11 M15 9v11 M7 6.5h10"}]],
    design: {
      rest: "表格三列、表头横线，区别选择项",
      motion: { kind: "still", animation: "none", description: "当前消费表达对象/记录或入口，未提供持续活动事实；实际面板/选中/布局变化已表达动作结果，保持图标静止减少重复反馈。", trigger: "沿现有对象身份、分类、导航、记录或工具入口；hover/focus沿宿主短反馈" }
    }
  },
  "executor-unknown": {
    shapes: [["rect",{"x":"4","y":"7","width":"16","height":"14","rx":"3"}],["path",{"d":"M12 3v4 M9 11a3 3 0 1 1 4 3l-1 1"}],["circle",{"cx":"12","cy":"18","r":".4"}]],
    design: {
      rest: "问号在机器轮廓内，明确身份未核实",
      motion: { kind: "still", animation: "none", description: "存活、空闲、排队、终止、未知或需要输入均不等价于正在工作。永久循环会误导，原正文/动作仍准确。", trigger: "沿原已确认状态或控件值显示；存活、排队、未知等事实不自动启用动画。" }
    }
  },
  "response-reject": {
    shapes: [["circle",{"cx":"12","cy":"12","r":"9"}],["path",{"d":"M7 12h10"}]],
    design: {
      rest: "圆内横线为Decline/Reject，区别停止进程",
      motion: { kind: "still", animation: "none", description: "当前消费表达对象/记录或入口，未提供持续活动事实；实际面板/选中/布局变化已表达动作结果，保持图标静止减少重复反馈。", trigger: "沿现有对象身份、分类、导航、记录或工具入口；hover/focus沿宿主短反馈" }
    }
  },
  "file-license": {
    shapes: [["path",{"d":"M5 3h9l5 5v13H5Z M14 3v5h5"}],["path",{"d":"M15 12a4 4 0 1 0 0 6"}]],
    design: {
      rest: "折角纸页内C式约定，只标类别，不宣称许可证有效性",
      motion: { kind: "still", animation: "none", description: "文件类别在长期列表和标题中不变；打开/加载/失败反馈留原宿主，不让类别自己循环。", trigger: "按原文件分类显示；读取、执行和失败反馈由原宿主表达，保持静止。" }
    }
  },
  "file-notebook": {
    shapes: [["path",{"d":"M7 3h12v18H7Z M3 6h6 M3 12h6 M3 18h6 M12 8h4 M12 13h4"}]],
    design: {
      rest: "装订页、侧环与两条内容线，保与普通文本区别",
      motion: { kind: "still", animation: "none", description: "文件类别在长期列表和标题中不变；打开/加载/失败反馈留原宿主，不让类别自己循环。", trigger: "按原文件分类显示；读取、执行和失败反馈由原宿主表达，保持静止。" }
    }
  },
  "file-diagram": {
    shapes: [["path",{"d":"M5 3h9l5 5v13H5Z M14 3v5h5"}],["rect",{"x":"8","y":"10","width":"3","height":"3"}],["rect",{"x":"13","y":"16","width":"3","height":"3"}],["path",{"d":"M11 11.5h4v4.5"}]],
    design: {
      rest: "纸页内两个节点与连接，小尺寸需核节点开口",
      motion: { kind: "still", animation: "none", description: "文件类别在长期列表和标题中不变；打开/加载/失败反馈留原宿主，不让类别自己循环。", trigger: "按原文件分类显示；读取、执行和失败反馈由原宿主表达，保持静止。" }
    }
  },
  "file-presentation": {
    shapes: [["path",{"d":"M3 4h18v14H3Z M12 18v4 M8 22h8 M8 8l8 3-8 3Z"}]],
    design: {
      rest: "投影屏和play式内容，类别不等于正在放映",
      motion: { kind: "still", animation: "none", description: "文件类别在长期列表和标题中不变；打开/加载/失败反馈留原宿主，不让类别自己循环。", trigger: "按原文件分类显示；读取、执行和失败反馈由原宿主表达，保持静止。" }
    }
  },
  "verbosity-more": {
    shapes: [["path",{"d":"M4 4h16 M4 9h16 M4 14h6 M17 13v8 M13 17h8"}]],
    design: {
      rest: "两行内容与局部加号，表示more detail",
      motion: { kind: "still", animation: "none", description: "图形经实际CSS mask投影，无独立内部部位；真实内容/折叠/缩放变化已经给出结果，静止图标更清楚。", trigger: "原Monaco/Excalidraw控件值与动作；不新增内部动画renderer" }
    }
  },
  "verbosity-less": {
    shapes: [["path",{"d":"M4 4h16 M4 9h16 M4 14h6 M13 17h8"}]],
    design: {
      rest: "两行内容与局部减号，和more同族",
      motion: { kind: "still", animation: "none", description: "图形经实际CSS mask投影，无独立内部部位；真实内容/折叠/缩放变化已经给出结果，静止图标更清楚。", trigger: "原Monaco/Excalidraw控件值与动作；不新增内部动画renderer" }
    }
  },
  "suggestion-snooze": {
    shapes: [["path",{"d":"M5 3h14v18H5Z M8 9h8l-8 7h8"}]],
    design: {
      rest: "纸页内Z式休眠符号；非停止Agent或静音通知",
      motion: { kind: "still", animation: "none", description: "图形经实际CSS mask投影，无独立内部部位；真实内容/折叠/缩放变化已经给出结果，静止图标更清楚。", trigger: "原Monaco/Excalidraw控件值与动作；不新增内部动画renderer" }
    }
  },
  "draft-return": {
    shapes: [["path",{"d":"M8 7V4h12v16H8v-4 M12 17h5"}],["path",{"d":"M3 11h10 M10 8l3 3-3 3"}]],
    design: {
      rest: "输入纸页保留完整外轮廓，回入箭头进入编辑面，区别文件夹移动",
      motion: {"kind":"still","animation":"none","description":"原消息移至草稿由回调与原投递记录说明；入口静止，不预播已移动或已发送","trigger":"仅沿原队列条目、资格与操作回执；图形不判断原消息是否投递。"}
    }
  },
  "browser-agent": {
    shapes: [["rect",{"x":"3","y":"4","width":"18","height":"16","rx":"2"}],["path",{"d":"M3 9h18"}],["rect",{"x":"8","y":"12","width":"10","height":"6","rx":"1.5"}],["path",{"d":"M13 10v2 M11 14v1 M15 14v1"}]],
    design: {
      rest: "浏览器窗口与内部Agent面孔共同保留，区别单独Agent及正在执行的箭头",
      motion: {"kind":"still","animation":"none","description":"控制归属是静态关系，不等于Browser当前正在执行，窗口和Agent形保持静止","trigger":"原Browser driving/control事实选择此对象；实际operation活动由独立状态owner表达。"}
    }
  },
  "graph-arrange": {
    shapes: [["rect",{"x":"3","y":"4","width":"5","height":"5","rx":"1"}],["rect",{"x":"16","y":"4","width":"5","height":"5","rx":"1"}],["rect",{"x":"9.5","y":"15","width":"5","height":"5","rx":"1"}],["path",{"d":"M8 6.5h8 M5.5 9v8.5h4 M18.5 9v8.5h-4"}]],
    design: {
      rest: "对齐的三个节点与连接线表达关系排图，区别分屏均分",
      motion: {"kind":"still","animation":"none","description":"节点位置的真实改变已经反馈排图结果；入口图形静止，不再加一次整理表演","trigger":"原Arrange Worker结果与positions owner持有应用/取消事实，不从图标发起或确认布局。"}
    }
  },
} as const satisfies Record<string, AuthoredIconDefinition>

/** Existing drawing consumers retain exact glyph keys and readonly shape literals. */
export const AUTHORED_ICON_GLYPHS = Object.fromEntries(
  Object.entries(AUTHORED_ICON_DEFINITIONS).map(([id, definition]) => [id, definition.shapes])
) as { [Id in keyof typeof AUTHORED_ICON_DEFINITIONS]: typeof AUTHORED_ICON_DEFINITIONS[Id]['shapes'] }

export const AUTHORED_ICON_DESIGNS = Object.fromEntries(
  Object.entries(AUTHORED_ICON_DEFINITIONS).map(([id, definition]) => [id, definition.design])
) as { [Id in keyof typeof AUTHORED_ICON_DEFINITIONS]: typeof AUTHORED_ICON_DEFINITIONS[Id]['design'] }

export const AUTHORED_ICON_GLYPH_IDS = Object.keys(AUTHORED_ICON_DEFINITIONS) as Array<keyof typeof AUTHORED_ICON_DEFINITIONS>
