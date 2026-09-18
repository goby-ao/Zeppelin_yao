# 快速运行后编辑器代码回退：排查与修复

日期：2026-09-17

关联历史提交：`1b715e7dd98e804d2c4eb6c0da6dc51abaf81295`。

## 1. 现象与结论

用户把代码中的 `20260720` 修改为 `20260721`，立即用快捷键运行。执行使用了新值，但执行过程中编辑器又显示旧值。

本轮在隔离 Chrome 中，使用仓库实际版本的 Angular、ui-ace、Ace 和 `ParagraphCtrl`，重放消息时序，复现了“运行请求是新代码，编辑器却回退”的现象。修复前后的代码用同一套测试对照验证，不连接后端、不执行 SQL。

**已确认的是客户端存在能够导致该现象的缺口；尚未抓到本次线上事故的完整 WebSocket 消息序列，不能据此断言线上每一次回退都来自同一个消息生产源。**

本次只修改前端段落文本同步逻辑，不修改执行协议、解释器、后端持久化或视口优化库。

## 2. 相关链路

```text
用户输入
  -> Ace change（同步）
  -> ui-ace 排队更新 ngModel
  -> Ace input（延迟约 31ms）
  -> ParagraphCtrl.aceChanged 更新 dirtyText / 发补丁或启动保存计时

快捷键运行
  -> keyEvent / runParagraphFromShortcut
  -> getEditorValue / runParagraph
  -> RUN_PARAGRAPH(text = 本次代码)

服务端消息
  -> angular-websocket $applyAsync
  -> updateParagraph / updateAllScopeTexts
  -> paragraph.text
  -> ngModel.$render
  -> Ace session.setValue
```

因此，“实际执行新代码”和“编辑器后来显示旧代码”并不矛盾：请求取值和之后的编辑器回填是两条链路。

源码入口：

- `zeppelin-web/src/app/notebook/paragraph/paragraph.controller.js`
- `zeppelin-web/src/app/notebook/paragraph/code-editor/code-editor.directive.html`
- `zeppelin-web/src/components/websocket/websocket-message.service.js`
- `zeppelin-web/src/components/websocket/websocket-event.factory.js`
- 本地实际依赖 `bower_components/ace-builds/src-noconflict/ace.js`、`angular-ui-ace/ui-ace.js`、`angular-websocket/angular-websocket.js`。未修改这些第三方文件。

## 3. 已复现的缺口

### 3.1 文本确认过早解除运行期间的保护

旧实现只依赖 `dirtyText`、`pendingText`。收到一次与本地相同的文本后，两者就会清空。之后的整段状态消息可以重新覆盖代码。

最小复现顺序：

1. 编辑器从 A 改为 B。
2. 快捷键发送 `RUN_PARAGRAPH(B)`。
3. 收到 `PARAGRAPH(B, RUNNING)`，旧实现清空本地保护。
4. 收到 `PARAGRAPH(A, RUNNING)`，旧实现接受 A。
5. Angular 把 A 写回真实 Ace；运行请求记录仍然是 B。

测试在旧代码上明确失败：预期 `select 20260721`，实际编辑器和模型均为 `select 20260720`。

### 3.2 输入保护有时间窗口，保存读取顺序也不对

当前安装的 Ace 用 `delayedCall(...).schedule(31)` 发出 `input` 通知。旧实现仅在这个通知里更新 `dirtyText`。

所以刚输入后的一小段时间内：

- Ace 已经是新代码，`dirtyText` 却还是旧值或未定义。
- 接收旧消息时，控制器可能误认为没有本地修改。
- 保存逻辑优先读取 `dirtyText`，可能漏保存，或者提交落后的文本。

这不是建议把延迟改短，而是不能拿延迟通知当作“用户是否刚修改代码”的唯一依据。

### 3.3 相同对象也可能是一条有效确认

保存和运行会先把 `paragraph.text` 乐观更新为新值。服务端确认若没有改变其他字段，`isUpdateRequired` 返回 false，旧实现直接跳过，导致确认清理没有执行。

这会影响空文本保存、终态确认，以及后续正常远端编辑。测试已覆盖这些情况。

### 3.4 协同补丁混淆了服务端基线与未发送的本地修改

旧 `patchReceived` 把补丁应用到整个本地文本，再把合并结果直接赋给 `originalText`。如果本地修改尚未发送，这相当于提前确认了它，后续可能不再发送该修改。

同时，运行期间的文本保护必须接纳真正的协同补丁，否则下一条整段状态消息又会把已合并的补丁回退掉。

### 3.5 模型更新与 Ace 渲染不是同一时刻

同一个 Angular 刷新周期可以处理多条消息；长笔记的视口外段落还可能暂停 watchers。此时模型已经更新，Ace 仍显示旧值。

如果每次无条件优先读 Ace，或者让旧的延迟 `input` 把 Ace 内容重新写入模型，会再次覆盖刚接收的文本。连续补丁和暂停 watchers 的测试都能检测这个边界。

## 4. 本次修复

| 位置 | 处理 |
| --- | --- |
| Ace 同步 `change` | 立即记录 `dirtyText` 与段落文本；不增加网络请求、不额外启动 digest。原 `input` 仍负责补全模式、协同发送和保存计时。 |
| 最新文本读取 | 运行、保存、配置提交统一使用最新编辑器文本；已接收但尚未渲染的模型文本用 `textAwaitingEditorRender` 明确标记，不能误读落后的 Ace。 |
| 后端运行提交 | 用独立的 `submittedRunText` 保留本次运行的文本，不随第一次文本确认解除。 |
| 状态回填 | 继续更新状态、进度、结果和错误信息，但不让不同文本覆盖本地待同步内容或运行保护文本。 |
| 保护释放 | 收到文本一致的 FINISHED / ERROR / ABORT 后释放；非运行状态下用户开始新编辑时也释放。没有任意秒数的过期定时器。 |
| 相同快照 | 即便字段没有变化，也处理文本确认；不同段落和历史版本视图仍被排除。 |
| 协同补丁 | 分别合并服务端基线、本地文本、待确认文本和运行保护文本，保留尚未发送的本地差异。仍使用原有 diff-match-patch。 |
| 生命周期 | 去重文本监听，销毁段落时解绑；延迟输入不得覆盖正在等待渲染的已接收模型。 |

这里的 `submittedRunText` 是客户端回填保护，不是服务端执行快照。收到明确的协同补丁时也会合并到保护文本，避免后续状态回填撤销正常协同修改。

## 5. 为什么不直接丢弃旧的整个消息

`PARAGRAPH` 不只包含代码，也携带运行结束、报错、取消和结果。粗暴丢弃整条消息可能造成“任务已经结束，界面还在运行”。本次只在文本合并处保护代码，保留原有状态和结果处理。

也没有仅靠 `dateUpdated` 做版本仲裁：当前 WebSocket 的 Gson 日期格式是 `yyyy-MM-dd'T'HH:mm:ssZ`，同一秒内的修改无法可靠排序。

## 6. 线上旧文本的来源：已知与待证实

源码确认：

- `NotebookService.runParagraph` 用运行请求的文本更新段落并执行。
- `NotebookService.updateParagraph` 也会用 COMMIT 请求中的全文更新段落。
- 保存回执、运行状态回调等都会产生包含文本的整段消息。
- 后台状态广播使用 `MSG_ID_NOT_DEFINED`，不能仅靠请求序号判断文本版本。
- `NotebookSocket.send` 的同步发送并不等价于所有生产线程都按文本版本生成消息；WebSocket 保序也不等价于应用快照按版本排序。

尚待线上消息证据区分的来源：

1. 保存、运行状态、输出配置相关回填交错。
2. 另一个浏览器标签页或其他用户提交了旧全文。
3. 协同模式下补丁与整段消息交错。
4. 视口外暂停渲染放大了延迟回填窗口。

这些是候选触发条件，不是已经确认的本次线上触发路径。不能把“per-user 独立解释器”直接等同于“笔记文本按用户隔离”或“没有其他写入者”。

## 7. 定向验证

测试文件：`zeppelin-web/src/app/notebook/paragraph/paragraph.text-sync.test.js`。

独立运行器：`zeppelin-web/test/paragraph-text-sync.runner.cjs`。

运行器使用真实 Angular、Ace、ui-ace、diff-match-patch、段落控制器；仅模拟 WebSocket 服务等外围依赖。消息按照项目实际 `$applyAsync` 方式投递，不复制一份控制器逻辑。它只转换少量模块供浏览器加载，不调用应用构建、Maven、Grunt 或 Webpack。

需要本地已经安装 Web 前端依赖、Chrome，以及可运行 Playwright 的 Node。应用自身的 Node 12 构建环境不变；此独立测试使用支持 Playwright 的现代 Node。

```bash
# 从仓库根目录运行；PLAYWRIGHT_MODULE 可指向机器已有的 Playwright 模块。
PLAYWRIGHT_MODULE=/YOUR_PLAYWRIGHT_MODULE_PATH \
  node zeppelin-web/test/paragraph-text-sync.runner.cjs

# 对照旧控制器，仅读取 git 对象，不切分支、不修改工作树。
PLAYWRIGHT_MODULE=/YOUR_PLAYWRIGHT_MODULE_PATH \
  PARAGRAPH_SOURCE_REF=346e5b192 \
  node zeppelin-web/test/paragraph-text-sync.runner.cjs
```

所有浏览器网络请求都在测试进程中拦截，不访问线上服务。测试文本只作为字符串，不执行 SQL。

覆盖范围包括：快速快捷键运行、新文本确认后旧快照、延迟输入前保存、空文本、较早保存确认、连续远端编辑、错误/取消/完成、运行结束后继续编辑、协同补丁、本地未发送修改、连续补丁、暂停 watchers、不同段落与历史版本视图，以及 100 轮连续快速编辑运行。

2026-09-17 最终验证结果：

| 控制器版本 | 同一套 56 个用例 |
| --- | --- |
| 修复前 `346e5b192`（包含历史修复） | 39 通过，17 失败；快速运行回退断言失败 |
| 本轮工作树 | 56 全部通过，浏览器无未捕获错误 |

其中包含 34 个已有控制器用例、22 个新增同步回归用例；连续运行用例内部执行 100 轮。指定文件 ESLint 为 0 errors，9 个 `no-invalid-this` warnings 位于未修改的补全代码；`git diff --check` 通过。

本轮没有执行 WAR/JAR 构建、全量测试或线上执行验证。

## 8. 范围与上线观察

运行时改动只有 `paragraph.controller.js`，发布需要更新 Web WAR，本轮不需要更新后端 JAR。没有改补全权限开关、运行请求参数、SQL 内容、UI 排版或笔记存储。

当前协议没有严格的文本 revision / execution ID。本次保护解决已复现的本地快速运行与回填竞态，但不是一个新的多客户端版本一致性协议：

- 不宣称能阻止另一个客户端真正把旧文本保存到服务器。
- 如果终态仍携带不同文本，客户端会保留本地内容，直到匹配确认或用户再次编辑；不会悄悄把不同文本认作已确认，也不会自动发送一个覆盖服务器的“修复保存”。
- 匹配终态之后恢复正常远端更新；任意历史快照在此后到达，协议仍不能无歧义地与一次合法远端修改区分。
- 对同一位置的多用户冲突，仍沿用 diff-match-patch 的既有行为，没有引入新的冲突解决规则。

如果线上再出现，应先保留问题发生前后的同一段落消息顺序，区分“客户端回填错误”与“服务端已经被旧提交覆盖”。建议仅采集 op、noteId、paragraphId、msgId、status、dateUpdated、dateStarted、dateFinished，以及脱敏后的文本摘要/哈希；不要外发 ticket、密码、完整业务 SQL。确认真正来源后，再决定是否需要后端文本版本号或条件写入，避免用更长的前端锁定掩盖服务端覆盖。
