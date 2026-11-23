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

import java.util.ArrayList;
import java.util.List;

/** Parses one command without invoking a shell or expanding any expressions. */
final class ShellCommandParser {
  private ShellCommandParser() {
  }

  static List<String> parse(String input) {
    List<List<String>> commands = parsePipeline(input);
    if (commands.size() != 1) {
      throw new IllegalArgumentException("Shell operators are not supported");
    }
    return commands.get(0);
  }

  static List<List<String>> parsePipeline(String input) {
    if (input.indexOf(0) >= 0) {
      throw new IllegalArgumentException("NUL bytes are not supported");
    }
    input = input.trim();
    List<List<String>> commands = new ArrayList<>();
    List<String> arguments = new ArrayList<>();
    StringBuilder word = new StringBuilder();
    char quote = 0;
    boolean inWord = false;
    boolean escaped = false;
    for (int i = 0; i < input.length(); i++) {
      char c = input.charAt(i);
      if (escaped) {
        if (quote == '"' && "\\\"`$".indexOf(c) < 0) {
          word.append('\\');
        }
        word.append(c);
        inWord = true;
        escaped = false;
      } else if (c == '\\' && quote != '\'') {
        int continued = skipLineContinuation(input, i, quote);
        if (continued >= 0) {
          if (quote == 0 && inWord && continued > i + 1 && input.charAt(i + 1) != '\r'
              && input.charAt(i + 1) != '\n') {
            arguments.add(word.toString());
            word.setLength(0);
            inWord = false;
          }
          i = continued;
        } else {
          escaped = true;
          inWord = true;
        }
      } else if (quote != 0 && c == quote) {
        quote = 0;
      } else if (quote == 0 && (c == '\'' || c == '"')) {
        quote = c;
        inWord = true;
      } else if (quote == 0 && (c == '\n' || c == '\r')) {
        throw new IllegalArgumentException("Only one command on one line is supported");
      } else if (quote == 0 && c == '#' && !inWord && !arguments.isEmpty()) {
        break;
      } else if (quote == 0 && c == '|') {
        if (inWord) {
          arguments.add(word.toString());
          word.setLength(0);
          inWord = false;
        }
        if (arguments.isEmpty()) {
          throw new IllegalArgumentException("Shell operators are not supported");
        }
        commands.add(arguments);
        arguments = new ArrayList<>();
      } else if (quote == 0 && "&;<>`$(){}".indexOf(c) >= 0) {
        throw new IllegalArgumentException("Shell operators are not supported");
      } else if (quote == 0 && Character.isWhitespace(c)) {
        if (inWord) {
          arguments.add(word.toString());
          word.setLength(0);
          inWord = false;
        }
      } else {
        word.append(c);
        inWord = true;
      }
    }
    if (quote != 0 || escaped) {
      throw new IllegalArgumentException("Unclosed quote or escape");
    }
    if (inWord) {
      arguments.add(word.toString());
    }
    if (arguments.isEmpty()) {
      throw new IllegalArgumentException("Command is empty");
    }
    commands.add(arguments);
    return commands;
  }

  private static int skipLineContinuation(String input, int backslashIndex, char quote) {
    int i = backslashIndex + 1;
    if (quote == 0) {
      while (i < input.length() && (input.charAt(i) == ' ' || input.charAt(i) == '\t')) {
        i++;
      }
    }
    if (i < input.length() && input.charAt(i) == '\r') {
      i++;
    }
    if (i < input.length() && input.charAt(i) == '\n') {
      return i;
    }
    return -1;
  }
}
