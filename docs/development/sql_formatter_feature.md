# SQL 格式化功能实现日志

## 概述

为 Zeppelin legacy 前端的 paragraph 编辑器添加 SQL 格式化按钮，支持一键格式化 SQL 代码。

## 使用的库

- **sql-formatter**: [https://github.com/sql-formatter-org/sql-formatter](https://github.com/sql-formatter-org/sql-formatter)
- 文件位置: `zeppelin-web/src/lib/sql-formatter.min.js`
- 支持的方言: bigquery, clickhouse, db2, duckdb, **hive**, mariadb, **mysql**, **spark**, sqlite, **sql**, trino, snowflake 等

## 实现细节

### 1. 添加格式化按钮 (paragraph.html)

```html
<span class="zp-format-btn"
      ng-if="isSqlMode(paragraph)"
      ng-click="formatSqlCode(paragraph)"
      tooltip-placement="top"
      uib-tooltip="格式化 SQL">
  <i class="fa fa-align-left"></i> 格式化
</span>
```

### 2. 格式化逻辑 (paragraph.controller.js)

```javascript
$scope.formatSqlCode = function(paragraph) {
  var sf = window.sqlFormatter || (typeof sqlFormatter !== 'undefined' ? sqlFormatter : null);
  // 动态加载机制（如果未加载）
  if (!sf && !$scope._sqlFormatterLoading) { /* 动态加载 */ }

  // 方言检测：同时检查解释器名称和文本内容
  var magic = getParagraphMagic(paragraph.text).toLowerCase();
  var lowerText = paragraph.text.toLowerCase();
  var dialect = 'sql';
  if (magic.indexOf('hive') !== -1 || magic.indexOf('jdbc') !== -1) dialect = 'hive';
  if (magic.indexOf('mysql') !== -1) dialect = 'mysql';
  if (magic.indexOf('spark') !== -1) dialect = 'spark';

  // 格式化并保存
  var formatted = sf.format(paragraph.text, { language: dialect, ... });
  paragraph.text = formatted;
  session.replace(...);  // 用 replace 代替 setValue，支持 Ctrl+Z 撤销
  commitParagraph(paragraph);  // 保存到服务器
};
```

## 遇到的问题及解决

### 问题 1: MIME type 错误 (404)

**现象**: `Refused to execute script because its MIME type ('text/html') is not executable`

**原因**: 
- `Gruntfile.js` 的 `copy:dist` 任务没有包含 `lib/**/*`
- `index.html` 中没有添加 `<script>` 标签
- `webpack.config.js` 的 dev server 没有配置 `lib/` 目录的静态文件路由

**解决**:
1. `Gruntfile.js` - 添加 `'lib/**/*'` 到 copy:dist src 数组
2. `index.html` - 添加 `<script src="lib/sql-formatter.min.js"></script>`
3. `webpack.config.js` - 添加 `app.use('**/lib/', express.static(...))` 路由

### 问题 2: sqlFormatter 未定义 (ReferenceError)

**现象**: `ReferenceError: sqlFormatter is not defined`

**原因**: UMD 模块的 `this` 在某些上下文中不是 `window`

**解决**: 使用 `typeof` 安全检查 + 动态加载机制
```javascript
var sf = window.sqlFormatter || (typeof sqlFormatter !== 'undefined' ? sqlFormatter : null);
```

### 问题 3: ESLint 报错

**现象**: `sql-formatter.min.js` 解析错误

**解决**: 创建 `.eslintignore` 文件排除 `src/lib/` 目录

### 问题 4: Ctrl+Z 无法撤销

**现象**: 格式化后 Ctrl+Z 无效

**原因**: `setValue()` 会重置 undo 栈

**解决**: 改用 `session.replace()` 替换整个编辑器内容
```javascript
session.replace(new ace.Range(0, 0, lastRow, session.getLine(lastRow).length), formatted);
```

### 问题 5: 刷新页面后格式化丢失

**现象**: 格式化成功但刷新后还原

**原因**: 没有调用保存接口

**解决**: 格式化后调用 `commitParagraph(paragraph)` 保存到服务器

## 样式调整

- 格式化按钮和代码类型标签向上移动: `top: 10px` → `top: 4px`
- 代码类型标签向左移动避免滚动条重叠: `right: 14px` → `right: 24px`
- 移除格式化按钮 hover 效果

## 待优化

- sql-formatter 配置参数微调（如 `expressionWidth` 控制紧凑度）
- 支持更多方言自动检测
