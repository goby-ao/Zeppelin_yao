/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package org.apache.zeppelin.shell;

import com.sun.security.auth.module.UnixSystem;
import org.apache.commons.exec.CommandLine;
import org.apache.commons.exec.DefaultExecutor;
import org.apache.zeppelin.interpreter.InterpreterContext;
import org.apache.zeppelin.user.AuthenticationInfo;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Properties;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/** Authorizes a paragraph and prepares its complete command list before execution. */
final class ShellSecurityChecker {
  private static final Logger LOGGER = LoggerFactory.getLogger(ShellSecurityChecker.class);
  static final String EXEMPT_USERS = "zeppelin.shell.security.exempt.users";
  static final String TERMINAL_ENABLED = "zeppelin.shell.security.terminal.enabled";
  private static final String BYPASS_PREFIX = "#;;;";
  private static final List<String> CLIENTS =
      Arrays.asList("hadoop", "hdfs", "hive", "beeline", "yarn");
  private static final List<String> FILE_COMMANDS =
      Arrays.asList("ls", "stat", "cat", "head", "tail", "mkdir", "cp", "rm");

  private final Supplier<UnixSystem> processIdentity;

  ShellSecurityChecker() {
    this(UnixSystem::new);
  }

  ShellSecurityChecker(Supplier<UnixSystem> processIdentity) {
    this.processIdentity = processIdentity;
  }

  List<Command> prepare(String script, InterpreterContext context, Properties settings)
      throws Rejected {
    AuthenticationInfo auth = context.getAuthenticationInfo();
    try {
      UnixSystem identity = requireProcessUser(auth);
      String user = identity.getUsername();
      if (isExempt(user, settings) || hasBypassPrefix(script)) {
        LOGGER.info("Shell policy EXEMPT user={} note={} paragraph={}", user, context.getNoteId(),
            context.getParagraphId());
        return Collections.singletonList(
            external(CommandLine.parse("bash -c").addArgument(script, false)));
      }
      List<Command> commands = prepareRestricted(script, user, identity.getUid(), settings);
      LOGGER.info("Shell policy DISPATCH user={} note={} paragraph={} commands={}", user,
          context.getNoteId(), context.getParagraphId(), commands.size());
      return commands;
    } catch (Rejected e) {
      LOGGER.info("Shell policy BLOCKED user={} note={} paragraph={} reason={} line={}",
          auth == null ? "" : auth.getUser(), context.getNoteId(), context.getParagraphId(),
          e.reason, e.line);
      throw e;
    }
  }

  boolean allowsTerminal(AuthenticationInfo auth, Properties settings) {
    if (!Boolean.parseBoolean(settings.getProperty(TERMINAL_ENABLED, "false"))) {
      return false;
    }
    try {
      return isExempt(requireProcessUser(auth).getUsername(), settings);
    } catch (Rejected e) {
      return false;
    }
  }

  private UnixSystem requireProcessUser(AuthenticationInfo auth) throws Rejected {
    if (auth == null || auth.isAnonymous()) {
      throw new Rejected("AUTH_REQUIRED", 0);
    }
    String user = auth.getUser();
    if (!user.matches("[A-Za-z0-9_][A-Za-z0-9_.@-]*")
        || System.getProperty("os.name").startsWith("Windows")) {
      throw new Rejected("USER_MISMATCH", 0);
    }
    UnixSystem identity = processIdentity.get();
    if (identity.getUid() == 0 || !user.equals(identity.getUsername())) {
      throw new Rejected("USER_MISMATCH", 0);
    }
    return identity;
  }

  private static boolean isExempt(String user, Properties settings) {
    return Arrays.stream(settings.getProperty(EXEMPT_USERS, "").split(","))
        .map(String::trim).anyMatch(user::equals);
  }

  private static boolean hasBypassPrefix(String script) {
    for (String line : script.split("\\r\\n|\\n|\\r", -1)) {
      String trimmed = line.trim();
      if (!trimmed.isEmpty()) {
        return trimmed.startsWith(BYPASS_PREFIX);
      }
    }
    return false;
  }

  private List<Command> prepareRestricted(String script, String user, long uid, Properties settings)
      throws Rejected {
    List<Command> commands = new ArrayList<>();
    String[] lines = script.split("\\r\\n|\\n|\\r", -1);
    StringBuilder statement = new StringBuilder();
    int startLine = 0;
    char quote = 0;
    for (int i = 0; i < lines.length; i++) {
      String line = lines[i];
      if (statement.length() == 0) {
        String trimmed = line.trim();
        if (trimmed.isEmpty() || trimmed.startsWith("#")) {
          continue;
        }
        startLine = i + 1;
      } else {
        statement.append('\n');
      }
      statement.append(line);
      boolean continued = false;
      boolean escaped = false;
      boolean inWord = quote != 0;
      boolean hasTokens = quote != 0;
      for (int j = 0; j < line.length(); j++) {
        char c = line.charAt(j);
        if (escaped) {
          escaped = false;
          inWord = true;
        } else if (c == '\\' && quote != '\'') {
          if ((quote == 0 && isTrailingHorizontalWhitespace(line, j + 1))
              || (quote == '"' && j + 1 == line.length())) {
            continued = true;
            break;
          }
          escaped = true;
          inWord = true;
        } else if (quote != 0 && c == quote) {
          quote = 0;
        } else if (quote == 0 && (c == '\'' || c == '"')) {
          quote = c;
          inWord = true;
        } else if (quote == 0 && c == '#' && !inWord && hasTokens) {
          break;
        } else if (quote == 0 && Character.isWhitespace(c)) {
          if (inWord) {
            hasTokens = true;
            inWord = false;
          }
        } else {
          inWord = true;
        }
      }
      if (quote == 0 && !continued) {
        commands.add(prepareLine(statement.toString(), startLine, user, uid, settings));
        statement.setLength(0);
      }
    }
    if (statement.length() > 0) {
      commands.add(prepareLine(statement.toString(), startLine, user, uid, settings));
    }
    return commands;
  }

  private static boolean isTrailingHorizontalWhitespace(String line, int startIndex) {
    for (int i = startIndex; i < line.length(); i++) {
      char c = line.charAt(i);
      if (c != ' ' && c != '\t') {
        return false;
      }
    }
    return true;
  }

  private Command prepareLine(String line, int lineNumber, String user, long uid,
      Properties settings)
      throws Rejected {
    List<List<String>> pipeline;
    try {
      pipeline = ShellCommandParser.parsePipeline(line);
    } catch (IllegalArgumentException e) {
      throw new Rejected("SINGLE_COMMAND_REQUIRED", lineNumber);
    }
    Command command = preparePrimaryCommand(pipeline.get(0), lineNumber, user, uid, settings);
    if (pipeline.size() == 1) {
      return command;
    }
    List<ShellPipeFilter> filters = new ArrayList<>(pipeline.size() - 1);
    for (int i = 1; i < pipeline.size(); i++) {
      List<String> stageArgs = pipeline.get(i);
      String filterName = stageArgs.remove(0);
      if (!ShellPipeFilter.supports(filterName)) {
        throw new Rejected("COMMAND_DENIED", lineNumber);
      }
      try {
        filters.add(ShellPipeFilter.prepare(filterName, stageArgs));
      } catch (RestrictedFileCommand.Denied e) {
        throw new Rejected(e.getMessage(), lineNumber);
      }
    }
    return ShellPipeFilter.chain(command, filters);
  }

  private Command preparePrimaryCommand(List<String> args, int lineNumber, String user, long uid,
      Properties settings)
      throws Rejected {
    String name = args.remove(0);
    if ("rm".equals(name) && (args.size() != 1 || args.get(0).isEmpty()
        || args.get(0).startsWith("-") || args.get(0).chars().anyMatch(
            c -> "*?[]".indexOf(c) >= 0))) {
      throw new Rejected("ARGUMENT_DENIED", lineNumber);
    }
    try {
      if (CLIENTS.contains(name)) {
        validateClientArguments(name, args, lineNumber);
        return external(configuredCommand(name, args, settings));
      }
      if (FILE_COMMANDS.contains(name)) {
        RestrictedFileCommand fileCommand = RestrictedFileCommand.prepare(name, args, user, uid);
        return (executor, out, cancelled) -> fileCommand.execute(out, cancelled);
      }
    } catch (RestrictedFileCommand.Denied e) {
      throw new Rejected(e.getMessage(), lineNumber);
    } catch (IllegalArgumentException e) {
      throw new Rejected("EXECUTABLE_UNAVAILABLE", lineNumber);
    }
    throw new Rejected("COMMAND_DENIED", lineNumber);
  }

  private static void validateClientArguments(String name, List<String> args, int lineNumber)
      throws Rejected {
    if (!"hadoop".equals(name) && !"hdfs".equals(name)) {
      return;
    }
    for (int i = 0; i < args.size(); i++) {
      String arg = args.get(i);
      if ("-rmr".equalsIgnoreCase(arg) || "-rmdir".equalsIgnoreCase(arg)) {
        throw new Rejected("HDFS_RM_DENIED", lineNumber);
      }
      if ("-rm".equalsIgnoreCase(arg)) {
        validateHdfsRmArguments(args.subList(i + 1, args.size()), lineNumber);
        return;
      }
    }
  }

  private static void validateHdfsRmArguments(List<String> rmArgs, int lineNumber)
      throws Rejected {
    int pathCount = 0;
    for (String arg : rmArgs) {
      if (arg.isEmpty()) {
        throw new Rejected("HDFS_RM_DENIED", lineNumber);
      }
      if (arg.startsWith("-")) {
        if (!"-f".equals(arg)) {
          throw new Rejected("HDFS_RM_DENIED", lineNumber);
        }
        continue;
      }
      if (!isAllowedHdfsDeletePath(arg)) {
        throw new Rejected("HDFS_RM_DENIED", lineNumber);
      }
      pathCount++;
    }
    if (pathCount == 0) {
      throw new Rejected("HDFS_RM_DENIED", lineNumber);
    }
  }

  private static boolean isAllowedHdfsDeletePath(String rawPath) {
    if (rawPath.chars().anyMatch(c -> "*?[]{}".indexOf(c) >= 0)) {
      return false;
    }
    String pathPart = rawPath;
    int schemeIndex = rawPath.indexOf("://");
    if (schemeIndex >= 0) {
      int slashIndex = rawPath.indexOf('/', schemeIndex + 3);
      if (slashIndex < 0) {
        return false;
      }
      pathPart = rawPath.substring(slashIndex);
    } else if (rawPath.contains(":")) {
      return false;
    }
    int validSegments = 0;
    for (String segment : pathPart.split("/")) {
      if (segment.isEmpty()) {
        continue;
      }
      if (".".equals(segment) || "..".equals(segment)) {
        return false;
      }
      validSegments++;
    }
    return validSegments > 0;
  }

  @FunctionalInterface
  interface Command {
    void execute(DefaultExecutor executor, OutputStream out, BooleanSupplier cancelled)
        throws IOException;
  }

  private static Command external(CommandLine command) {
    return (executor, out, cancelled) -> executor.execute(command);
  }

  private static CommandLine configuredCommand(String name, List<String> args,
      Properties settings) {
    String path = settings.getProperty("zeppelin.shell.security.executable." + name,
        "/usr/bin/" + name);
    if (!Paths.get(path).isAbsolute()) {
      throw new IllegalArgumentException("Executable must be an absolute path");
    }
    String[] argv = new String[args.size() + 1];
    argv[0] = path;
    for (int i = 0; i < args.size(); i++) {
      argv[i + 1] = args.get(i);
    }
    return new CommandLine(path) {
      @Override
      public String[] toStrings() {
        // Commons Exec addArgument() trims even arguments with quoting disabled.
        return argv.clone();
      }
    };
  }

  static final class Rejected extends Exception {
    private final String reason;
    private final int line;

    private Rejected(String reason, int line) {
      super("安全拦截：本段落未执行"
          + (line > 0 ? "（请检查第 " + line + " 行）：" : "：") + advice(reason));
      this.reason = reason;
      this.line = line;
    }

    private static String advice(String reason) {
      switch (reason) {
        case "AUTH_REQUIRED":
          return "请先登录 Zeppelin 后再执行命令。";
        case "USER_MISMATCH":
          return "当前登录账号与解释器进程账号不一致（或进程为 root），请联系管理员检查 sh 解释器的用户隔离（User Impersonate）配置。";
        case "COMMAND_DENIED":
          return "不支持该命令（仅支持 hadoop、hdfs、hive、beeline、yarn，"
              + "本地文件命令 ls、stat、cat、head、tail、mkdir、cp、rm，"
              + "以及管道过滤 grep、head、tail、wc -l）。";
        case "SINGLE_COMMAND_REQUIRED":
          return "包含不支持的 Shell 语法。每行仅支持单条命令（可接 | grep/head/tail/wc -l 管道），"
              + "请检查引号是否闭合，并去掉 > 重定向、&& / ; 多命令拼接或 $() 变量替换。";
        case "ARGUMENT_DENIED":
          return "rm 仅支持删除单个具体文件，不支持 -r / -f 等选项、* 通配符或同时删除多个路径。";
        case "HDFS_RM_DENIED":
          return "HDFS 删除仅支持删除单个具体文件，禁止递归删除目录（-r/-R/-rmr/-rmdir）、跳过回收站（-skipTrash）、使用 * 通配符或删除根目录。";
        case "FILE_ARGUMENT_DENIED":
          return "文件命令参数不支持（ls 仅支持 -l/-a/-h/-t/-r；head/tail 仅支持 -n 1~1000；"
              + "mkdir 仅支持 -p；cp 需指定源文件和新目标文件路径）。";
        case "PIPE_ARGUMENT_DENIED":
          return "管道过滤参数不支持（grep 仅支持 -i/-v/-F/-E/-n/-c/-e 且不能带文件名；"
              + "head/tail 仅支持 -n 1~1000；wc 仅支持 -l）。";
        case "PATH_DENIED":
          return "不允许访问该路径。本地文件操作仅限个人家目录（/home/<用户名>）和个人临时目录（/tmp/zeppelin/<用户名>），"
              + "且禁止包含 .. 或访问 .ssh、.bashrc、.keytab 等敏感文件。";
        default:
          return "客户端命令路径配置有误（需为绝对路径），请联系管理员检查 sh 解释器配置。";
      }
    }
  }
}
