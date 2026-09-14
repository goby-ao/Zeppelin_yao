# 新建 Paragraph 前端无响应问题复盘

## 背景

在笔记页面中，点击某个 paragraph 下方的“添加代码块”后，后端已经创建了新 paragraph，但前端页面没有立刻显示。刷新页面后，新 paragraph 才能看到。

这个问题在长笔记、置顶模式、当前段落接近视口边缘时更容易出现。典型现场是：在内容为 `7` 的 paragraph 下方插入，新节点实际已经进入 `note.paragraphs`，但 DOM 上只留下一个未完成编译的空壳节点。

## 表现

- 点击“添加代码块”后页面看起来没有反应。
- 刷新后新建的 paragraph 出现，说明后端创建和 WebSocket 回传是成功的。
- 失败时 DOM 中可能出现 raw 插值，例如：

```html
id="{{currentParagraph.id}}_paragraphColumn_main"
data-paragraph-id="{{currentParagraph.id}}"
```

- 这个 raw 节点高度很小，约 7px，`ng-include`、`ParagraphCtrl`、Ace 编辑器链路没有继续完成。

## 核心原因

问题的根因是 `angular-viewport-watch` 在新 paragraph 完整渲染前过早执行了 `disableDigest()`。

`angular-viewport-watch` 的默认逻辑是：当元素不在视口内时，把当前 scope 子树的 `$$watchers` 暂存到 `$$watchersBackup`，再把 `$$watchers` 置空，从而减少离屏 paragraph 的 digest 成本。

这在普通滚动场景没问题，但新 paragraph 插入时有一个短暂的危险窗口：

1. `ng-repeat` 先创建一个很小的 DOM 空壳。
2. 此时 `ng-include`、`ParagraphCtrl`、`code-editor`、Ace 还没完成初始化。
3. `scrollMonitor` 基于这个空壳测量位置，可能判断它不在视口内。
4. `viewport-watch` 立刻执行 `disableDigest()`。
5. 新节点后续编译需要的 watcher 被禁用，页面卡在 raw 插值状态。

更麻烦的是，原库禁用 watcher 时还会给 scope 挂上一个 `watchDuringDisable`：

```javascript
function watchDuringDisable() {
  this.$$watchersBackup = this.$$watchersBackup || [];
  this.$$watchers = this.$$watchersBackup;
  var unwatch = this.constructor.prototype.$watch.apply(this, arguments);
  this.$$watchers = null;
  return unwatch;
}
```

如果禁用发生在 `ng-include` 和 Ace 子 scope 创建之前，后续新建的子 scope 可能继承到这个被替换过的 `$watch`。这些 watcher 一出生就进入 `$$watchersBackup`，然后 `$$watchers` 继续为空。由于那个 7px 空壳不会自然触发 `enterViewport`，这些 watcher 很难再被恢复。

所以这个问题不能按“禁用后再恢复”的方向修。正确方向是：**新 paragraph 完整渲染前，一次都不能真正执行 watcher 禁用。**

## 为什么前几轮修复没有彻底解决

### 1. 方向偏向“补救”，没有阻止首次禁用

前几轮尝试过 `_initializing` 标志、延迟禁用、恢复 watcher、定时重试等办法。这些办法都假设“先禁用，后面还能救回来”。

但对这个场景来说，只要在编译完成前禁用过一次，就可能污染后续异步创建的子 scope。后面再恢复，只能恢复当时已经存在的 watcher，救不回还没创建就被 `watchDuringDisable` 影响的那部分编译链路。

### 2. 装饰器必须接管真正的 link 入口

原库的关键入口都藏在 link 闭包里：

```javascript
if (!elementWatcher.isInViewport) {
  scope.$evalAsync(disableDigest);
}
elementWatcher.exitViewport(disableDigest);
```

如果装饰器没有完全接管这个 link 过程，守卫逻辑就可能拦不住原始 `disableDigest` 的注册路径。

最终方案使用 `$provide.decorator('viewportWatchDirective', ...)`，通过 `compile()` 返回自定义 link，并删除原始 `link`：

```javascript
$delegate[0] = angular.extend({}, originalDirective, {
  compile: function() {
    return createSafeViewportWatchLink(scrollMonitor, $timeout);
  },
});
delete $delegate[0].link;
```

这样可以确保初始 `scope.$evalAsync(disableDigest)` 和 `exitViewport(disableDigest)` 都进入我们自己的 guarded `disableDigest()`。

### 3. 初始化完成事件必须向上传递

scope 层级大致是：

```text
ngRepeat child scope       viewport-watch 在这一层
  └─ ParagraphCtrl scope   aceLoaded 在这一层
```

`ParagraphCtrl` 的初始化完成信号需要向上传递，才能被 `viewport-watch` 所在的 ngRepeat scope 收到。因此使用：

```javascript
$scope.$emit('paragraphInitialized', $scope.paragraph.id);
```

不能从 `ParagraphCtrl` 只向下 `$broadcast`。当前实现里，`NotebookCtrl` 和 `viewport-watch` 都监听这个事件，分别负责 reveal/focus 和 watcher 恢复。

## 最终修复方案

### 1. 新增 viewport-watch 安全装饰器

文件：

- `zeppelin-web/src/app/viewport-watch-safety.js`
- `zeppelin-web/src/app/app.js`

核心策略是完整接管 `viewportWatchDirective` 的 link，并把守卫放进唯一的 `disableDigest()` 入口。

初始化阶段命中任一条件时，直接跳过禁用：

- note 层仍有 paragraph 正在初始化，`viewportWatchSuspend > 0`
- 当前 paragraph 数据对象上有 `_initializing`
- DOM 上仍然存在 `{{currentParagraph.id}}`
- paragraph 节点高度仍然小于 `VIEWPORT_WATCH_MIN_PARAGRAPH_HEIGHT`

```javascript
function disableDigest() {
  if (scope.$$destroyed) {
    return;
  }

  if (shouldSkipViewportWatchDisable(scope, element)) {
    toggleWatchers(scope, true);
    return;
  }

  toggleWatchers(scope, false);
}
```

初始注册也加了同样的保护：

```javascript
if (!elementWatcher.isInViewport && !shouldSkipViewportWatchDisable(scope, element)) {
  scope.$evalAsync(disableDigest);
  debouncedViewportUpdate();
}
```

### 2. 插入期间使用 note 级计数器

文件：

- `zeppelin-web/src/app/notebook/notebook.controller.js`

新 paragraph 插入时，把初始化状态挂在 paragraph 数据对象上：

```javascript
paragraph._initializing = true;
paragraph._pendingRevealAfterInit = true;
initializingParagraphIds[paragraph.id] = true;
syncViewportWatchSuspend();
```

`viewportWatchSuspend` 是计数器，不是布尔值。这样快速连续插入多个 paragraph 时，第一个 paragraph 初始化完成不会提前放开其他还在 raw 状态的 paragraph。

### 3. 初始化完成后恢复、重测、滚动和聚焦

文件：

- `zeppelin-web/src/app/notebook/paragraph/paragraph.controller.js`
- `zeppelin-web/src/app/notebook/notebook.controller.js`
- `zeppelin-web/src/app/viewport-watch-safety.js`

Ace 初始化完成后：

```javascript
if ($scope.paragraph) {
  $scope.paragraph._initializing = false;
  $scope.$emit('paragraphInitialized', $scope.paragraph.id);
}
```

`viewport-watch` 收到事件后：

- `enableDigest()`
- 只对同一个 paragraph 做一次 `scrollMonitor.update()`

`NotebookCtrl` 收到事件后：

- 清理初始化计数
- 取消兜底 timeout
- 调用 `scrollMonitor.update()`
- 再 `scrollToParagraphById(paragraphId)`
- 最后广播 `focusParagraph`

这里优先使用 `scrollMonitor.update()`，而不是只用 `recalculateLocations()`。原因是 `update()` 会重新评估 enter/exit 状态，让已经初始化完成、但确实离屏的 paragraph 后续可以按正常规则禁用 watcher。

### 4. 兜底和清理

为避免极端情况下 `aceLoaded` 没回来，插入时会启动 10 秒兜底：

```javascript
initializingParagraphTimeouts[paragraph.id] = $timeout(function() {
  delete initializingParagraphTimeouts[paragraph.id];
  finishParagraphInitialization(paragraph.id, false);
}, 10000);
```

正常收到 `paragraphInitialized` 或删除 paragraph 时，会取消对应 timeout，避免 10 秒后重复释放、重复重测。

`viewport-watch` 的 `$destroy` 仍保留：

```javascript
scope.$on('$destroy', function() {
  $timeout.cancel(viewportUpdateTimeout);
  elementWatcher.destroy();
  debouncedViewportUpdate();
});
```

这能避免频繁删除 paragraph 后，`scrollMonitor.watchers` 积累导致长时间会话变慢。

## 涉及文件

| 文件 | 作用 |
|------|------|
| `zeppelin-web/src/app/app.js` | 注册 `viewportWatchDirective` decorator |
| `zeppelin-web/src/app/viewport-watch-safety.js` | 接管 `viewport-watch` link，阻止初始化期禁用 watcher |
| `zeppelin-web/src/app/notebook/notebook.controller.js` | 管理 paragraph 初始化计数、兜底 timeout、初始化完成后的 reveal/focus |
| `zeppelin-web/src/app/notebook/paragraph/paragraph.controller.js` | Ace 初始化完成后向上 `$emit('paragraphInitialized')` |
| `zeppelin-web/src/app/viewport-watch-safety.test.js` | 覆盖 raw 插值、空壳节点、初始化期禁用保护、初始化完成恢复 |
| `zeppelin-web/src/app/notebook/notebook.controller.test.js` | 覆盖新增 paragraph 后延迟 reveal/focus、置顶模式可见性 |

## 关键判断信号

如果后续出现类似问题，可以优先看这些信号：

1. DOM 中是否有 raw `{{currentParagraph.id}}`。
2. 新节点高度是否只有几像素。
3. `ParagraphCtrl.aceLoaded` 是否触发。
4. `paragraphInitialized` 是否从 `ParagraphCtrl` 向上传到了 `viewport-watch` 所在 scope。
5. `scrollMonitor.update()` 是否在初始化完成后执行。
6. `scope.$$watchers` 是否被提前置空，或者 `$watch` 是否已经变成 `watchDuringDisable`。

## 手测建议

修复这类问题时，build 通过只能说明能打包，不能证明运行时生命周期正确。建议至少手测以下场景：

- 在长笔记中间插入 paragraph，确认不刷新即可显示。
- 在视口底部附近插入 paragraph，确认新节点不会卡成 7px 空壳。
- 快速连续插入两个 paragraph，确认两个都能显示。
- 删除刚插入的 paragraph，确认后续插入仍正常。
- 长笔记滚动到底部再回顶部，确认旧 paragraph 进入视口后编辑器仍能恢复。
- 置顶模式下插入 paragraph，确认新 paragraph 可见且不会被 dimmed 状态隐藏。

## 经验教训

1. 这类 AngularJS 指令问题要先找真正的生命周期入口。`disableDigest` 是闭包私有函数，守卫必须放在它前面，放在外层很容易无效。
2. 对异步编译链路来说，“禁用后恢复”不一定可靠。只要禁用动作影响了后续新建 scope 的 `$watch`，后面恢复的是不完整状态。
3. 事件方向要按 scope 层级确认。`$emit` 向上，`$broadcast` 向下，方向错了监听器不会报错，只会静默失效。
4. `scrollMonitor` 的位置缓存需要在 DOM 稳定后刷新。新 paragraph 从 raw 空壳变成真实节点后，要主动 `update()`。
5. 运行时 bug 不能只靠 build 判断。这个问题的关键证据来自 DOM 状态、scope watcher 状态和真实点击路径。
