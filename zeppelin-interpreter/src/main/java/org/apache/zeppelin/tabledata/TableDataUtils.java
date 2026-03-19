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

package org.apache.zeppelin.tabledata;


import java.util.Arrays;
import java.util.List;
import java.util.stream.Collectors;

public class TableDataUtils {

  /**
   * 手机号脱敏：11位中国大陆手机号，中间4位替换为****
   * 支持格式：13812345678、包含手机号的文本等
   * code by yao's AI
   */
  private static String maskPhoneNumber(String value) {
    if (value == null || value.isEmpty()) {
      return value;
    }
    // 正则说明：
    // (?<!\d)     - 负向后顾断言，前面不能是数字（避免匹配更长数字串的一部分）
    // 1[3-9]     - 以1开头，第二位是3-9（中国大陆手机号规则）
    // \d{9}      - 后面跟着9位数字
    // (?!\d)     - 负向前瞻断言，后面不能是数字
    // 分组：$1=前3位, $2=中间4位, $3=后4位
    return value.replaceAll("(?<!\\d)(1[3-9]\\d)(\\d{4})(\\d{4})(?!\\d)", "$1****$3");
  }

  /**
   * Replace '\t','\r\n','\n' which represent field delimiter and row delimiter with while space.
   * Also mask sensitive phone numbers in the content.
   * @param column
   * @column
   */
  public static String normalizeColumn(String column) {
    if (column == null) {
      return "null";
    }
    String normalized = column.replace("\t", " ").replace("\r\n", " ").replace("\n", " ");
    // 手机号脱敏 - code by yao's AI
    return maskPhoneNumber(normalized);
  }

  /**
   * Convert obj to String first, convert it to empty string it is null.
   * Also mask sensitive phone numbers in the content.
   * @param obj
   * @column
   */
  public static String normalizeColumn(Object obj) {
    return normalizeColumn(obj == null ? "null" : obj.toString());
  }

  public static List<String> normalizeColumns(List<Object> columns) {
    return columns.stream()
            .map(TableDataUtils::normalizeColumn)
            .collect(Collectors.toList());
  }

  public static List<String> normalizeColumns(Object[] columns) {
    return Arrays.stream(columns)
            .map(TableDataUtils::normalizeColumn)
            .collect(Collectors.toList());
  }
}
