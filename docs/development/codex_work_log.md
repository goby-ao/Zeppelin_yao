# Codex 工作日志

## 2026-06-05 Zeppelin 笔记页与结果视图交互补充

### 改动范围

- 仅涉及 `zeppelin-web` 的 AngularJS 1.x 前端模板、控制器和样式。
- 本批次未修改后端 Java、解释器运行时和线上发布脚本。
- `docs/development/mimo_v2.5_pro_work_log.md` 是独立未跟踪文件，本次不纳入提交。

### 近期改动梳理

- 笔记标题与顶部操作栏：
  - 优化笔记标题的可编辑提示，减少标题旁边的空白占位。
  - 增加“默认引擎”标签，页面加载后异步获取默认解释器，不阻塞笔记打开。
  - 屏蔽“运行全部”和“切换个人模式”按钮，保留原代码注释，降低误操作入口。
  - 笔记导航点在段落数量过多时隐藏，避免右侧导航条过密。

- 段落编辑器：
  - 将代码格式化与重启解释器按钮移到上方工具区，避免遮挡长代码。
  - 重启按钮 hover 使用警告色，突出该操作的影响范围。
  - 默认字体大小调整为 10。
  - 首行 `%magic` 输入时禁止触发自动补全，避免输入 `%sh` 时弹出 SQL 关键字。
  - 手写 `%sh`、`%python`、`%hadoop3_spark` 等 magic 时，同步刷新 Ace mode、解释器标签、补全和 SQL 工具可见性。

- 结果视图与表格：
  - 优化结果视图工具条，加入“结果视图”下拉、清空当前结果按钮。
  - 结果设置面板完成中文化，保存后自动收起，并提供单独的“收起设置”按钮。
  - 弱化表格边框，优化表头视觉，去掉结果表格外层圆角和阴影。
  - 修复复制表格时表头前多出空 tab 的问题。
  - 修复段落设置标题后，结果视图按钮被挤到标题行的问题。

- 日志与长内容：
  - 日志输出支持折叠和展开。
  - 当日志与表格/图表结果同时出现时，日志默认折叠。
  - 纯日志输出默认展开；超过阈值时展示折叠入口。
  - 运行中日志支持类似 `tail -f` 的自动滚动到底部。
  - 超长代码支持折叠，减少大段 SQL 对页面高度的占用。

- 首页与快速笔记：
  - 首页快速开始改为“个人草稿本复用”逻辑，避免持续创建垃圾笔记。
  - 快速笔记支持 Hive、Spark、Python、Shell 四类入口。
  - 快速笔记默认绑定目标解释器，并支持在后续新增不同 magic 段落时动态补充绑定。
  - 最近使用列表扩展到 7 条，左右区域改为快速入口在左、笔记列表在右。

- 稳定性与联调辅助：
  - 修复偶发进入笔记时报 `config`、`time` 为空导致页面卡住的问题。
  - 修复搜索命中后点击上下箭头不滚动到匹配位置的问题。
  - 提高本地 18080 在线代理在 WebSocket 超时/断开时的健壮性，避免 `res.writeHead is not a function` 直接退出。

### 注意事项

- 本批次是前端代码改动；上线仍需重新构建 `zeppelin-web-0.9.1-SNAPSHOT.war` 并替换线上包。
- 未在本次提交中执行前端构建和发布，因为用户当前只要求梳理、更新日志和提交。
- 补全逻辑现在以解释器 `editor.completionSupport` 为前端开关：
  - 开启时只使用前端本地补全。
  - 关闭时禁用 Ace 自动补全。
  - 不再从段落编辑阶段发起后端 `COMPLETION` websocket 请求。
- 快速笔记绑定行为依赖前端的 quick note 配置；如果线上解释器 id/name 调整，需要同步更新配置。

### 本次校验

- `git diff --check`

## 2026-06-01 Zeppelin 旧版 Web 体验与快速笔记更新

### 改动范围

- 仅涉及旧版前端：`zeppelin-web` 的 AngularJS 1.x 模板、控制器和样式。
- Zeppelin Web 本地预览和发布相关辅助脚本曾在 `scripts/` 下维护。
- 本批次未修改后端 Java 或解释器运行时行为。

### 关键改动

- 段落 UI 打磨：
  - 重做段落工具栏、运行/停止按钮状态、右侧操作间距、tooltip 层级、设置下拉菜单间距、编辑器外观、解释器标签和整体视觉层级。
  - 增加代码和日志输出折叠交互：
    - 长代码超过阈值时可折叠。
    - 日志与表格/图表结果混合出现时，日志默认折叠。
    - 纯日志输出默认展开，只有较大时才显示折叠入口。
    - 运行中日志输出自动滚动，行为接近 `tail -f`。
  - 为快速笔记首个空段落增加占位提示。

- 快速笔记流程：
  - 首页快速入口改为复用每个用户自己的快速笔记，不再无限新建。
  - 快速笔记可限制为配置指定的目标解释器绑定。
  - 没有 `%magic` 的快速笔记段落，在解释器绑定变化后会广播编辑器设置刷新，让 SQL 类编辑器不需要显式 magic 也能显示 SQL 工具。

- 补全行为：
  - `editor.completionSupport` 作为前端补全开关。
  - `completionSupport=true` 时只启用 Ace 本地/前端补全。
  - `completionSupport=false` 时禁用 Ace 自动补全，并关闭已打开的补全器。
  - 旧版前端不再从段落编辑过程中发送 websocket `COMPLETION` 请求。

- 笔记设置稳定性：
  - 自动选择默认解释器后再记录 dirty baseline。
  - 隐藏的设置/权限面板不会在打开另一个面板时执行 dirty-confirm close 逻辑。
  - 避免第一次点击设置面板时误弹 “Interpreter setting changes will be discarded.”。

- 稳定性和性能：
  - 在笔记页面禁用 revision history 请求路径，减少打开笔记时的无效 revision 请求。
  - websocket 错误处理避免补全失败以阻塞弹窗形式打断用户。

### 注意事项

- 在重新生成发布包之前，这些改动只对前端开发服务器生效。`npm run dev` 可用于本地预览，但不能替代线上部署。
- 本地预览使用 Node 12.22.12：

  ```bash
  cd /Users/yao/.codex/worktrees/4fa4/Zeppelin_yao/zeppelin-web
  source ~/.nvm/nvm.sh
  nvm use 12.22.12
  WEB_PORT=9000 SERVER_PORT=18080 COREPACK_ENABLE_PROJECT_SPEC=0 npm run dev
  ```

- 18080 代理脚本仅用于本地浏览器联调线上后端。建议从 `zeppelin-web` 目录启动，确保可以加载 `node_modules/http-proxy`。
- 除非后端补全接口已经可靠且不会阻塞，否则不要把 `remoteCompleter` 重新加入 paragraph Ace completers。
- 快速笔记绑定行为依赖 `zeppelin-web/src/app/quick-note.config.js`；调整解释器名称时，需要和线上 Zeppelin 解释器 setting id/name 保持一致。
- 线上部署仍然需要前端生产构建，并替换生成的 `zeppelin-web-0.9.1-SNAPSHOT.war`。

### 已做校验

- `node --check zeppelin-web/src/app/notebook/notebook.controller.js`
- `node --check zeppelin-web/src/app/notebook/paragraph/paragraph.controller.js`
- `git diff --check`
