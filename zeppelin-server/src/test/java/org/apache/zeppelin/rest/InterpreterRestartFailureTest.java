/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package org.apache.zeppelin.rest;

import org.apache.zeppelin.interpreter.InterpreterCloseException;
import org.apache.zeppelin.interpreter.InterpreterSetting;
import org.apache.zeppelin.interpreter.InterpreterSettingManager;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.mockito.Mockito.*;

public class InterpreterRestartFailureTest {
  @Test
  public void missingSettingReturns404() {
    InterpreterSettingManager manager = mock(InterpreterSettingManager.class);
    assertEquals(404, new InterpreterRestApi(null, null, null, manager, null)
        .restartSetting("", "missing").getStatus());
    verify(manager, never()).close(anyString());
  }

  @Test
  public void closeFailureReturns409InsteadOfSuccess() {
    assertCloseStatus(false, 409);
  }

  @Test
  public void closeDeadlineReturns504InsteadOfSuccess() {
    assertCloseStatus(true, 504);
  }

  private void assertCloseStatus(boolean timeout, int status) {
    InterpreterSettingManager manager = mock(InterpreterSettingManager.class);
    when(manager.get("hive3")).thenReturn(mock(InterpreterSetting.class));
    doThrow(new InterpreterCloseException("close unconfirmed", null, timeout))
        .when(manager).close("hive3");
    assertEquals(status, new InterpreterRestApi(null, null, null, manager, null)
        .restartSetting("", "hive3").getStatus());
    verify(manager, times(1)).close("hive3");
  }
}
