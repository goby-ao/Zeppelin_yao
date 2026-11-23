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
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import com.sun.security.auth.module.UnixSystem;
import org.junit.Assume;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicInteger;

public class RestrictedFileCommandTest {
  @Rule
  public TemporaryFolder folder = new TemporaryFolder();

  private Path home;
  private Path tmp;
  private long uid;

  @Before
  public void setUp() throws IOException {
    Assume.assumeTrue(Files.getFileStore(folder.getRoot().toPath())
        .supportsFileAttributeView("unix"));
    Path root = folder.getRoot().toPath().toRealPath();
    home = Files.createDirectory(root.resolve("home"));
    tmp = Files.createDirectory(root.resolve("tmp"),
        PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
    uid = new UnixSystem().getUid();
  }

  @Test
  public void createsCopiesPreviewsAndRemovesTestFiles() throws Exception {
    run("mkdir", "-p", "queries/day 1");
    Path source = home.resolve("queries/day 1/test.txt");
    Files.write(source, "one\ntwo\nthree".getBytes(StandardCharsets.UTF_8));

    assertEquals("one\n", run("head", "-n", "1", "~/queries/day 1/test.txt"));
    assertEquals("two\nthree", run("tail", "-n", "2", source.toString()));
    assertEquals("'day 1'\n", run("ls", "queries"));
    assertEquals("'queries'\n", run("ls", "~"));
    assertTrue(run("ls", "-lh", "queries/day 1").contains("13B 'test.txt'"));

    Path older = home.resolve("queries/day 1/older.txt");
    Files.write(older, new byte[2048]);
    Files.setLastModifiedTime(older, FileTime.fromMillis(1000L));
    Files.setLastModifiedTime(source, FileTime.fromMillis(2000L));
    assertEquals("'test.txt'\n'older.txt'\n", run("ls", "-t", "queries/day 1"));
    String lrt = run("ls", "-lrt", "-h", "queries/day 1");
    assertTrue(lrt.indexOf("'older.txt'") < lrt.indexOf("'test.txt'"));
    assertTrue(lrt.contains("2.0K 'older.txt'"));
    Files.delete(older);

    Path copy = tmp.resolve("copy.txt");
    run("cp", source.toString(), copy.toString());
    assertEquals("one\ntwo\nthree", run("cat", copy.toString()));
    assertTrue(run("stat", copy.toString()).contains("'copy.txt'"));
    try {
      run("cp", source.toString(), copy.toString());
      fail("Existing target must not be overwritten");
    } catch (FileAlreadyExistsException expected) {
      assertEquals("one\ntwo\nthree", run("cat", copy.toString()));
    }
    run("rm", copy.toString());
    assertFalse(Files.exists(copy));
    assertTrue(Files.exists(source));
  }

  @Test
  public void rejectsOutsideProtectedAndLinkedPaths() throws Exception {
    Path outside = Files.write(home.getParent().resolve("outside"), new byte[] {1});
    Files.createSymbolicLink(home.resolve("alias"), outside);
    Files.createSymbolicLink(home.resolve("dir-alias"), home.getParent());
    Path source = Files.write(home.resolve("source"), new byte[] {1});
    Files.createLink(home.resolve("hardlink"), source);

    assertDenied("cat", outside.toString());
    assertDenied("cat", "../outside");
    assertDenied("cat", ".ssh/config");
    assertDenied("cat", "user.keytab");
    assertDenied("cat", "alias");
    assertDenied("cat", "dir-alias/outside");
    assertDenied("cat", "hardlink");
    assertDenied("rm", "alias");
    assertDenied("rm", "hardlink");
    assertDenied("cp", source.toString(), home.toString());
    assertTrue(Files.exists(outside));
  }

  @Test
  public void checksDirectoryModeAndCancelsCopyWithoutPublishing() throws Exception {
    Path source = Files.write(home.resolve("source"), new byte[128 * 1024]);
    Path copy = tmp.resolve("copy");
    AtomicInteger calls = new AtomicInteger();
    try {
      prepare("cp", source.toString(), copy.toString()).execute(
          new ByteArrayOutputStream(), () -> calls.incrementAndGet() >= 3);
      fail("Copy must support cancellation between chunks");
    } catch (InterruptedIOException expected) {
      assertEquals("", run("ls", "-a", tmp.toString()));
      assertFalse(Files.exists(copy));
    }

    Files.setPosixFilePermissions(tmp, PosixFilePermissions.fromString("rwxr-xr-x"));
    assertDenied("ls", tmp.toString());
  }

  @Test
  public void limitsPreviewSize() throws Exception {
    Path large = home.resolve("large");
    byte[] data = new byte[1024 * 1024 + 1];
    Arrays.fill(data, (byte) 'x');
    Files.write(large, data);
    assertEquals(1024 * 1024, run("cat", large.toString()).length());
  }

  private void assertDenied(String command, String... args) throws Exception {
    try {
      run(command, args);
      fail("Operation should be denied: " + command + " " + Arrays.toString(args));
    } catch (RestrictedFileCommand.Denied expected) {
      assertEquals("PATH_DENIED", expected.getMessage());
    }
  }

  private String run(String command, String... args) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    prepare(command, args).execute(out, () -> false);
    return new String(out.toByteArray(), StandardCharsets.UTF_8);
  }

  private RestrictedFileCommand prepare(String command, String... args) throws IOException {
    return RestrictedFileCommand.prepare(command, Arrays.asList(args), home, tmp, uid);
  }
}
