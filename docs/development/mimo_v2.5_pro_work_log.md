# Mimo v2.5 Pro - 开发日志

## 2026-05-29

---

### 1. 段落导航条（新增模块，入侵度：低）

**新增文件（独立组件，可整体删除回退）：**
- `zeppelin-web/src/app/notebook/paragraph-nav/paragraph-nav.js` — 指令定义、节点构建、IntersectionObserver、hover 逻辑
- `zeppelin-web/src/app/notebook/paragraph-nav/paragraph-nav.html` — 模板：圆点 + tooltip（标题/状态/代码/错误/锁定按钮）
- `zeppelin-web/src/app/notebook/paragraph-nav/paragraph-nav.css` — 全部样式：容器/圆点/tooltip/锁定/dimmed/动画

**对 notebook.html 的修改（1 处）：**
- 新增一行 `<paragraph-nav>` 标签（在 `</div>` 闭合前），绑定 `paragraphs`、`lockedParagraphId`、事件回调

**对 notebook.controller.js 的修改（纯新增，未改已有函数）：**

| 新增项 | 位置 | 说明 | 回退方式 |
|---|---|---|---|
| `$scope.lockedParagraphId = null` | 变量声明区 | 锁定状态 | 删除该行 |
| `$scope.toggleParagraphLock(paragraphId)` | 新函数 | 切换锁定 | 删除该函数 |
| `$scope.scrollToParagraphById(paragraphId)` | 新函数 | 导航条点击滚动到段落 | 删除该函数 |
| `onDblClickUnlock(e)` | 新函数 + `document.addEventListener('dblclick', ...)` | 双击暗区解锁 | 删除函数 + 监听器 |
| `onEscKey(e)` | 新函数 + `document.addEventListener('keydown', ...)` | Esc 解锁 | 删除函数 + 监听器 |
| `onWheel(event)` | 新函数 + `document.addEventListener('wheel', ..., {passive: false})` | 锁定时滚轮拦截 | 删除函数 + 监听器 |
| `$destroy` 中新增清理 | `$scope.$on('$destroy', ...)` 内 | 移除上述 3 个监听器 | 删除对应 removeEventListener 行 |

**入侵风险点：**
- `onWheel` 使用 `{ passive: false }`，可能影响全局滚动性能
- `onDblClickUnlock` 监听在 `document` 上，每次双击都触发（有 lockedParagraphId 条件守卫）
- `$scope.lockedParagraphId` 挂在 notebook scope 上

---

### 2. 段落导航条 - 滚动定位优化

**文件:** `zeppelin-web/src/app/notebook/notebook.controller.js` — `$scope.scrollToParagraphById` 函数

- 修复点击第一个段落无法跳转到顶部
- 公式：`absoluteTop < viewportHeight` 时定位到 `absoluteTop - 110`，否则居中
- offset 110px 是 action bar 高度（60px）+ 间距经验值

---

### 3. 段落导航条 - Hover 卡片优化

**文件:** `paragraph-nav.js`、`paragraph-nav.html`、`paragraph-nav.css`

- `NavNode` 接口新增 `fullCode` 字段，`buildNodes()` 中 `fullCode: (p.text || '').trim()`
- 模板 `.tooltip-code` 从 `<div>` 改为 `<pre>`，绑定 `node.fullCode`
- CSS `.tooltip-code`：`white-space: pre`、`max-height: 280px`、`overflow-y: auto`
- 卡片宽度 240px → 480px
- Hover 延迟隐藏：`onNodeEnter` 清除计时器，`onNodeLeave` 启动 200ms 计时器，`onTooltipEnter` 取消计时器
- 模板新增 `ng-mouseenter="onTooltipEnter()"` `ng-mouseleave="onTooltipLeave()"` 到 tooltip div
- 首尾节点 CSS：`.first-node .nav-tooltip { top: 0; }` `.last-node .nav-tooltip { bottom: 0; }`
- Tooltip 改为 `ng-if="hoveredNodeId === node.id"` 按需渲染（原来用 opacity 切换）

---

### 4. 首页笔记列表优化

**文件:** `zeppelin-web/src/app/home/home.html`、`home.css`

- 按钮从 node-list 组件移到 home 标题行（node-list 中删除 `.note-actions` 区域）
- home.controller.js 新增 `importNote()`、`createNote()` 方法 + 注入 `NoteActionService`
- 笔记列表 `col-md-4` → `col-md-6`，`max-width: 520px` → `780px`
- `.note-folder-item`：`min-height: 30px` → `26px`，`padding: 4px` → `2px`，`line-height: 1.45` → `1.35`

---

### 5. 新建笔记弹窗美化

**文件:** `zeppelin-web/src/components/note-create/note-create.html`、`note-create.css`、`note-create.controller.js`

- CSS 全部重写（删除旧的 `.modal-header-note-name` 等样式）
- 新增 `.note-create-dialog`（max-width: 520px）、`.note-create-content`（border-radius: 12px）、`.note-create-header`、`.note-create-body`、`.note-create-input`、`.note-create-hint`、`.note-create-footer`、`.btn-create`
- controller 新增 `vm.quickTag` 变量 + `vm.selectQuickTag(tag)` 方法
- 模板新增 `.interpreter-quick-tags` 区域（Shell/Python/Spark/Hive 标签）
- CSS 新增 `.interpreter-quick-tags`、`.interpreter-tag`、`.interpreter-tag.active` 样式

---

### 6. 段落锁定功能 CSS

**文件:** `zeppelin-web/src/app/notebook/paragraph-nav/paragraph-nav.css`

- `.paragraph-locked`：紫色左边框（`::before` 3px #722ed1）+ box-shadow
- `.paragraph-dimmed`：`opacity: 0.35; pointer-events: none`
- `.paragraph-nav-highlight`：蓝色 box-shadow（滚动高亮 1.5s）
- 以上样式在新增的 paragraph-nav.css 中，删除该文件即全部回退

---

### 7. 顶部 Logo Hover 效果

**文件:** `zeppelin-web/src/components/navbar/navbar.css`

- 新增 `a.navbar-brand { transition: opacity 0.2s ease; }`
- `a.navbar-brand:hover { opacity: 0.65; text-shadow: 0 0 12px rgba(255,255,255,0.4); }`
- `a.navbar-brand:focus, a.navbar-brand:active { outline: none; box-shadow: none; }`
- 纯新增，不影响其他样式

---

### 8. SQL/Shell 代码自动补全（入侵度：中）

**文件:** `zeppelin-web/src/app/notebook/paragraph/paragraph.controller.js`

**修改点（在 `$scope.aceLoaded` 函数内）：**

| 修改 | 原值 | 新值 | 行号范围 |
|---|---|---|---|
| `enableLiveAutocompletion` | `false` | `true` | ~1186 |
| 新增 `sqlKeywords` 数组 | 无 | ~150 个 SQL 关键字 | ~1117 |
| 新增 `shellKeywords` 数组 | 无 | ~120 个 shell/hadoop 关键字 | ~1135 |
| 新增 `localCompleter` 对象 | 无 | 按编辑器模式匹配关键字 | ~1153 |
| `langTools.setCompleters` | `[remoteCompleter, keyWordCompleter, ...]` | `[remoteCompleter, localCompleter, keyWordCompleter, ...]` | ~1179 |

**入侵风险：** `localCompleter` 是新增对象，`setCompleters` 调用修改了补全器注册顺序（remoteCompleter 仍在首位）。回退只需恢复 `enableLiveAutocompletion: false` 并删除 `localCompleter` 相关代码。

---

### 9. 解释器补全配置调整

**文件:** `jdbc/src/main/resources/interpreter-setting.json`、`spark/interpreter/src/main/resources/interpreter-setting.json`

- JDBC：`editor.completionSupport` 改为 `false`（1 处）
- Spark：8 个子解释器的 `editor.completionSupport` 全部改为 `false`
- 需重新编译打包后端生效

---

### 10. 首页描述文字样式

**文件:** `zeppelin-web/src/app/home/home.html`、`home.css`

- `SQL`、`Shell`、`Python` 加 `<code>` 标签
- CSS 新增 `.home code` 样式（浅灰底、圆角、等宽字体、粉色文字）
