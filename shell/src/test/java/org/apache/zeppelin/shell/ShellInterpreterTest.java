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

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.sun.security.auth.module.UnixSystem;
import org.apache.zeppelin.interpreter.InterpreterException;
import org.apache.zeppelin.interpreter.InterpreterOutput;
import org.apache.zeppelin.user.AuthenticationInfo;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.util.Properties;

import org.apache.zeppelin.interpreter.InterpreterContext;
import org.apache.zeppelin.interpreter.InterpreterResult;
import org.apache.zeppelin.interpreter.InterpreterResult.Code;

public class ShellInterpreterTest {

  private ShellInterpreter shell;
  private UnixSystem processIdentity;
  private InterpreterContext context;
  private InterpreterResult result;

  @Before
  public void setUp() throws Exception {
    Properties p = new Properties();
    p.setProperty("shell.command.timeout.millisecs", "5000");
    p.setProperty("shell.command.timeout.check.interval", "1000");
    p.setProperty(ShellSecurityChecker.EXEMPT_USERS, "operator");
    processIdentity = mock(UnixSystem.class);
    when(processIdentity.getUsername()).thenReturn("operator");
    when(processIdentity.getUid()).thenReturn(1234L);
    shell = new ShellInterpreter(p, new ShellSecurityChecker(() -> processIdentity));
    context = InterpreterContext.builder()
            .setAuthenticationInfo(new AuthenticationInfo("operator"))
            .setInterpreterOut(new InterpreterOutput())
            .setParagraphId("paragraphId").build();
    shell.open();
  }

  @After
  public void tearDown() throws Exception {
    shell.close();
  }

  @Test
  public void test() throws InterpreterException {
    if (System.getProperty("os.name").startsWith("Windows")) {
      result = shell.interpret("dir", context);
    } else {
      result = shell.interpret("ls", context);
    }
    assertEquals(InterpreterResult.Code.SUCCESS, result.code());
    assertTrue(shell.getExecutorMap().isEmpty());
    // it should be fine to cancel a statement that has been completed.
    shell.cancel(context);
    assertTrue(shell.getExecutorMap().isEmpty());
  }

  @Test
  public void testInvalidCommand() throws InterpreterException {
    if (System.getProperty("os.name").startsWith("Windows")) {
      result = shell.interpret("invalid_command\ndir", context);
    } else {
      result = shell.interpret("invalid_command\nls", context);
    }
    assertEquals(Code.SUCCESS, result.code());
    assertTrue(shell.getExecutorMap().isEmpty());
  }

  @Test
  public void testShellTimeout() throws InterpreterException {
    if (System.getProperty("os.name").startsWith("Windows")) {
      result = shell.interpret("timeout 8", context);
    } else {
      result = shell.interpret("sleep 8", context);
    }
    // exit shell process because no output is produced during the timeout threshold
    assertEquals(Code.INCOMPLETE, result.code());
    assertTrue(result.message().get(0).getData().contains("Paragraph received a SIGTERM"));
  }

  @Test
  public void testShellTimeout2() throws InterpreterException {
    context = InterpreterContext.builder()
            .setParagraphId("paragraphId")
            .setAuthenticationInfo(new AuthenticationInfo("operator"))
            .setInterpreterOut(new InterpreterOutput())
            .build();
    result = shell.interpret("for i in {1..10}\ndo\n\tsleep 1\n\techo $i\ndone", context);
    // won't exit shell because the continues output is produced
    assertEquals(Code.SUCCESS, result.code());
    assertEquals("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n", context.out.toString());
  }

  @Test
  public void validatesEveryLineBeforeRunningAllowedCommandsInOrder() throws Exception {
    when(processIdentity.getUsername()).thenReturn("tenant");
    shell.setProperty("zeppelin.shell.security.executable.beeline", "/usr/bin/printf");
    shell.setProperty("zeppelin.shell.security.executable.hadoop", "/usr/bin/printf");
    shell.setProperty("zeppelin.shell.security.executable.hive", "/usr/bin/printf");
    shell.setProperty("zeppelin.shell.security.executable.yarn", "/usr/bin/printf");
    InterpreterContext tenant = InterpreterContext.builder().setParagraphId("tenant")
        .setInterpreterOut(new InterpreterOutput())
        .setAuthenticationInfo(new AuthenticationInfo("tenant")).build();
    result = shell.interpret("# comment\nhadoop '%s' first\n\nssh YOUR_HOST", tenant);
    assertEquals(Code.ERROR, result.code());
    assertEquals("安全拦截：本段落未执行（请检查第 4 行）："
        + "不支持该命令（仅支持 hadoop、hdfs、hive、beeline、yarn，"
        + "本地文件命令 ls、stat、cat、head、tail、mkdir、cp、rm，"
        + "以及管道过滤 grep、head、tail、wc -l）。",
        result.message().get(0).getData());
    assertEquals("", tenant.out.toString());
    for (String input : new String[] {"beeline '%s' 'select 1' # comment\nssh YOUR_HOST",
        "hadoop '%s' first\nbeeline '%s' second | blocked", "ssh YOUR_HOST",
        "beeline '%s' 'select 1' | grep ods /etc/passwd", "grep ods /etc/passwd",
        "beeline '%s' 'select 1' || grep ods", "beeline '%s' 'select 1' |",
        "hadoop fs -rm /", "hadoop fs -rm hdfs://ns1/", "hadoop fs -rm /user/..",
        "hadoop fs -rm -r /user/tenant/dir", "hadoop fs -rm -R /user/tenant/dir",
        "hadoop fs -rm -rf /user/tenant/dir", "hadoop fs -rmr /user/tenant/dir",
        "hadoop fs -rmdir /user/tenant/dir", "hadoop fs -rm -skipTrash /user/tenant/file",
        "hadoop fs -rm '/user/tenant/*.txt'", "hadoop fs -rm '/user/tenant/{a,b}'",
        "hadoop '%s' first\nrm -rf YOUR_TEST_PATH", "rm 'YOUR_TEST_PATH/*'", "rm one two"}) {
      assertEquals(Code.ERROR, shell.interpret(input, tenant).code());
      assertEquals("", tenant.out.toString());
    }
    assertEquals(Code.SUCCESS,
        shell.interpret("hadoop '%s' fs -rm /user/tenant/file.txt", tenant).code());
    assertEquals("fs-rm/user/tenant/file.txt", tenant.out.toString());
    tenant.out.clear();
    assertEquals(Code.SUCCESS, shell.interpret(
        "# start\r\nhadoop '%s' 'first: '\r\n\r\n"
        + "beeline '%s' 'select 1; /outside/path' # last\r\n", tenant).code());
    assertEquals("first: select 1; /outside/path", tenant.out.toString());
    assertEquals(Code.SUCCESS, shell.interpret(
        "beeline '%s\\n' 'dim_user' 'ods_order' 'ODS_PAY' 'dwd_log' | grep -i ods | tail -n 1\n"
        + "beeline '%s\\n' 'ods_1' 'ods_2' 'dim_1' | grep ods | wc -l\n"
        + "hive '%s\\n' \"\n  select 1;\n  select 2;\n\" | grep 'select 2'\n"
        + "yarn \\\n  '%s\\n' \\\n  'application_1' | grep application", tenant).code());
    assertEquals("first: select 1; /outside/pathODS_PAY\n2\n  select 2;\napplication_1\n",
        tenant.out.toString());
    InterpreterResult blockedPath = shell.interpret(
        "hadoop '%s' skipped\ncat /YOUR_OUTSIDE_PATH/example.txt", tenant);
    assertEquals(Code.ERROR, blockedPath.code());
    assertTrue(blockedPath.message().get(0).getData().contains("请检查第 2 行）：不允许访问该路径"));
    assertEquals("first: select 1; /outside/pathODS_PAY\n2\n  select 2;\napplication_1\n",
        tenant.out.toString());
    assertEquals(Code.ERROR, shell.interpret("echo wrong-user", context).code());
    assertEquals(Code.ERROR, shell.interpret("#;;;\necho wrong-user", context).code());
    assertEquals(Code.ERROR, shell.interpret("# comment\n#;;;\nssh YOUR_HOST", tenant).code());
    assertEquals(Code.ERROR,
        shell.interpret("hadoop '%s' first\n#;;;\nssh YOUR_HOST", tenant).code());
    assertEquals(Code.SUCCESS,
        shell.interpret("\n#;;; bypass\nprintf ' bypassed' | tr a-z A-Z", tenant).code());
    assertEquals("first: select 1; /outside/pathODS_PAY\n2\n  select 2;\napplication_1\n BYPASSED",
        tenant.out.toString());
  }

  @Test(timeout = 5000)
  public void cancelDoesNotDeadlockWithoutExternalProcess() throws Exception {
    when(processIdentity.getUsername()).thenReturn("tenant");
    final InterpreterContext[] holder = new InterpreterContext[1];
    InterpreterOutput cancellingOut = new InterpreterOutput() {
      @Override
      public long getLastWriteTimestamp() {
        shell.cancel(holder[0]);
        return super.getLastWriteTimestamp();
      }
    };
    InterpreterContext tenant = InterpreterContext.builder().setParagraphId("tenant-file")
        .setInterpreterOut(cancellingOut)
        .setAuthenticationInfo(new AuthenticationInfo("tenant")).build();
    holder[0] = tenant;
    result = shell.interpret("ls", tenant);
    assertEquals(Code.INCOMPLETE, result.code());
    assertTrue(shell.getExecutorMap().isEmpty());
  }

  @Test
  public void stopsAfterAnAllowedCommandFails() throws Exception {
    when(processIdentity.getUsername()).thenReturn("tenant");
    shell.setProperty("zeppelin.shell.security.executable.hadoop", "/usr/bin/false");
    shell.setProperty("zeppelin.shell.security.executable.beeline", "/usr/bin/printf");
    InterpreterContext tenant = InterpreterContext.builder().setParagraphId("tenant")
        .setInterpreterOut(new InterpreterOutput())
        .setAuthenticationInfo(new AuthenticationInfo("tenant")).build();
    assertEquals(Code.ERROR, shell.interpret("hadoop\nbeeline '%s' skipped", tenant).code());
    assertEquals("", tenant.out.toString());
  }

  @Test
  public void terminalCannotStartByDefault() throws Exception {
    TerminalInterpreter terminal = new TerminalInterpreter(new Properties());
    result = terminal.internalInterpret("", context);
    assertEquals(Code.ERROR, result.code());
    assertTrue(result.message().get(0).getData().contains("交互终端（%sh.terminal）已关闭"));
    assertTrue(!terminal.terminalThreadIsRunning());
    terminal.close();
  }

  @Test
  public void terminalRejectsExemptAccountWhenProcessIdentityDiffers() {
    Properties settings = new Properties();
    settings.setProperty(ShellSecurityChecker.TERMINAL_ENABLED, "true");
    settings.setProperty(ShellSecurityChecker.EXEMPT_USERS, "operator");
    when(processIdentity.getUsername()).thenReturn("tenant");
    TerminalInterpreter terminal =
        new TerminalInterpreter(settings, new ShellSecurityChecker(() -> processIdentity));
    assertEquals(Code.ERROR, terminal.internalInterpret("", context).code());
    assertTrue(!terminal.terminalThreadIsRunning());
    terminal.close();
  }
}
