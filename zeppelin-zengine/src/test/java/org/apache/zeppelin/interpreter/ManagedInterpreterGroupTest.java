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

package org.apache.zeppelin.interpreter;

import org.junit.Before;
import org.junit.Test;
import org.eclipse.aether.RepositoryException;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Collections;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.times;


public class ManagedInterpreterGroupTest {

  private InterpreterSetting interpreterSetting;

  @Before
  public void setUp() throws IOException, RepositoryException {
    InterpreterOption interpreterOption = new InterpreterOption();
    interpreterOption.setPerUser(InterpreterOption.SCOPED);
    InterpreterInfo interpreterInfo1 = new InterpreterInfo(EchoInterpreter.class.getName(),
        "echo", true, new HashMap<String, Object>(), new HashMap<String, Object>());
    InterpreterInfo interpreterInfo2 = new InterpreterInfo(DoubleEchoInterpreter.class.getName(),
        "double_echo", false, new HashMap<String, Object>(), new HashMap<String, Object>());
    List<InterpreterInfo> interpreterInfos = new ArrayList<>();
    interpreterInfos.add(interpreterInfo1);
    interpreterInfos.add(interpreterInfo2);
    interpreterSetting = new InterpreterSetting.Builder()
        .setId("id")
        .setName("test")
        .setGroup("test")
        .setInterpreterInfos(interpreterInfos)
        .setOption(interpreterOption)
        .create();
  }

  @Test
  public void testInterpreterGroup() {
    ManagedInterpreterGroup interpreterGroup = new ManagedInterpreterGroup("group_1", interpreterSetting);
    assertEquals(0, interpreterGroup.getSessionNum());

    // create session_1
    List<Interpreter> interpreters = interpreterGroup.getOrCreateSession("user1", "session_1");
    assertEquals(3, interpreters.size());
    assertEquals(EchoInterpreter.class.getName(), interpreters.get(0).getClassName());
    assertEquals(DoubleEchoInterpreter.class.getName(), interpreters.get(1).getClassName());
    assertEquals(1, interpreterGroup.getSessionNum());

    // get the same interpreters when interpreterGroup.getOrCreateSession is invoked again
    assertEquals(interpreters, interpreterGroup.getOrCreateSession("user1", "session_1"));
    assertEquals(1, interpreterGroup.getSessionNum());

    // create session_2
    List<Interpreter> interpreters2 = interpreterGroup.getOrCreateSession("user1", "session_2");
    assertEquals(3, interpreters2.size());
    assertEquals(EchoInterpreter.class.getName(), interpreters2.get(0).getClassName());
    assertEquals(DoubleEchoInterpreter.class.getName(), interpreters2.get(1).getClassName());
    assertEquals(2, interpreterGroup.getSessionNum());

    // close session_1
    interpreterGroup.close("session_1");
    assertEquals(1, interpreterGroup.getSessionNum());

    // close InterpreterGroup
    interpreterGroup.close();
    assertEquals(0, interpreterGroup.getSessionNum());
  }

  @Test
  public void closeMustNotHoldGroupMonitor() throws Exception {
    ManagedInterpreterGroup group = new ManagedInterpreterGroup("closing", interpreterSetting);
    Interpreter interpreter = mock(Interpreter.class);
    when(interpreter.getScheduler()).thenReturn(mock(org.apache.zeppelin.scheduler.Scheduler.class));
    CountDownLatch entered = new CountDownLatch(1);
    CountDownLatch release = new CountDownLatch(1);
    doAnswer(invocation -> {
      entered.countDown();
      release.await();
      return null;
    }).when(interpreter).close();
    group.put("blocked", Collections.singletonList(interpreter));
    ExecutorService callers = Executors.newFixedThreadPool(2);
    Future<?> close = callers.submit(() -> group.close("blocked"));
    try {
      assertTrue(entered.await(2, TimeUnit.SECONDS));
      Future<?> other = callers.submit(() -> group.getOrCreateSession("user", "other"));
      other.get(1, TimeUnit.SECONDS);
      assertEquals(2, group.getSessionNum());
      try {
        group.getOrCreateSession("user", "blocked");
        fail("A closing session must not be reused");
      } catch (IllegalStateException expected) {
        // The other session is usable, but the closing session is isolated.
      }
    } finally {
      release.countDown();
      close.get(3, TimeUnit.SECONDS);
      callers.shutdownNow();
    }
  }

  @Test
  public void failedCloseMustRetainSession() throws Exception {
    ManagedInterpreterGroup group = new ManagedInterpreterGroup("failed", interpreterSetting);
    Interpreter interpreter = mock(Interpreter.class);
    when(interpreter.getScheduler()).thenReturn(mock(org.apache.zeppelin.scheduler.Scheduler.class));
    doThrow(new InterpreterException("CloseSession failed")).when(interpreter).close();
    group.put("session", Collections.singletonList(interpreter));
    try {
      group.close("session");
      fail("Close failure must reach the caller");
    } catch (IllegalStateException expected) {
      assertEquals(1, group.getSessionNum());
    }
  }

  @Test
  public void deadlineDoesNotReleaseOrDuplicateBlockedClose() throws Exception {
    ManagedInterpreterGroup group = new ManagedInterpreterGroup("timeout", interpreterSetting) {
      @Override
      int getCloseTimeout() {
        return 100;
      }
    };
    Interpreter interpreter = mock(Interpreter.class);
    when(interpreter.getScheduler()).thenReturn(mock(org.apache.zeppelin.scheduler.Scheduler.class));
    CountDownLatch release = new CountDownLatch(1);
    CountDownLatch exited = new CountDownLatch(1);
    doAnswer(invocation -> { release.await(); exited.countDown(); return null; })
        .when(interpreter).close();
    group.put("session", Collections.singletonList(interpreter));
    try {
      for (int i = 0; i < 2; i++) {
        try {
          group.close("session");
          fail("Blocked close must time out");
        } catch (InterpreterCloseException expected) {
          assertTrue(expected.isTimeout());
        }
      }
      assertEquals(1, group.getSessionNum());
      verify(interpreter, times(1)).close();
    } finally {
      release.countDown();
      assertTrue(exited.await(2, TimeUnit.SECONDS));
    }
  }
}
