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
import org.apache.commons.io.IOUtils;
import org.apache.zeppelin.interpreter.InterpreterContext;
import org.apache.zeppelin.user.AuthenticationInfo;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Properties;
import java.util.function.Supplier;

/** Authorizes a paragraph and prepares its complete command list before execution. */
final class ShellSecurityChecker {
  private static final Logger LOGGER = LoggerFactory.getLogger(ShellSecurityChecker.class);
  static final String EXEMPT_USERS = "zeppelin.shell.security.exempt.users";
  static final String TERMINAL_ENABLED = "zeppelin.shell.security.terminal.enabled";
  private static final List<String> CLIENTS = Arrays.asList("hadoop", "hdfs", "hive", "beeline");
  private static final List<String> FILE_COMMANDS =
      Arrays.asList("ls", "stat", "cat", "head", "tail", "mkdir", "cp", "rm");

  private final Supplier<UnixSystem> processIdentity;

  ShellSecurityChecker() {
    this(UnixSystem::new);
  }

  ShellSecurityChecker(Supplier<UnixSystem> processIdentity) {
    this.processIdentity = processIdentity;
  }

  List<CommandLine> prepare(String script, InterpreterContext context, Properties settings)
      throws Rejected {
    AuthenticationInfo auth = context.getAuthenticationInfo();
    try {
      String user = requireProcessUser(auth);
      if (isExempt(user, settings)) {
        LOGGER.info("Shell policy EXEMPT user={} note={} paragraph={}", user, context.getNoteId(),
            context.getParagraphId());
        return Collections.singletonList(CommandLine.parse("bash -c").addArgument(script, false));
      }
      List<CommandLine> commands = prepareRestricted(script, user, settings);
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
      return isExempt(requireProcessUser(auth), settings);
    } catch (Rejected e) {
      return false;
    }
  }

  private String requireProcessUser(AuthenticationInfo auth) throws Rejected {
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
    return user;
  }

  private static boolean isExempt(String user, Properties settings) {
    return Arrays.stream(settings.getProperty(EXEMPT_USERS, "").split(","))
        .map(String::trim).anyMatch(user::equals);
  }

  private List<CommandLine> prepareRestricted(String script, String user, Properties settings)
      throws Rejected {
    List<CommandLine> commands = new ArrayList<>();
    String[] lines = script.split("\\r\\n|\\n|\\r", -1);
    for (int i = 0; i < lines.length; i++) {
      String line = lines[i].trim();
      if (!line.isEmpty() && !line.startsWith("#")) {
        commands.add(prepareLine(lines[i], i + 1, user, settings));
      }
    }
    return commands;
  }

  private CommandLine prepareLine(String line, int lineNumber, String user, Properties settings)
      throws Rejected {
    List<String> args;
    try {
      args = ShellCommandParser.parse(line);
    } catch (IllegalArgumentException e) {
      throw new Rejected("SINGLE_COMMAND_REQUIRED", lineNumber);
    }
    String name = args.remove(0);
    if ("rm".equals(name) && (args.size() != 1 || args.get(0).isEmpty()
        || args.get(0).startsWith("-") || args.get(0).chars().anyMatch(
            c -> "*?[]".indexOf(c) >= 0))) {
      throw new Rejected("ARGUMENT_DENIED", lineNumber);
    }
    try {
      if (CLIENTS.contains(name)) {
        return configuredCommand(name, args, settings);
      }
      if (FILE_COMMANDS.contains(name)) {
        return prepareFileCommand(name, args, user, settings, lineNumber);
      }
    } catch (IOException | IllegalArgumentException e) {
      throw new Rejected("EXECUTABLE_UNAVAILABLE", lineNumber);
    }
    throw new Rejected("COMMAND_DENIED", lineNumber);
  }

  private CommandLine prepareFileCommand(String name, List<String> args, String user,
      Properties settings, int lineNumber) throws IOException, Rejected {
    List<String> helperArgs = new ArrayList<>(Arrays.asList("-I", "-B", "-c"));
    try (InputStream helper = ShellSecurityChecker.class.getResourceAsStream(
        "/restricted_file_ops.py")) {
      if (helper == null) {
        throw new Rejected("FILE_HELPER_UNAVAILABLE", lineNumber);
      }
      helperArgs.add(IOUtils.toString(helper, "UTF-8"));
    }
    helperArgs.add(user);
    helperArgs.add(name);
    helperArgs.addAll(args);
    return configuredCommand("python3", helperArgs, settings);
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
      super("根据安全管理规范，本段落未执行。"
          + (line > 0 ? "请检查第 " + line + " 行。" : "") + advice(reason));
      this.reason = reason;
      this.line = line;
    }

    private static String advice(String reason) {
      switch (reason) {
        case "AUTH_REQUIRED":
          return "请登录后再运行 Shell 段落。";
        case "USER_MISMATCH":
          return "当前账号不符合解释器的运行身份要求，请联系平台管理员检查用户模拟配置。";
        case "COMMAND_DENIED":
          return "该命令未获授权，请修改后重试。";
        case "SINGLE_COMMAND_REQUIRED":
          return "每行只能写一条命令。请检查引号，并移除管道、重定向或命令串联。";
        case "ARGUMENT_DENIED":
          return "删除操作只接受一个明确的文件路径，请去掉选项、通配符或多余路径后重试。";
        default:
          return "解释器执行配置不可用，请联系平台管理员。";
      }
    }
  }
}
