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

package org.apache.zeppelin.interpreter.remote;

import org.apache.thrift.TException;
import org.apache.zeppelin.interpreter.Interpreter;
import org.apache.zeppelin.interpreter.InterpreterContext;
import org.apache.zeppelin.interpreter.InterpreterException;
import org.apache.zeppelin.interpreter.InterpreterResult;
import org.apache.zeppelin.interpreter.LazyOpenInterpreter;
import org.apache.zeppelin.interpreter.thrift.InterpreterRPCException;
import org.apache.zeppelin.interpreter.thrift.RemoteInterpreterContext;
import org.apache.zeppelin.interpreter.thrift.RemoteInterpreterResult;
import org.junit.Test;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.Properties;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.times;

public class RemoteInterpreterServerTest {

  private RemoteInterpreterServer serverWithMock(Interpreter interpreter) throws Exception {
    RemoteInterpreterServer server = new RemoteInterpreterServer("localhost", 1, ":", "test", true);
    server.intpEventClient = mock(RemoteInterpreterEventClient.class);
    Map<String, String> properties = new HashMap<>();
    properties.put("zeppelin.interpreter.localRepo", "/tmp");
    server.createInterpreter("test", "session", Test1Interpreter.class.getName(), properties, "user");
    when(interpreter.getClassName()).thenReturn("blocked");
    server.getInterpreterGroup().put("session", new ArrayList<>(Arrays.asList(interpreter)));
    return server;
  }

  @Test
  public void closeFailureMustReachClientAndRetainIsolatedInstance() throws Exception {
    Interpreter interpreter = mock(Interpreter.class);
    doThrow(new InterpreterException("CloseSession failed")).when(interpreter).close();
    RemoteInterpreterServer server = serverWithMock(interpreter);
    for (int i = 0; i < 2; i++) {
      try {
        server.close("session", "blocked");
        fail("A failed close must not be acknowledged");
      } catch (InterpreterRPCException expected) {
        assertEquals(1, server.getInterpreterGroup().get("session").size());
      }
    }
    verify(interpreter, times(1)).close();
    try {
      server.getInterpreter("session", "blocked");
      fail("Failed instance must not accept more work");
    } catch (InterpreterRPCException expected) {
      assertTrue(expected.getErrorMessage().contains("failed to close"));
    }
  }

  @Test
  public void blockedCloseDoesNotHoldRemoteGroupMonitor() throws Exception {
    Interpreter interpreter = mock(Interpreter.class);
    CountDownLatch entered = new CountDownLatch(1);
    CountDownLatch release = new CountDownLatch(1);
    doAnswer(invocation -> { entered.countDown(); release.await(); return null; })
        .when(interpreter).close();
    RemoteInterpreterServer server = serverWithMock(interpreter);
    Interpreter other = mock(Interpreter.class);
    when(other.getClassName()).thenReturn("other");
    server.getInterpreterGroup().addInterpreterToSession(other, "other-session");
    ExecutorService callers = Executors.newFixedThreadPool(2);
    Future<?> close = callers.submit(() -> { server.close("session", "blocked"); return null; });
    try {
      assertTrue(entered.await(2, TimeUnit.SECONDS));
      assertEquals(other, callers.submit(() -> server.getInterpreter("other-session", "other"))
          .get(1, TimeUnit.SECONDS));
    } finally {
      release.countDown();
      close.get(3, TimeUnit.SECONDS);
      callers.shutdownNow();
    }
    assertTrue(server.getInterpreterGroup().get("session").isEmpty());
  }

  @Test
  public void testStartStop() throws Exception {
    RemoteInterpreterServer server = new RemoteInterpreterServer("localhost",
        RemoteInterpreterUtils.findRandomAvailablePortOnAllLocalInterfaces(), ":", "groupId", true);

    startRemoteInterpreterServer(server, 10 * 1000);
    stopRemoteInterpreterServer(server, 10 * 10000);
  }

  @Test
  public void testStartStopWithQueuedEvents() throws Exception {
    RemoteInterpreterServer server = new RemoteInterpreterServer("localhost",
        RemoteInterpreterUtils.findRandomAvailablePortOnAllLocalInterfaces(), ":", "groupId", true);
    server.intpEventClient = mock(RemoteInterpreterEventClient.class);
    startRemoteInterpreterServer(server, 10 * 1000);

    server.intpEventClient.onAppStatusUpdate("", "", "", "");
    stopRemoteInterpreterServer(server, 10 * 10000);
  }

  private void startRemoteInterpreterServer(RemoteInterpreterServer server, int timeout)
          throws InterruptedException, TException {
    assertEquals(false, server.isRunning());
    server.start();
    long startTime = System.currentTimeMillis();
    while (System.currentTimeMillis() - startTime < timeout) {
      if (server.isRunning()) {
        break;
      }
      Thread.sleep(200);
    }
    assertEquals(true, server.isRunning());
    assertEquals(true, RemoteInterpreterUtils.checkIfRemoteEndpointAccessible("localhost",
        server.getPort()));

    server.init(new HashMap<>());
    assertNotNull(server.getConf());
    assertNotNull(server.getLifecycleManager());
  }

  private void stopRemoteInterpreterServer(RemoteInterpreterServer server, int timeout)
      throws TException, InterruptedException {
    assertEquals(true, server.isRunning());
    server.shutdown();
    long startTime = System.currentTimeMillis();
    while (System.currentTimeMillis() - startTime < timeout) {
      if (!server.isRunning()) {
        break;
      }
      Thread.sleep(200);
    }
    assertEquals(false, server.isRunning());
    assertEquals(false, RemoteInterpreterUtils.checkIfRemoteEndpointAccessible("localhost",
        server.getPort()));
  }

  @Test
  public void testInterpreter() throws Exception {
    final RemoteInterpreterServer server = new RemoteInterpreterServer("localhost",
        RemoteInterpreterUtils.findRandomAvailablePortOnAllLocalInterfaces(), ":", "groupId", true);
    server.init(new HashMap<>());
    server.intpEventClient = mock(RemoteInterpreterEventClient.class);

    Map<String, String> intpProperties = new HashMap<>();
    intpProperties.put("property_1", "value_1");
    intpProperties.put("zeppelin.interpreter.localRepo", "/tmp");

    // create Test1Interpreter in session_1
    server.createInterpreter("group_1", "session_1", Test1Interpreter.class.getName(),
        intpProperties, "user_1");
    Test1Interpreter interpreter1 = (Test1Interpreter)
        ((LazyOpenInterpreter) server.getInterpreterGroup().get("session_1").get(0))
            .getInnerInterpreter();
    assertEquals(1, server.getInterpreterGroup().getSessionNum());
    assertEquals(1, server.getInterpreterGroup().get("session_1").size());
    assertEquals(2, interpreter1.getProperties().size());
    assertEquals("value_1", interpreter1.getProperty("property_1"));

    // create Test2Interpreter in session_1
    server.createInterpreter("group_1", "session_1", Test1Interpreter.class.getName(),
        intpProperties, "user_1");
    assertEquals(2, server.getInterpreterGroup().get("session_1").size());

    // create Test1Interpreter in session_2
    server.createInterpreter("group_1", "session_2", Test1Interpreter.class.getName(),
        intpProperties, "user_1");
    assertEquals(2, server.getInterpreterGroup().getSessionNum());
    assertEquals(2, server.getInterpreterGroup().get("session_1").size());
    assertEquals(1, server.getInterpreterGroup().get("session_2").size());

    final RemoteInterpreterContext intpContext = new RemoteInterpreterContext();
    intpContext.setNoteId("note_1");
    intpContext.setParagraphId("paragraph_1");
    intpContext.setGui("{}");
    intpContext.setNoteGui("{}");
    intpContext.setLocalProperties(new HashMap<>());

    // single output of SUCCESS
    RemoteInterpreterResult result = server.interpret("session_1", Test1Interpreter.class.getName(),
        "SINGLE_OUTPUT_SUCCESS", intpContext);
    assertEquals("SUCCESS", result.code);
    assertEquals(1, result.getMsg().size());
    assertEquals("SINGLE_OUTPUT_SUCCESS", result.getMsg().get(0).getData());

    // combo output of SUCCESS
    result = server.interpret("session_1", Test1Interpreter.class.getName(), "COMBO_OUTPUT_SUCCESS",
        intpContext);
    assertEquals("SUCCESS", result.code);
    assertEquals(2, result.getMsg().size());
    assertEquals("INTERPRETER_OUT", result.getMsg().get(0).getData());
    assertEquals("SINGLE_OUTPUT_SUCCESS", result.getMsg().get(1).getData());

    // single output of ERROR
    result = server.interpret("session_1", Test1Interpreter.class.getName(), "SINGLE_OUTPUT_ERROR",
        intpContext);
    assertEquals("ERROR", result.code);
    assertEquals(1, result.getMsg().size());
    assertEquals("SINGLE_OUTPUT_ERROR", result.getMsg().get(0).getData());

    // getFormType
    String formType = server.getFormType("session_1", Test1Interpreter.class.getName());
    assertEquals("NATIVE", formType);

    // cancel
    Thread sleepThread = new Thread() {
      @Override
      public void run() {
        try {
          server.interpret("session_1", Test1Interpreter.class.getName(), "SLEEP", intpContext);
        } catch (TException e) {
          e.printStackTrace();
        }
      }
    };
    sleepThread.start();

    Thread.sleep(1000);
    assertFalse(interpreter1.cancelled.get());
    server.cancel("session_1", Test1Interpreter.class.getName(), intpContext);
    // Sleep 1 second, because cancel is async.
    Thread.sleep(1000);
    assertTrue(interpreter1.cancelled.get());

    // getProgress
    assertEquals(10, server.getProgress("session_1", Test1Interpreter.class.getName(),
        intpContext));

    // close
    server.close("session_1", Test1Interpreter.class.getName());
    assertTrue(interpreter1.closed.get());
  }

  public static class Test1Interpreter extends Interpreter {

    AtomicBoolean cancelled = new AtomicBoolean();
    AtomicBoolean closed = new AtomicBoolean();

    public Test1Interpreter(Properties properties) {
      super(properties);
    }

    @Override
    public void open() {

    }

    @Override
    public InterpreterResult interpret(String st, InterpreterContext context) {
      if (st.equals("SINGLE_OUTPUT_SUCCESS")) {
        return new InterpreterResult(InterpreterResult.Code.SUCCESS, "SINGLE_OUTPUT_SUCCESS");
      } else if (st.equals("SINGLE_OUTPUT_ERROR")) {
        return new InterpreterResult(InterpreterResult.Code.ERROR, "SINGLE_OUTPUT_ERROR");
      } else if (st.equals("COMBO_OUTPUT_SUCCESS")) {
        try {
          context.out.write("INTERPRETER_OUT");
        } catch (IOException e) {
          e.printStackTrace();
        }
        return new InterpreterResult(InterpreterResult.Code.SUCCESS, "SINGLE_OUTPUT_SUCCESS");
      } else if (st.equals("SLEEP")) {
        try {
          Thread.sleep(3 * 1000);
        } catch (InterruptedException e) {
          e.printStackTrace();
        }
        return new InterpreterResult(InterpreterResult.Code.SUCCESS, "SLEEP_SUCCESS");
      }
      return null;
    }

    @Override
    public void cancel(InterpreterContext context) throws InterpreterException {
      cancelled.set(true);
    }

    @Override
    public FormType getFormType() throws InterpreterException {
      return FormType.NATIVE;
    }

    @Override
    public int getProgress(InterpreterContext context) throws InterpreterException {
      return 10;
    }

    @Override
    public void close() {
      closed.set(true);
    }

  }

  public static class Test2Interpreter extends Interpreter {


    public Test2Interpreter(Properties properties) {
      super(properties);
    }

    @Override
    public void open() {

    }

    @Override
    public InterpreterResult interpret(String st, InterpreterContext context) {
      return null;
    }

    @Override
    public void cancel(InterpreterContext context) throws InterpreterException {

    }

    @Override
    public FormType getFormType() throws InterpreterException {
      return FormType.NATIVE;
    }

    @Override
    public int getProgress(InterpreterContext context) throws InterpreterException {
      return 0;
    }

    @Override
    public void close() {

    }

  }
}
