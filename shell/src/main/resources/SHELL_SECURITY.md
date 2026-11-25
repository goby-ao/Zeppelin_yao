<!--
Licensed to the Apache Software Foundation (ASF) under one or more
contributor license agreements. See the NOTICE file distributed with
this work for additional information regarding copyright ownership.
The ASF licenses this file to You under the Apache License, Version 2.0
(the "License"); you may not use this file except in compliance with
the License. You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# Zeppelin %sh 多租户安全配置

## 新增配置

在 Zeppelin 的 **Interpreters → sh → Edit → Properties** 中由管理员配置。已有解释器设置若未显示新字段，可手动添加同名属性。策略值按字面读取，笔记里的 `%sh.conf` 不允许更改 Shell 解释器配置。保存后重启对应的 `sh` 解释器生效。

首次部署时同步更新 `zeppelin-shell` 和服务端的 `zeppelin-zengine`，并重启 Zeppelin 服务以加载配置入口的保护。

| 配置项 | 默认值 | 如何配置 |
| --- | --- | --- |
| `zeppelin.shell.security.enabled` | `true` | 安全拦截总开关。设为 `false` 时全局关闭身份校验与命令/路径拦截，恢复原有 Bash 与终端执行方式。 |
| `zeppelin.shell.security.exempt.users` | 空 | 账号白名单。填实际登录账号，例如 `OPS_USER_1,OPS_USER_2`。英文逗号分隔，精确匹配账号。管理员角色不会自动豁免。 |
| `zeppelin.shell.security.executable.hadoop` | `/usr/bin/hadoop` | Hadoop 客户端的绝对路径。 |
| `zeppelin.shell.security.executable.hdfs` | `/usr/bin/hdfs` | HDFS 客户端的绝对路径。 |
| `zeppelin.shell.security.executable.hive` | `/usr/bin/hive` | Hive CLI 的绝对路径。 |
| `zeppelin.shell.security.executable.beeline` | `/usr/bin/beeline` | Beeline 客户端的绝对路径。 |
| `zeppelin.shell.security.executable.yarn` | `/usr/bin/yarn` | YARN 客户端的绝对路径。 |
| `zeppelin.shell.security.executable.hbase` | `/usr/bin/hbase` | HBase 客户端的绝对路径。 |
| `zeppelin.shell.security.terminal.enabled` | `false` | 交互终端开关，当前需手动添加。默认保持关闭。只有部署侧已验证 WebSocket 身份和会话所有者权限时，才可设为 `true`，且仅白名单账号能启动终端。 |

上线前请核对：

1. 核对线上 Shiro 对解释器管理接口的权限。按 `conf/shiro.ini.template` 将 `/api/interpreter/**` 限制为管理员角色，并用普通账号验证无法更新解释器设置。
2. 为 `sh` 启用用户模拟（User Impersonate）和按用户隔离进程。登录账号必须与解释器进程的非 root 系统账号一致。
3. 在每个解释器节点检查六个客户端的实际安装路径。默认路径正确时直接沿用。使用可信且由管理员维护的客户端和启动配置。本地文件操作在解释器 JVM 内执行，不再依赖 Python；旧的 `zeppelin.shell.security.executable.python3` 配置可以删除。
4. 由管理员维护临时目录父目录 `/tmp/zeppelin`，为需要使用个人临时目录的账号预建 `/tmp/zeppelin/<系统用户名>/`。子目录归该用户所有，权限为 `0700`。家目录需位于 `/home/<系统用户名>/` 并归该用户所有。

## 拦截方案

| 类型 | 执行行为 |
| --- | --- |
| 白名单账号与首行豁免 | 白名单账号或段落首行以 `#;;;` 开头时，核验登录身份和进程账号后，直接按原有 Bash 方式执行，跳过命令及路径拦截，仍使用本人的系统账号。 |
| 普通账号 | 一个段落可以有多行，跳过空行和注释；支持引号内跨行（如多行 `hive -e` SQL）和行尾 `\` 折行。逐条检查命令名和语法，整段通过后才开始执行。任一条命令含未授权命令或不支持的语法时，整段拒绝并报告行号。 |
| 数据平台客户端 | `hadoop`、`hdfs`、`hive`、`beeline`、`yarn`、`hbase` 是固定命令白名单（支持 `echo "<命令>" \| hbase shell` 查询）。其中 `hadoop`/`hdfs` 的删除操作禁止递归（`-r`/`-R`/`-rmr`/`-rmdir`）、禁止跳过回收站（`-skipTrash`）、禁止通配符与根路径；`hbase shell` 禁止 `drop`、`truncate`、`disable` 等删表/停表/清空表操作及调用系统命令。其余子命令、参数及集群操作仍受执行环境和账号权限约束。 |
| 本地文件命令 | 支持 `ls`、`stat`、`cat`、`head`、`tail`、`mkdir`、`cp`、`rm`，从家目录解析相对路径（支持 `~` 和 `~/...`）。文件操作只能访问本人家目录和个人临时目录，禁止路径越界、跟随符号链接和访问规则保护的凭据或启动文件。复制校验两端并禁止覆盖。 |
| 其他命令与语法 | 普通账号执行 `ssh` 等未登记命令会被拒。支持 `echo` 输出、受限管道过滤（`grep`/`head`/`tail`/`wc -l`，禁止附加文件路径）及标准输出重定向（`>`/`>>` 至本人家目录或个人临时目录普通文件）。命令串联等其他 Shell 语法不支持。带引号的参数仍可包含 SQL 分号与换行等字面字符。 |

例如前两行是允许的 Hadoop 命令，最后一行出现 `ssh`，前两行也不会启动。页面会按结构化四行格式提示「`[安全拦截] 根据安全管理要求，本次命令未执行` / `拦截位置：第 3 行` / `拦截原因：不支持该命令` / `处理建议：...`」，审计日志记录 `COMMAND_DENIED`。本地文件参数和路径范围也在整段执行前校验，文件是否存在、实际目录和权限在对应命令执行时校验。运行时报错会停止后续命令，先前已经执行的命令不会回滚。

本地文件操作使用 Java NIO 按路径检查，不是操作系统沙箱，也不保证防住并发替换目录。解释器仍须以非 root 的租户账号运行，目录访问最终受操作系统权限约束。文件预览最多读取 1 MiB，复制按块读写。

### 本地文件命令参数

| 命令 | 支持的写法 |
| --- | --- |
| `ls` | 可省略路径，默认查看家目录（也支持 `~`）。允许 `-l`、`-a`、`-h`、`-t`、`-r` 及其组合（如 `-lh`、`-lt`、`-lrt`、`-l -a`）。 |
| `stat`、`cat` | 一个路径。读取文件时检查为普通文件且无多个硬链接。 |
| `head`、`tail` | 一个文件路径，可加 `-n 1` 至 `-n 1000`，默认 10 行。 |
| `mkdir`、`cp` | 建目录可带 `-p`。复制只接收一个源文件和一个新目标路径。 |
| `rm` | 只接收一个明确路径，永久删除允许目录中由该用户拥有、仅有一个硬链接的普通文件。禁止选项、通配符、目录和符号链接。选项或参数数量不合法会在启动前拦截整段。 |

## 验收与排查

- 用普通账号在同一段落逐行运行两个已授权的只读命令，例如 `hadoop version` 和 `hdfs dfs -ls /YOUR_APPROVED_HDFS_PATH`，确认按顺序返回。
- 在测试环境用普通账号提交前面合法、末行含未授权命令的段落，确认中文提示包含末行行号，且没有前面命令的输出。用白名单账号执行无副作用的多行 Bash 检查原执行路径。
- 使用测试文件检查个人目录内读取、越界拒绝、复制禁止覆盖和单文件删除。若审计日志出现 `AUTH_REQUIRED` 或 `USER_MISMATCH`，先检查登录身份、用户模拟和解释器进程账号。若启动可执行文件失败，检查绝对路径、执行权限和运行依赖。
- 解释器日志用 `Shell policy EXEMPT`、`Shell policy DISPATCH`、`Shell policy BLOCKED` 区分白名单放行、通过入口校验和入口拦截。拦截日志含账号、笔记、段落、规则和行号，省略原始命令和参数。
