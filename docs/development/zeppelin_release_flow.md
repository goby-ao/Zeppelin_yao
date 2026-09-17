# Zeppelin WAR/JAR 统一发布流程

每次发布只处理明确选择的组件。产物放在制品 Git 仓库的
`zeppelin_deploy/<release-id>/`，其中 `manifest.tsv` 记录集群、源码提交、
发布范围、目标路径和 SHA-256。目录一经提交，不再原地修改；新内容生成新版本。

## 发布范围

| `--scope` | 本次安装的文件 |
| --- | --- |
| `web` | `zeppelin-web` WAR |
| `core` | `zeppelin-zengine`、`zeppelin-server` JAR |
| `runtime` | `core` 加 `zeppelin-interpreter`、`zeppelin-interpreter-shaded` JAR |
| `web+core` | WAR 与两个核心 JAR |
| `web+runtime` | WAR 与四个运行时 JAR |

`core` 适用于只改 notebook/server 逻辑的版本。解释器公共 API 或配置有变更时，
选 `runtime`；其他独立解释器模块的变更不在本流程范围内，不能当作 `runtime`
自动覆盖。范围由发布人根据代码兼容性确认，脚本不从目录中残留的文件推断。

## 本地准备

先将 Zeppelin 源码提交，工作区必须干净。再执行：

```bash
bash scripts/prepare_zeppelin_release.sh \
  --scope web+core \
  --cluster ns3
```

默认发布父目录为 `/Users/yao/projects/video_hadoop3_update/zeppelin_deploy`；
其他工作环境可用 `--release-parent /YOUR_GIT_RELEASE_DIRECTORY` 指定。
脚本自动构建所选模块及 Maven 构建依赖，但只将发布范围内的 WAR/JAR 放入版本目录。
`build_zeppelin_web_release.sh` 只负责在 `zeppelin-web/target/` 生成 WAR，不再单独复制到发布目录。
WAR 在制品目录中带日期时间和源码提交号，清单会把它映射到服务器原有的标准 WAR 文件名。
检查 `manifest.tsv`、产物和源码提交号后，在制品仓库**仅暂存这个版本目录**，再
commit、推送到 `origin` 和 `gitee`。不要把工作区其他文件或旧发布目录一起提交。

## 服务器发布

先在服务器制品仓库 `git pull`，选择明确的 `<release-id>`。核对服务器
`zeppelin.audit.cluster.name` 与清单的集群一致；`CLUSTER_NAME` 是操作人输入，
脚本不会自动读取该配置。发布 WAR 时还要确认实际生效的 `zeppelin.war` 指向清单中的
标准 WAR 目标文件。再执行只读预检：

默认 `ZEPPELIN_HOME=/data/cdh/zeppelin-0.9.1-SNAPSHOT`，
`BACKUP_ROOT=/data/cdh/zeppelin-deploy-backup`。备份父目录需提前建好并确保执行账号可写；
两者均可通过同名环境变量覆盖。

```bash
CLUSTER_NAME=ns3 \
  bash /YOUR_RELEASE_REPO/zeppelin_deploy/<release-id>/deploy.sh --dry-run
```

确认集群、文件清单和校验值后，在维护窗口等待运行任务完成并停止 Zeppelin。
部署脚本不会自行停服、启动服务或提权。执行账号须能写安装目录和备份目录；
确认进程已停止后再执行：

```bash
CLUSTER_NAME=ns3 CONFIRM_STOPPED=1 \
  bash /YOUR_RELEASE_REPO/zeppelin_deploy/<release-id>/deploy.sh --apply
```

脚本先备份并校验**本次清单中的**旧文件，再在目标目录内准备新文件，最后逐个替换。
所有文件校验通过后才提示完成。完成后启动 Zeppelin，检查页面、API、解释器
以及本次变更涉及的功能。集群间独立选择版本，不能把 `ns3` 版本误装到 `ns1/ns2`。

## 回滚

验收失败时先停止 Zeppelin，使用**同一 release-id 和 BACKUP_ROOT** 回滚：

```bash
CLUSTER_NAME=ns3 CONFIRM_STOPPED=1 \
  bash /YOUR_RELEASE_REPO/zeppelin_deploy/<release-id>/deploy.sh --rollback
```

回滚脚本检查本地备份和当前文件，且只还原当次替换的文件。替换中途失败时会尝试
自动恢复；如果机器异常断电，可用上述命令从备份继续恢复。确认后再重启服务。
回滚不修改 `conf/`、`notebook/`、审计数据库或其他用户数据。`BACKUP_ROOT` 必须
位于 Zeppelin 安装目录之外，不要在验收前删除备份。发布和回滚若覆盖默认值，
必须使用同一个 `BACKUP_ROOT`。

旧的 `zeppelin_audit_depoly/update_zeppelin_audit_jars.sh` 和
`rollback_zeppelin_audit_jars.sh` 只适用于历史审计发布，**不要与新版本清单混用**。
原部署文档包含明文数据库口令；在扩大制品仓库访问范围或继续推送前应移除明文
并安排口令轮换，不能把它复制进新版本目录。
