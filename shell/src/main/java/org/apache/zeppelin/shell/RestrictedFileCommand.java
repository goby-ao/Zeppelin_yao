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

import java.io.IOException;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.channels.SeekableByteChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.FileSystemException;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileAttribute;
import java.nio.file.attribute.PosixFileAttributes;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.BooleanSupplier;

/** Restricted local filesystem operations, executed as the interpreter's Unix account. */
final class RestrictedFileCommand {
  private static final int PREVIEW_LIMIT = 1024 * 1024;
  private static final List<String> PROTECTED_NAMES = Arrays.asList(".ssh", ".gnupg", ".k5login",
      ".bashrc", ".bash_profile", ".profile", ".hadoop-env", ".hadooprc");
  private static final FileAttribute<Set<PosixFilePermission>> PRIVATE_DIRECTORY =
      PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------"));
  private static final FileAttribute<Set<PosixFilePermission>> PRIVATE_FILE =
      PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------"));

  private final String name;
  private final String flag;
  private final int lines;
  private final long uid;
  private final LocalPath source;
  private final LocalPath target;

  private RestrictedFileCommand(String name, String flag, int lines, long uid, LocalPath source,
      LocalPath target) {
    this.name = name;
    this.flag = flag;
    this.lines = lines;
    this.uid = uid;
    this.source = source;
    this.target = target;
  }

  static RestrictedFileCommand prepare(
      String name, List<String> arguments, String user, long uid) throws Denied {
    return prepare(name, arguments,
        Paths.get("/home", user), Paths.get("/tmp/zeppelin", user), uid);
  }

  static RestrictedFileCommand prepare(
      String name, List<String> args, Path home, Path tmp, long uid) throws Denied {
    String flag = "";
    int lines = 10;
    if ("ls".equals(name)) {
      StringBuilder lsFlags = new StringBuilder();
      int index = 0;
      while (index < args.size() && args.get(index).startsWith("-")) {
        String option = args.get(index);
        if (option.length() < 2 || !option.substring(1).matches("[lahtr]+")) {
          throw new Denied("FILE_ARGUMENT_DENIED");
        }
        lsFlags.append(option.substring(1));
        index++;
      }
      flag = lsFlags.toString();
      args = args.subList(index, args.size());
    } else if (!args.isEmpty()) {
      String option = args.get(0);
      if ("mkdir".equals(name) && "-p".equals(option)) {
        flag = option;
        args = args.subList(1, args.size());
      } else if (("head".equals(name) || "tail".equals(name)) && "-n".equals(option)
          && args.size() == 3 && args.get(1).matches("[0-9]{1,4}")) {
        lines = Integer.parseInt(args.get(1));
        if (lines < 1 || lines > 1000) {
          throw new Denied("FILE_ARGUMENT_DENIED");
        }
        args = args.subList(2, args.size());
      }
    }
    if ("ls".equals(name) && args.isEmpty()) {
      args = Collections.singletonList(".");
    }
    if (args.size() != ("cp".equals(name) ? 2 : 1)) {
      throw new Denied("FILE_ARGUMENT_DENIED");
    }
    LocalPath source = resolve(args.get(0), home, tmp);
    LocalPath target = args.size() == 2 ? resolve(args.get(1), home, tmp) : null;
    if (target != null && target.path.equals(target.root)) {
      throw new Denied("PATH_DENIED");
    }
    return new RestrictedFileCommand(name, flag, lines, uid, source, target);
  }

  private static LocalPath resolve(String value, Path home, Path tmp) throws Denied {
    if (value.isEmpty() || value.startsWith("-")) {
      throw new Denied("FILE_ARGUMENT_DENIED");
    }
    Path path;
    try {
      String relative = "~".equals(value)
          ? "" : (value.startsWith("~/") ? value.substring(2) : value);
      path = home.resolve(relative);
    } catch (InvalidPathException e) {
      throw new Denied("FILE_ARGUMENT_DENIED");
    }
    for (Path part : path) {
      if ("..".equals(part.toString())) {
        throw new Denied("PATH_DENIED");
      }
    }
    path = path.normalize();
    Path root = path.startsWith(home) ? home : tmp;
    if (!path.startsWith(root)) {
      throw new Denied("PATH_DENIED");
    }
    for (Path part : root.relativize(path)) {
      String component = part.toString();
      if (PROTECTED_NAMES.contains(component) || component.endsWith(".keytab")) {
        throw new Denied("PATH_DENIED");
      }
    }
    return new LocalPath(path, root, root.equals(tmp));
  }

  void execute(OutputStream out, BooleanSupplier cancelled) throws IOException {
    try {
      executeChecked(out, cancelled);
    } catch (UnsupportedOperationException e) {
      throw new FileSystemException(null, null, "Unix file attributes required");
    }
  }

  private void executeChecked(OutputStream out, BooleanSupplier cancelled) throws IOException {
    checkCancelled(cancelled);
    switch (name) {
      case "ls":
        list(checkedPath(source, false), out, cancelled);
        break;
      case "stat":
        printEntry(checkedPath(source, false), out);
        break;
      case "mkdir":
        Path directory = checkedPath(source, "-p".equals(flag));
        if (!"-p".equals(flag)) {
          Files.createDirectory(directory, PRIVATE_DIRECTORY);
        }
        break;
      case "rm":
        Path file = checkedPath(source, false);
        requireRegular(file, true);
        Files.delete(file);
        break;
      case "cp":
        copy(checkedPath(source, false), checkedPath(target, false), cancelled);
        break;
      default:
        preview(checkedPath(source, false), out, cancelled);
    }
  }

  private Path checkedPath(LocalPath local, boolean mkdirParents) throws IOException {
    Path current = local.root.getRoot();
    for (Path part : local.root) {
      current = current.resolve(part);
      requireDirectory(current);
    }
    Map<String, Object> info = unixAttributes(current);
    if (((Number) info.get("uid")).longValue() != uid
        || (local.privateDirectory && (((Number) info.get("mode")).intValue() & 0077) != 0)) {
      throw new Denied("PATH_DENIED");
    }
    if (!local.path.equals(local.root)) {
      for (Path part : local.root.relativize(local.path)) {
        current = current.resolve(part);
        if (mkdirParents) {
          try {
            Files.createDirectory(current, PRIVATE_DIRECTORY);
          } catch (FileAlreadyExistsException e) {
            requireDirectory(current);
          }
        } else if (!current.equals(local.path)) {
          requireDirectory(current);
        }
      }
    }
    return current;
  }

  private static void requireDirectory(Path path) throws IOException {
    if (!attributes(path).isDirectory()) {
      throw new Denied("PATH_DENIED");
    }
  }

  private void requireRegular(Path path, boolean requireOwner) throws IOException {
    if (!attributes(path).isRegularFile()) {
      throw new Denied("PATH_DENIED");
    }
    Map<String, Object> info = unixAttributes(path);
    if (((Number) info.get("nlink")).longValue() != 1
        || (requireOwner && ((Number) info.get("uid")).longValue() != uid)) {
      throw new Denied("PATH_DENIED");
    }
  }

  private static BasicFileAttributes attributes(Path path) throws IOException {
    return Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
  }

  private static Map<String, Object> unixAttributes(Path path) throws IOException {
    return Files.readAttributes(path, "unix:uid,mode,nlink", LinkOption.NOFOLLOW_LINKS);
  }

  private void list(Path path, OutputStream out, BooleanSupplier cancelled) throws IOException {
    if (!attributes(path).isDirectory()) {
      printEntry(path, out);
      return;
    }
    List<Path> entries = new ArrayList<>();
    try (DirectoryStream<Path> stream = Files.newDirectoryStream(path)) {
      for (Path entry : stream) {
        checkCancelled(cancelled);
        if (flag.contains("a") || !entry.getFileName().toString().startsWith(".")) {
          entries.add(entry);
        }
      }
    }
    sortEntries(entries);
    for (Path entry : entries) {
      checkCancelled(cancelled);
      if (flag.contains("l")) {
        printEntry(entry, out);
      } else {
        writeLine(out, label(entry));
      }
    }
  }

  private void sortEntries(List<Path> entries) throws IOException {
    if (flag.contains("t")) {
      Map<Path, Long> mtimes = new HashMap<>(entries.size());
      for (Path entry : entries) {
        mtimes.put(entry, attributes(entry).lastModifiedTime().toMillis());
      }
      entries.sort((left, right) -> {
        int cmp = Long.compare(mtimes.get(right), mtimes.get(left));
        return cmp != 0 ? cmp : left.compareTo(right);
      });
    } else {
      Collections.sort(entries);
    }
    if (flag.contains("r")) {
      Collections.reverse(entries);
    }
  }

  private void printEntry(Path path, OutputStream out) throws IOException {
    PosixFileAttributes info = Files.readAttributes(
        path, PosixFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
    String type = info.isDirectory() ? "d" : info.isSymbolicLink() ? "l" : "-";
    String size = flag.contains("h")
        ? String.format("%12s", humanSize(info.size()))
        : String.format("%12d", info.size());
    writeLine(out, String.format("%s%s %s %s", type,
        PosixFilePermissions.toString(info.permissions()), size, label(path)));
  }

  private static String humanSize(long bytes) {
    if (bytes < 1024) {
      return bytes + "B";
    }
    double value = bytes;
    char[] units = {'K', 'M', 'G', 'T', 'P'};
    int unitIndex = -1;
    while (value >= 1024 && unitIndex + 1 < units.length) {
      value /= 1024.0;
      unitIndex++;
    }
    return String.format(Locale.ROOT, "%.1f%c", value, units[unitIndex]);
  }

  private static String label(Path path) {
    return "'" + path.getFileName().toString().replace("\\", "\\\\").replace("'", "\\'")
        .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t") + "'";
  }

  private static void writeLine(OutputStream out, String value) throws IOException {
    out.write((value + "\n").getBytes(StandardCharsets.UTF_8));
  }

  private SeekableByteChannel openRegular(Path path) throws IOException {
    requireRegular(path, false);
    return Files.newByteChannel(path, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS);
  }

  private void copy(Path from, Path to, BooleanSupplier cancelled) throws IOException {
    if (Files.exists(to, LinkOption.NOFOLLOW_LINKS)) {
      throw new FileAlreadyExistsException(to.toString());
    }
    try (SeekableByteChannel input = openRegular(from)) {
      Path staged = Files.createTempFile(to.getParent(), ".zeppelin-copy-", ".tmp", PRIVATE_FILE);
      try {
        try (OutputStream output = Files.newOutputStream(staged, StandardOpenOption.WRITE,
            LinkOption.NOFOLLOW_LINKS)) {
          ByteBuffer buffer = ByteBuffer.allocate(64 * 1024);
          int length;
          while ((length = input.read(buffer)) > 0) {
            checkCancelled(cancelled);
            output.write(buffer.array(), 0, length);
            buffer.clear();
          }
        }
        checkCancelled(cancelled);
        // Publish only a complete copy. An existing target makes createLink fail.
        Files.createLink(to, staged);
      } finally {
        Files.deleteIfExists(staged);
      }
    }
  }

  private void preview(Path path, OutputStream out, BooleanSupplier cancelled) throws IOException {
    try (SeekableByteChannel input = openRegular(path)) {
      long size = input.size();
      if ("tail".equals(name)) {
        input.position(Math.max(0, size - PREVIEW_LIMIT));
      }
      ByteBuffer data = ByteBuffer.allocate((int) Math.min(size, PREVIEW_LIMIT));
      while (data.hasRemaining() && input.read(data) > 0) {
        checkCancelled(cancelled);
      }
      int start = 0;
      int end = data.position();
      byte[] bytes = data.array();
      if ("head".equals(name)) {
        int count = 0;
        for (int i = 0; i < end; i++) {
          if (bytes[i] == '\n' && ++count == lines) {
            end = i + 1;
            break;
          }
        }
      } else if ("tail".equals(name)) {
        int count = 0;
        for (int i = end - 2; i >= 0; i--) {
          if (bytes[i] == '\n' && ++count == lines) {
            start = i + 1;
            break;
          }
        }
      }
      checkCancelled(cancelled);
      out.write(bytes, start, end - start);
    }
  }

  private static void checkCancelled(BooleanSupplier cancelled) throws InterruptedIOException {
    if (Thread.currentThread().isInterrupted() || cancelled.getAsBoolean()) {
      throw new InterruptedIOException();
    }
  }

  private static final class LocalPath {
    private final Path path;
    private final Path root;
    private final boolean privateDirectory;

    private LocalPath(Path path, Path root, boolean privateDirectory) {
      this.path = path;
      this.root = root;
      this.privateDirectory = privateDirectory;
    }
  }

  static final class Denied extends IOException {
    Denied(String reason) {
      super(reason);
    }
  }
}
