# viewport-watch 竞态导致新增段落 ACE 编辑器无法初始化

## 日期
2026-06-10

## 状态
✅ 已修复（v4 per-paragraph `_initializing` 状态握手方案）

## 问题描述

在大型 Notebook（段落较多）中，点击中间或底部段落的"添加代码块"按钮时，间歇性出现新段落不渲染、不发送 `EDITOR_SETTING` WebSocket 消息。刷新页面后发现段落已在服务端创建成功。顶部段落始终正常。

## 根因分析

### 异步模板加载链
段落 DOM 通过链式异步模板加载构建：`ng-repeat → ng-include(paragraph.html) → code-editor 指令 → $templateRequest(code-editor.directive.html) → ui-ace → window.ace.edit() → aceLoaded() → EDITOR_SETTING`。每一步 `$templateRequest().then()` 通过 `$evalAsync` 调度。

### viewport-watch 的竞态窗口
`viewport-watch` 在 link 时检测元素不在视口内，则 `$evalAsync(disableDigest)` 入队。`disableDigest()` 遍历 scope 子树将 `$$watchers` 置为 `null`，导致 Angular `$digest` 跳过该 scope。

`$evalAsync` 队列的 FIFO 顺序：`disableDigest` 在 link 阶段入队，早于 `ngIncludeThen`（在 watcher 评估阶段入队）。因此 digest 迭代 2 中 `disableDigest` 先执行，导致后续代码在 `$$watchers === null` 的状态下编译模板，ACE 初始化链中断。

## 修复方案：per-paragraph `_initializing` 状态握手

### 修改了 3 个文件

**1. `node_modules/angular-viewport-watch/angular-viewport-watch.js` — `disableDigest()` 函数**
在 `disableDigest()` 开头检查 `scope.currentParagraph._initializing`，若为 `true` 则直接 return，跳过 watcher 禁用。

**2. `src/app/notebook/notebook.controller.js` — `addPara()` 函数**
在 `splice` 前设置 `paragraph._initializing = true`。

**3. `src/app/notebook/paragraph/paragraph.controller.js` — `aceLoaded()` 函数末尾**
ACE 完全初始化后清除 `$scope.paragraph._initializing = false`。

### 关键设计决策
- 使用 `scope.currentParagraph` 而非 `scope.paragraph`：viewport-watch（priority 0）post-link 先于 ng-init（priority 450）执行，`scope.paragraph` 此时未定义
- 在 `disableDigest()` 中检查而非在 `$evalAsync` 入队处：同时覆盖初始入队和 `scrollMonitor.exitViewport` 两条路径
- 不依赖定时器：靠 paragraph 对象上的状态标记实现精确三方握手
