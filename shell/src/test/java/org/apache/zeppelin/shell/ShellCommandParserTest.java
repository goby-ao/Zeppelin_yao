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
import static org.junit.Assert.fail;

import java.util.Arrays;
import org.junit.Test;

public class ShellCommandParserTest {
  @Test
  public void parsesQuotedSqlAsOneArgument() {
    assertEquals(Arrays.asList("hive", "-e", "select 1; select 2"),
        ShellCommandParser.parse("hive -e 'select 1; select 2'"));
    assertEquals(Arrays.asList("hive", "-e", "\n  select 1;\n  select 2;\n"),
        ShellCommandParser.parse("hive -e \"\n  select 1;\n  select 2;\n\""));
    assertEquals(Arrays.asList("beeline", "-u", "jdbc:hive2://host:10000", "-e", "show tables"),
        ShellCommandParser.parse(
            "beeline -u \"jdbc:hive2://host:10000\" \\\n  -e \"show tables\""));
    assertEquals(Arrays.asList(
        Arrays.asList("hive", "-e", "show tables"),
        Arrays.asList("grep", "ods")),
        ShellCommandParser.parsePipeline("hive -e \"show tables\" | grep ods"));
    ShellCommandParser.ParsedLine redirected = ShellCommandParser.parseCommandLine(
        "hive -e \"select 1\" | grep 1 >> /tmp/zeppelin/alice/out.txt");
    assertEquals(2, redirected.stages.size());
    assertEquals("/tmp/zeppelin/alice/out.txt", redirected.redirectTarget);
    assertEquals(true, redirected.redirectAppend);
  }

  @Test
  public void rejectsAdditionalShellCommands() {
    for (String input : Arrays.asList("hadoop version\nssh host", "hadoop version; ssh host",
        "hadoop version | ssh host", "hadoop $(ssh host)", "hadoop > output",
        "hadoop 'unfinished")) {
      try {
        ShellCommandParser.parse(input);
        fail("Accepted " + input);
      } catch (IllegalArgumentException expected) {
        // Expected.
      }
    }
  }
}
