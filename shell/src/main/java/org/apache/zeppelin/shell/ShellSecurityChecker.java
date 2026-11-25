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
import org.apache.commons.exec.PumpStreamHandler;
import org.apache.zeppelin.interpreter.InterpreterContext;
import org.apache.zeppelin.user.AuthenticationInfo;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Properties;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/** Authorizes a paragraph and prepares its complete command list before execution. */
final class ShellSecurityChecker {
  private static final Logger LOGGER = LoggerFactory.getLogger(ShellSecurityChecker.class);
  static final String SECURITY_ENABLED = "zeppelin.shell.security.enabled";
  static final String EXEMPT_USERS = "zeppelin.shell.security.exempt.users";
  static final String TERMINAL_ENABLED = "zeppelin.shell.security.terminal.enabled";
  private static final String BYPASS_PREFIX = "#;;;";
  private static final List<String> CLIENTS =
      Arrays.asList("hadoop", "hdfs", "hive", "beeline", "yarn", "hbase");
  private static final List<String> FILE_COMMANDS =
      Arrays.asList("ls", "stat", "cat", "head", "tail", "mkdir", "cp", "rm");
  private static final List<String> HBASE_DENIED_TOKENS = Arrays.asList(
      "drop", "drop_all", "truncate", "truncate_preserve", "disable", "disable_all",
      "drop_namespace", "shutdown", "stop_master", "stop_regionserver",
      "system", "exec", "spawn", "eval", "popen", "kernel", "open3", "load", "require");
  private static final List<String> HBASE_BLOCKED_SUBCOMMANDS = Arrays.asList(
      "shell", "master", "regionserver", "zookeeper", "rest", "thrift", "thrift2",
      "clean", "hbck", "jshell");

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
    if (!isSecurityEnabled(settings)) {
      LOGGER.info("Shell policy DISABLED user={} note={} paragraph={}",
          auth == null ? "" : auth.getUser(), context.getNoteId(), context.getParagraphId());
      return Collections.singletonList(
          external(CommandLine.parse("bash -c").addArgument(script, false)));
    }
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
    if (!isSecurityEnabled(settings)) {
      return true;
    }
    if (!Boolean.parseBoolean(settings.getProperty(TERMINAL_ENABLED, "false"))) {
      return false;
    }
    try {
      return isExempt(requireProcessUser(auth).getUsername(), settings);
    } catch (Rejected e) {
      return false;
    }
  }

  private static boolean isSecurityEnabled(Properties settings) {
    return Boolean.parseBoolean(settings.getProperty(SECURITY_ENABLED, "true"));
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
    ShellCommandParser.ParsedLine parsed;
    try {
      parsed = ShellCommandParser.parseCommandLine(line);
    } catch (IllegalArgumentException e) {
      throw new Rejected("SINGLE_COMMAND_REQUIRED", lineNumber);
    }
    List<List<String>> pipeline = parsed.stages;
    Command command;
    int filterStartIndex;
    if (pipeline.size() >= 2 && "echo".equals(pipeline.get(0).get(0))
        && "hbase".equals(pipeline.get(1).get(0))) {
      command = prepareEchoHbaseCommand(pipeline.get(0), pipeline.get(1), lineNumber, settings);
      filterStartIndex = 2;
    } else {
      command = preparePrimaryCommand(pipeline.get(0), lineNumber, user, uid, settings);
      filterStartIndex = 1;
    }
    if (pipeline.size() > filterStartIndex) {
      List<ShellPipeFilter> filters = new ArrayList<>(pipeline.size() - filterStartIndex);
      for (int i = filterStartIndex; i < pipeline.size(); i++) {
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
      command = ShellPipeFilter.chain(command, filters);
    }
    if (parsed.redirectTarget != null) {
      try {
        RestrictedFileCommand.RedirectTarget target = RestrictedFileCommand.prepareRedirect(
            parsed.redirectTarget, parsed.redirectAppend, user, uid);
        command = redirect(command, target);
      } catch (RestrictedFileCommand.Denied e) {
        throw new Rejected(e.getMessage(), lineNumber, user);
      }
    }
    return command;
  }

  private Command prepareEchoHbaseCommand(List<String> echoStage, List<String> hbaseStage,
      int lineNumber, Properties settings) throws Rejected {
    List<String> echoArgs = echoStage.subList(1, echoStage.size());
    byte[] stdin = parseEchoHbaseScript(echoArgs, lineNumber);
    List<String> hbaseArgs = hbaseStage.subList(1, hbaseStage.size());
    if (hbaseArgs.isEmpty() || !"shell".equals(hbaseArgs.get(0)) || hbaseArgs.size() > 2
        || (hbaseArgs.size() == 2 && !"-n".equals(hbaseArgs.get(1))
            && !"--non-interactive".equals(hbaseArgs.get(1)))) {
      throw new Rejected("HBASE_COMMAND_DENIED", lineNumber);
    }
    try {
      return external(configuredCommand("hbase", hbaseArgs, settings), stdin);
    } catch (IllegalArgumentException e) {
      throw new Rejected("EXECUTABLE_UNAVAILABLE", lineNumber);
    }
  }

  private static byte[] parseEchoHbaseScript(List<String> echoArgs, int lineNumber)
      throws Rejected {
    boolean interpretEscapes = false;
    int index = 0;
    while (index < echoArgs.size() && echoArgs.get(index).startsWith("-")) {
      String opt = echoArgs.get(index);
      if ("-e".equals(opt) || "-en".equals(opt) || "-ne".equals(opt)) {
        interpretEscapes = true;
      } else if (!"-n".equals(opt)) {
        throw new Rejected("HBASE_COMMAND_DENIED", lineNumber);
      }
      index++;
    }
    List<String> words = echoArgs.subList(index, echoArgs.size());
    if (words.isEmpty()) {
      throw new Rejected("HBASE_COMMAND_DENIED", lineNumber);
    }
    String script = String.join(" ", words);
    if (interpretEscapes) {
      script = script.replace("\\n", "\n").replace("\\r", "\r").replace("\\t", "\t");
    }
    validateHbaseShellScript(script, lineNumber);
    return (script + "\n").getBytes(StandardCharsets.UTF_8);
  }

  private static void validateHbaseShellScript(String script, int lineNumber) throws Rejected {
    if (script.trim().isEmpty()) {
      throw new Rejected("HBASE_COMMAND_DENIED", lineNumber);
    }
    char quote = 0;
    boolean escaped = false;
    StringBuilder token = new StringBuilder();
    for (int i = 0; i <= script.length(); i++) {
      char c = i < script.length() ? script.charAt(i) : ' ';
      if (escaped) {
        escaped = false;
      } else if (c == '\\' && quote != '\'') {
        escaped = true;
      } else if (quote != 0 && c == quote) {
        quote = 0;
      } else if (quote == 0 && (c == '\'' || c == '"')) {
        checkHbaseToken(token, lineNumber);
        quote = c;
      } else if (quote == 0 && (c == '`' || (c == '%' && i + 1 < script.length()
          && (script.charAt(i + 1) == 'x' || script.charAt(i + 1) == 'X')))) {
        throw new Rejected("HBASE_DROP_DENIED", lineNumber);
      } else if (quote == 0 && (Character.isLetterOrDigit(c) || c == '_')) {
        token.append(c);
      } else if (quote == 0) {
        checkHbaseToken(token, lineNumber);
      }
    }
    if (quote != 0 || escaped) {
      throw new Rejected("HBASE_COMMAND_DENIED", lineNumber);
    }
  }

  private static void checkHbaseToken(StringBuilder token, int lineNumber) throws Rejected {
    if (token.length() == 0) {
      return;
    }
    String word = token.toString().toLowerCase(Locale.ROOT);
    token.setLength(0);
    if (HBASE_DENIED_TOKENS.contains(word)) {
      throw new Rejected("HBASE_DROP_DENIED", lineNumber);
    }
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
      if ("echo".equals(name)) {
        byte[] output = formatEchoOutput(args);
        return (executor, out, err, cancelled) -> {
          out.write(output);
          out.flush();
        };
      }
      if (CLIENTS.contains(name)) {
        validateClientArguments(name, args, lineNumber);
        return external(configuredCommand(name, args, settings));
      }
      if (FILE_COMMANDS.contains(name)) {
        RestrictedFileCommand fileCommand = RestrictedFileCommand.prepare(name, args, user, uid);
        return (executor, out, err, cancelled) -> fileCommand.execute(out, cancelled);
      }
    } catch (RestrictedFileCommand.Denied e) {
      throw new Rejected(e.getMessage(), lineNumber, user);
    } catch (IllegalArgumentException e) {
      throw new Rejected("EXECUTABLE_UNAVAILABLE", lineNumber);
    }
    throw new Rejected("COMMAND_DENIED", lineNumber);
  }

  private static byte[] formatEchoOutput(List<String> args) {
    boolean noNewline = false;
    boolean interpretEscapes = false;
    int index = 0;
    while (index < args.size() && args.get(index).startsWith("-")
        && args.get(index).length() > 1 && args.get(index).substring(1).matches("[ne]+")) {
      String opt = args.get(index);
      if (opt.contains("n")) {
        noNewline = true;
      }
      if (opt.contains("e")) {
        interpretEscapes = true;
      }
      index++;
    }
    String text = String.join(" ", args.subList(index, args.size()));
    if (interpretEscapes) {
      text = text.replace("\\n", "\n").replace("\\r", "\r").replace("\\t", "\t");
    }
    return (noNewline ? text : text + "\n").getBytes(StandardCharsets.UTF_8);
  }

  private static void validateClientArguments(String name, List<String> args, int lineNumber)
      throws Rejected {
    if ("hbase".equals(name)) {
      validateDirectHbaseArguments(args, lineNumber);
      return;
    }
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

  private static void validateDirectHbaseArguments(List<String> args, int lineNumber)
      throws Rejected {
    if (args.isEmpty()) {
      throw new Rejected("HBASE_COMMAND_DENIED", lineNumber);
    }
    for (String arg : args) {
      String lower = arg.toLowerCase(Locale.ROOT);
      if (HBASE_BLOCKED_SUBCOMMANDS.contains(lower) || lower.contains("jruby")
          || lower.startsWith("org.") || lower.startsWith("com.")) {
        throw new Rejected("HBASE_COMMAND_DENIED", lineNumber);
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
    void execute(DefaultExecutor executor, OutputStream out, OutputStream err,
        BooleanSupplier cancelled) throws IOException;
  }

  private static Command external(CommandLine command) {
    return (executor, out, err, cancelled) -> {
      executor.setStreamHandler(new PumpStreamHandler(out, err));
      executor.execute(command);
    };
  }

  private static Command external(CommandLine command, byte[] stdin) {
    return (executor, out, err, cancelled) -> {
      executor.setStreamHandler(
          new PumpStreamHandler(out, err, new ByteArrayInputStream(stdin)));
      executor.execute(command);
    };
  }

  private static Command redirect(Command inner, RestrictedFileCommand.RedirectTarget target) {
    return (executor, out, err, cancelled) -> {
      try (OutputStream fileOut = target.openOutputStream(cancelled)) {
        inner.execute(executor, fileOut, err, cancelled);
        fileOut.flush();
      }
    };
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
      this(reason, line, null);
    }

    private Rejected(String reason, int line, String user) {
      super(formatMessage(reason, line, user));
      this.reason = reason;
      this.line = line;
    }

    private static String formatMessage(String reason, int line, String user) {
      StringBuilder message = new StringBuilder("[安全拦截] 根据安全管理要求，本次命令未执行\n");
      if (line > 0) {
        message.append("拦截位置：第 ").append(line).append(" 行\n");
      }
      message.append("拦截原因：").append(cause(reason)).append("\n");
      message.append("处理建议：").append(advice(reason, user));
      return message.toString();
    }

    private static String cause(String reason) {
      switch (reason) {
        case "AUTH_REQUIRED":
          return "当前未登录 Zeppelin 账号";
        case "USER_MISMATCH":
          return "登录账号与解释器运行账号不一致（或进程为 root）";
        case "COMMAND_DENIED":
          return "不支持该命令";
        case "SINGLE_COMMAND_REQUIRED":
          return "包含不支持的 Shell 语法";
        case "ARGUMENT_DENIED":
          return "本地 rm 删除参数不符合要求";
        case "HDFS_RM_DENIED":
          return "触发 HDFS 高危删除限制";
        case "HBASE_DROP_DENIED":
          return "触发 HBase 高危操作限制";
        case "HBASE_COMMAND_DENIED":
          return "HBase 命令格式不支持";
        case "FILE_ARGUMENT_DENIED":
          return "本地文件命令参数不支持";
        case "PIPE_ARGUMENT_DENIED":
          return "管道过滤命令参数不支持";
        case "PATH_DENIED":
          return "不允许访问该路径";
        default:
          return "解释器客户端路径配置异常";
      }
    }

    private static String advice(String reason, String user) {
      String displayUser = (user == null || user.isEmpty()) ? "<用户名>" : user;
      switch (reason) {
        case "AUTH_REQUIRED":
          return "请先登录 Zeppelin 后再执行命令。";
        case "USER_MISMATCH":
          return "请联系管理员检查 sh 解释器的用户隔离（User Impersonate）配置。";
        case "COMMAND_DENIED":
          return "仅支持 hadoop/hdfs/hive/beeline/yarn/hbase"
              + "（含 echo \"<命令>\" | hbase shell）、echo、"
              + "本地文件命令（ls/stat/cat/head/tail/mkdir/cp/rm）"
              + "及管道过滤（grep/head/tail/wc -l）。";
        case "SINGLE_COMMAND_REQUIRED":
          return "每行仅支持单条命令（可接 | grep/head/tail/wc -l 管道"
              + "及 > / >> 重定向至个人目录文件），请检查引号是否闭合，并移除 && / ; 拼接或 $() 替换。";
        case "ARGUMENT_DENIED":
          return "rm 仅支持删除单个具体文件，请去掉 -r / -f 等选项、* 通配符或多余路径后重试。";
        case "HDFS_RM_DENIED":
          return "仅支持删除单个具体文件，请去掉递归选项（-r/-R/-rmr/-rmdir）、"
              + "-skipTrash、通配符（*）及根目录后重试。";
        case "HBASE_DROP_DENIED":
          return "禁止执行 drop、truncate、disable 等删表/停表/清空表操作及系统命令，请修改后重试。";
        case "HBASE_COMMAND_DENIED":
          return "执行 HBase Shell 请使用 echo \"<命令>\" | hbase shell 方式"
              + "（如 echo \"list\" | hbase shell），不支持加载外部脚本文件或启动服务进程。";
        case "FILE_ARGUMENT_DENIED":
          return "ls 仅支持 -l/-a/-h/-t/-r；head/tail 仅支持 -n 1~1000；"
              + "mkdir 仅支持 -p；cp 需指定源文件和新目标文件路径。";
        case "PIPE_ARGUMENT_DENIED":
          return "grep 仅支持 -i/-v/-F/-E/-n/-c/-e 且不能带文件名；"
              + "head/tail 仅支持 -n 1~1000；wc 仅支持 -l。";
        case "PATH_DENIED":
          return "本地文件操作仅限个人家目录（/home/" + displayUser + "）和个人临时目录"
              + "（/tmp/zeppelin/" + displayUser + "），"
              + "且禁止使用 .. 或访问 .ssh、.bashrc、.keytab 等敏感文件。";
        default:
          return "客户端命令路径需配置为绝对路径，请联系管理员检查 sh 解释器配置。";
      }
    }
  }
}
