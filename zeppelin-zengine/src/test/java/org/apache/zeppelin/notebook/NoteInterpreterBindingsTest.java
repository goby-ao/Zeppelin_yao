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

package org.apache.zeppelin.notebook;

import org.apache.zeppelin.conf.ZeppelinConfiguration;
import org.apache.zeppelin.interpreter.ExecutionContext;
import org.apache.zeppelin.interpreter.InterpreterFactory;
import org.apache.zeppelin.interpreter.InterpreterInfo;
import org.apache.zeppelin.interpreter.InterpreterOption;
import org.apache.zeppelin.interpreter.InterpreterSetting;
import org.apache.zeppelin.interpreter.InterpreterSettingManager;
import org.apache.zeppelin.interpreter.ManagedInterpreterGroup;
import org.apache.zeppelin.user.AuthenticationInfo;
import org.junit.Before;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.mockito.Matchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.verifyZeroInteractions;
import static org.mockito.Mockito.when;

public class NoteInterpreterBindingsTest {
  private static final List<String> USER_AND_ROLES = Arrays.asList("alice", "analyst");

  private final Map<String, InterpreterSetting> settings = new LinkedHashMap<>();
  private InterpreterSettingManager manager;
  private InterpreterFactory factory;

  @Before
  public void setUp() {
    manager = mock(InterpreterSettingManager.class);
    when(manager.getByName(anyString())).thenAnswer(invocation ->
        settings.get((String) invocation.getArguments()[0]));
    when(manager.get()).thenAnswer(invocation -> new ArrayList<>(settings.values()));
    factory = spy(new InterpreterFactory(manager));
  }

  @Test
  public void defaultAndSameGroupBindingsDoNotCreateSessions() {
    InterpreterSetting other = setting("warehouse", "jdbc", "sql");
    InterpreterSetting defaultSetting = setting("hive3", "jdbc", "sql");
    Note note = note("/queries", "hive3", "select 1", "%sql select 2", "");

    assertEquals(Arrays.asList(defaultSetting, other), bindings(note));
    assertMetadataOnly();
  }

  @Test
  public void mixedMagicUsesSettingNamesAndDeduplicatesInParagraphOrder() {
    InterpreterSetting hive = setting("hive3", "jdbc", "sql");
    InterpreterSetting python = setting("python", "python", "python");
    InterpreterSetting analytics = setting("analytics", "spark", "spark", "sql");
    setting("unused", "markdown", "md");
    Note note = note("/mixed", "hive3", "%python print(1)",
        "%analytics.sql select 1", "%hive3 select 2", "%sql select 3",
        "%analytics.spark println(1)");

    assertEquals(Arrays.asList(hive, python, analytics), bindings(note));
    assertMetadataOnly();
  }

  @Test
  public void shortMagicPrefersDefaultMemberAndConfOverSettingNames() {
    InterpreterSetting hive = setting("hive3", "jdbc", "sql");
    setting("sql", "spark", "sql");
    setting("conf", "python", "python");
    Note note = note("/short-magic", "hive3", "%sql select 1", "%conf x=y");

    assertEquals(Collections.singletonList(hive), bindings(note));
    assertMetadataOnly();
  }

  @Test
  public void explicitConfSupportsSettingsWithoutConfMetadata() {
    InterpreterSetting hive = setting("hive3", "jdbc", "sql");
    InterpreterSetting livy = setting("remote", "livy", "spark");
    InterpreterSetting python = setting("python", "python", "python");
    Note note = note("/conf", "hive3", "%remote.conf x=y", "%python.conf x=y");

    assertEquals(Arrays.asList(hive, livy, python), bindings(note));
    assertMetadataOnly();
  }

  @Test
  public void unknownMagicDoesNotBindAnExistingSettingWithAnUnknownMember() {
    InterpreterSetting hive = setting("hive3", "jdbc", "sql");
    setting("python", "python", "python");
    Note note = note("/unknown", "hive3", "%missing select 1",
        "%python.missing select 1", "%python.python.extra select 1");

    assertEquals(Collections.singletonList(hive), bindings(note));
    assertMetadataOnly();
  }

  @Test
  public void sameGroupAndExplicitSettingsRespectUserAndRolePermissions() {
    InterpreterSetting hive = setting("hive3", "jdbc", "sql");
    restrict(setting("restrictedJdbc", "jdbc", "sql"), "bob");
    InterpreterSetting owned = setting("owned", "jdbc", "sql");
    restrict(owned, "alice");
    InterpreterSetting roleAllowed = setting("python", "python", "python");
    restrict(roleAllowed, "analyst");
    restrict(setting("restrictedSpark", "spark", "sql"), "bob");
    Note note = note("/permissions", "hive3", "%python print(1)",
        "%restrictedSpark.sql select 1", "%restrictedJdbc select 1");

    assertEquals(Arrays.asList(hive, owned, roleAllowed), bindings(note));
    assertMetadataOnly();
  }

  @Test
  public void configuredDefaultRemainsFirstEvenWhenPermissionsChange() {
    InterpreterSetting hive = setting("hive3", "jdbc", "sql");
    restrict(hive, "bob");
    Note note = note("/existing-default", "hive3", "select 1");

    // Keep the existing binding-display contract; execution checks permissions separately.
    assertEquals(Collections.singletonList(hive), bindings(note));
    assertMetadataOnly();
  }

  @Test
  public void quickNoteReturnsFullBindingsForFrontendDisplayFiltering() {
    InterpreterSetting hive = setting("hive3", "jdbc", "sql");
    InterpreterSetting otherJdbc = setting("hive2", "jdbc", "sql");
    InterpreterSetting python = setting("python", "python", "python");
    Note note = note("/快速笔记/alice/QuickNote_hive3", "hive3",
        "select 1", "%python print(1)");

    assertEquals(Arrays.asList(hive, otherJdbc, python), bindings(note));
    assertMetadataOnly();
  }

  @Test
  public void bindingsReturnWhileInterpreterGroupMonitorIsHeld() throws Exception {
    InterpreterSetting hive = setting("hive3", "jdbc", "sql");
    Note note = note("/closing", "hive3", "select 1", "%sql select 2");
    ExecutionContext context = note.getExecutionContext();
    context.setUser("alice");
    ManagedInterpreterGroup group = hive.getOrCreateInterpreterGroup(context);
    ExecutorService reader = Executors.newSingleThreadExecutor();
    try {
      // Model the monitor held by a stalled interpreter close, without starting a process.
      synchronized (group) {
        Future<List<InterpreterSetting>> result = reader.submit(() -> bindings(note));
        assertEquals(Collections.singletonList(hive), result.get(2, TimeUnit.SECONDS));
      }
      verifyZeroInteractions(factory);
      assertEquals(0, group.getSessionNum());
    } finally {
      reader.shutdownNow();
      assertTrue(reader.awaitTermination(5, TimeUnit.SECONDS));
    }
  }

  private InterpreterSetting setting(String name, String group, String... interpreterNames) {
    List<InterpreterInfo> infos = new ArrayList<>();
    for (String interpreterName : interpreterNames) {
      infos.add(new InterpreterInfo("test." + interpreterName, interpreterName,
          infos.isEmpty(), null, null));
    }
    InterpreterSetting setting = new InterpreterSetting.Builder()
        .setName(name)
        .setGroup(group)
        .setInterpreterInfos(infos)
        .setProperties(new Properties())
        .setOption(new InterpreterOption(InterpreterOption.ISOLATED, InterpreterOption.SHARED))
        .setConf(ZeppelinConfiguration.create())
        .setIntepreterSettingManager(manager)
        .create();
    settings.put(name, setting);
    return setting;
  }

  private void restrict(InterpreterSetting setting, String owner) {
    InterpreterOption option = InterpreterOption.fromInterpreterOption(setting.getOption());
    option.setUserPermission(true);
    option.getOwners().add(owner);
    setting.setOption(option);
  }

  private Note note(String path, String defaultSetting, String... texts) {
    Note note = new Note(path, defaultSetting, factory, manager, null, null,
        Collections.emptyList());
    for (String text : texts) {
      Paragraph paragraph = new Paragraph(note, null);
      paragraph.setText(text);
      paragraph.setAuthenticationInfo(new AuthenticationInfo("alice"));
      note.addParagraph(paragraph);
    }
    return note;
  }

  private List<InterpreterSetting> bindings(Note note) {
    return note.getBindedInterpreterSettings(USER_AND_ROLES);
  }

  private void assertMetadataOnly() {
    verifyZeroInteractions(factory);
    for (InterpreterSetting setting : settings.values()) {
      assertTrue("Bindings must not create a group for " + setting.getName(),
          setting.getAllInterpreterGroups().isEmpty());
    }
  }
}
