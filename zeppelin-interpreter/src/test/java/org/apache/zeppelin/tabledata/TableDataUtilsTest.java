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

import com.google.common.collect.Lists;
import org.junit.Test;

import static org.junit.Assert.assertEquals;

public class TableDataUtilsTest {

  @Test
  public void testColumn() {
    assertEquals("hello world", TableDataUtils.normalizeColumn("hello\tworld"));
    assertEquals("hello world", TableDataUtils.normalizeColumn("hello\nworld"));
    assertEquals("hello world", TableDataUtils.normalizeColumn("hello\r\nworld"));
    assertEquals("hello  world", TableDataUtils.normalizeColumn("hello\t\nworld"));

    assertEquals("null", TableDataUtils.normalizeColumn(null));
  }

  @Test
  public void testColumns() {
    assertEquals(Lists.newArrayList("hello world", "hello world"),
            TableDataUtils.normalizeColumns(new Object[]{"hello\tworld", "hello\nworld"}));

    assertEquals(Lists.newArrayList("hello world", "null"),
            TableDataUtils.normalizeColumns(new String[]{"hello\tworld", null}));
  }

  // ==========================================================================
  // 手机号脱敏测试 - code by yao's AI
  // ==========================================================================

  @Test
  public void testPhoneMasking_StandardMobilePhone() {
    assertEquals("138****5678", TableDataUtils.normalizeColumn("13812345678"));
  }

  @Test
  public void testPhoneMasking_DifferentPrefixes() {
    // 中国移动
    assertEquals("139****1234", TableDataUtils.normalizeColumn("13912341234"));
    // 中国联通
    assertEquals("130****1234", TableDataUtils.normalizeColumn("13012341234"));
    // 中国电信
    assertEquals("133****1234", TableDataUtils.normalizeColumn("13312341234"));
    // 虚拟运营商
    assertEquals("170****1234", TableDataUtils.normalizeColumn("17012341234"));
    // 新号段
    assertEquals("198****1234", TableDataUtils.normalizeColumn("19812341234"));
    assertEquals("166****1234", TableDataUtils.normalizeColumn("16612341234"));
  }

  @Test
  public void testPhoneMasking_NullAndEmpty() {
    assertEquals("null", TableDataUtils.normalizeColumn((String) null));
    assertEquals("", TableDataUtils.normalizeColumn(""));
  }

  @Test
  public void testPhoneMasking_ShortString() {
    assertEquals("12345", TableDataUtils.normalizeColumn("12345"));
  }

  @Test
  public void testPhoneMasking_NonPhoneNumber() {
    assertEquals("hello world", TableDataUtils.normalizeColumn("hello world"));
    assertEquals("1234567890", TableDataUtils.normalizeColumn("1234567890")); // 10位，不够
    assertEquals("23812345678", TableDataUtils.normalizeColumn("23812345678")); // 不是1开头
  }

  @Test
  public void testPhoneMasking_NoPartialMatch_LongerNumber() {
    // 12位数字，不应该匹配中间的11位
    assertEquals("123812345678", TableDataUtils.normalizeColumn("123812345678"));
    assertEquals("138123456789", TableDataUtils.normalizeColumn("138123456789"));
  }

  @Test
  public void testPhoneMasking_NumberWithLetters_NoMatch() {
    assertEquals("138a1234567", TableDataUtils.normalizeColumn("138a1234567"));
    assertEquals("1381234567x", TableDataUtils.normalizeColumn("1381234567x"));
  }

  @Test
  public void testPhoneMasking_PhoneInText() {
    assertEquals("我的手机号是138****5678，请联系我",
        TableDataUtils.normalizeColumn("我的手机号是13812345678，请联系我"));
  }

  @Test
  public void testPhoneMasking_MultiplePhonesInText() {
    assertEquals("张三:138****1111, 李四:139****2222",
        TableDataUtils.normalizeColumn("张三:13811111111, 李四:13922222222"));
  }

  @Test
  public void testPhoneMasking_PhoneWithSpaces() {
    assertEquals(" 138****5678 ", TableDataUtils.normalizeColumn(" 13812345678 "));
  }

  @Test
  public void testPhoneMasking_PhoneWithBrackets() {
    assertEquals("(138****5678)", TableDataUtils.normalizeColumn("(13812345678)"));
  }

  @Test
  public void testPhoneMasking_InvalidSecondDigit() {
    assertEquals("11812345678", TableDataUtils.normalizeColumn("11812345678")); // 11开头
    assertEquals("12812345678", TableDataUtils.normalizeColumn("12812345678")); // 12开头
  }

  @Test
  public void testPhoneMasking_MixedContent() {
    String input = "订单号:20240101001, 客户:张三, 手机:13812345678, 备份:13987654321, 备注:已确认";
    String expected = "订单号:20240101001, 客户:张三, 手机:138****5678, 备份:139****4321, 备注:已确认";
    assertEquals(expected, TableDataUtils.normalizeColumn(input));
  }

  @Test
  public void testPhoneMasking_SqlLikeContent() {
    String input = "id:1001, name:test, phone:15812345678, create_time:2024-01-01";
    String expected = "id:1001, name:test, phone:158****5678, create_time:2024-01-01";
    assertEquals(expected, TableDataUtils.normalizeColumn(input));
  }

  @Test
  public void testPhoneMasking_WithTabAndNewline() {
    // 验证同时处理特殊字符和脱敏
    assertEquals("phone: 138****5678", TableDataUtils.normalizeColumn("phone:\t13812345678"));
    assertEquals("contact 138****5678 now", TableDataUtils.normalizeColumn("contact\n13812345678\r\nnow"));
  }

  @Test
  public void testPhoneMasking_ObjectParameter() {
    // 测试 Object 参数版本的 normalizeColumn
    assertEquals("138****5678", TableDataUtils.normalizeColumn((Object) "13812345678"));
    assertEquals("null", TableDataUtils.normalizeColumn((Object) null));
  }
}
