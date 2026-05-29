# 笔记本打开性能优化日志

## 日期
2026-05-29

## 概述

优化 Zeppelin legacy 前端打开笔记时的加载速度，通过减少阻塞请求数量实现更快的笔记打开体验。

## 优化内容

### 优化1：InterpreterBindings 懒加载

**改动文件**: `zeppelin-web/src/app/notebook/notebook.controller.js`

**改动位置**: 第 1671 行，`setNoteContent` 事件处理器

**原代码**:
```javascript
$scope.$on('setNoteContent', function(event, note) {
  // ...
  initializeLookAndFeel();

  // open interpreter binding setting when there're none selected
  getInterpreterBindings();  // <-- 阻塞请求
  getPermissions();
  // ...
});
```

**修改后**:
```javascript
$scope.$on('setNoteContent', function(event, note) {
  // ...
  initializeLookAndFeel();

  // interpreterBindings 延迟加载，不在打开笔记时阻塞
  // 仅在打开设置面板时加载 (openSetting)
  getPermissions();
  // ...
});
```

**影响分析**:

| 场景 | 是否受影响 | 说明 |
|------|-----------|------|
| 运行 paragraph | ❌ 不受影响 | 服务器根据文本中的 `%interpreter` 决定 |
| 重启解释器 | ⚠️ 需要先打开设置 | 打开设置面板时会加载 bindings |
| 设置面板 | ❌ 不受影响 | `openSetting()` 已有加载逻辑 |
| 默认解释器回退 | ⚠️ 可能受影响 | paragraph 无 `%xxx` 前缀时，无法从 bindings 获取默认名 |

**潜在风险**:
- 如果 paragraph 没有指定 `%interpreter` 前缀，且服务器端没有配置默认解释器，可能导致无法确定使用哪个解释器
- 实际上服务器端有默认解释器配置，所以风险较低

---

### 优化2：禁用版本历史请求

**改动文件**: `zeppelin-web/src/app/notebook/notebook.controller.js`

**改动位置**: 第 194 行，`requestRevisionHistory` 函数

**原代码**:
```javascript
const requestRevisionHistory = function() {
  if (revisionHistoryRequested || !hasAuthenticatedTicket()) {
    return;
  }
  revisionHistoryRequested = true;
  websocketMsgSrv.listRevisionHistory($routeParams.noteId);
};
```

**修改后**:
```javascript
const requestRevisionHistory = function() {
  // 版本历史功能已禁用，减少打开笔记时的请求
  return;
  // if (revisionHistoryRequested || !hasAuthenticatedTicket()) {
  //   return;
  // }
  // revisionHistoryRequested = true;
  // websocketMsgSrv.listRevisionHistory($routeParams.noteId);
};
```

**影响分析**:

| 场景 | 是否受影响 | 说明 |
|------|-----------|------|
| 查看版本历史 | ✅ 受影响 | 版本历史面板将无法显示内容 |
| 回滚到旧版本 | ✅ 受影响 | 无法选择历史版本 |
| 笔记编辑/运行 | ❌ 不受影响 | 版本管理与运行无关 |
| 笔记保存 | ❌ 不受影响 | 保存功能独立于版本历史 |

**恢复方式**: 如需恢复版本管理功能，注释掉 `return;` 并取消注释原有代码即可。

---

## 性能提升

### 优化前 WebSocket 请求流程
```
1. GET_NOTE                  → 等待服务器返回 NOTE
2. LIST_REVISION_HISTORY     → 等待服务器返回
3. LIST_CONFIGURATIONS       → 等待服务器返回
4. GET_INTERPRETER_BINDINGS  → 等待服务器返回
```

### 优化后 WebSocket 请求流程
```
1. GET_NOTE                  → 等待服务器返回 NOTE
2. LIST_CONFIGURATIONS       → 异步，不阻塞
（LIST_REVISION_HISTORY 已禁用）
（GET_INTERPRETER_BINDINGS 已延迟到打开设置时）
```

**减少的阻塞请求**: 2 个 (LIST_REVISION_HISTORY + GET_INTERPRETER_BINDINGS)

---

## 相关配置

### 服务器端禁用版本管理（可选）

如果需要从服务器端彻底禁用版本管理，可以修改 `zeppelin-site.xml`:

```xml
<property>
  <name>zeppelin.notebook.storage</name>
  <value>org.apache.zeppelin.notebook.repo.VFSNotebookRepo</value>
</property>
```

**注意**: `GitNotebookRepo` 继承自 `VFSNotebookRepo`，两者使用相同的目录结构，切换不会有兼容性问题。

---

## 同时修复的其他问题

### 1. 首页最近笔记误显示"已删除"

**问题**: 笔记列表未加载完成时，`isNoteDeleted()` 返回 `true`，导致所有最近笔记显示为已删除

**解决**: 在 `flatList` 为空时返回 `false`

```javascript
$scope.isNoteDeleted = function(noteId) {
  if (!vm.notes || !angular.isArray(vm.notes.flatList) || vm.notes.flatList.length === 0) {
    return false;  // 未加载完成，不显示为已删除
  }
  // ...
};
```

### 2. ESLint 错误修复

修复了多个文件的 lint 错误：
- `var` 改为 `let/const`
- 缺少花括号的 `if` 语句
- 对象花括号空格
- 缺少尾逗号
- 创建 `.eslintignore` 排除第三方库

---

## 待观察

- [ ] 运行 paragraph 时是否有解释器找不到的情况
- [ ] 无 `%interpreter` 前缀的 paragraph 是否能正常运行
- [ ] 用户是否需要版本管理功能

## 回滚方案

如果出现问题，恢复以下两处改动即可：

1. **InterpreterBindings**: 在 `setNoteContent` 中恢复 `getInterpreterBindings()` 调用
2. **版本历史**: 在 `requestRevisionHistory` 中恢复原有逻辑（去掉 `return;`）
