package org.apache.zeppelin.interpreter.bigsqlfilter;

import java.util.Arrays;
import java.util.List;

public class FilterResult {

  /**
   * 0: check is ok
   * 1: need filter：no where no limit
   * 2: need filter: no partition in where
   */
  private int code;

  private static final int NO_WHERE = 1;
  private static final int NO_PARTITION = 2;

  /**
   * filter message
   */
  private String msg;

  public FilterResult(int code) {
    this.code = code;
  }

  public static FilterResult buildNoPartitionColumn(String table, String sql,
                                                    List<String> partitionColumns, int tableSize) {
    return buildResult(NO_PARTITION, table, sql, partitionColumns, tableSize);
  }

  public static FilterResult buildResult(int code, String table, String sql,
                                         List<String> partitionColumns, int tableSize) {
    StringBuilder sb = new StringBuilder();
    sb.append("【WARN】 查询已拦截，请优化代码后重新提交。").append("\n")
            .append("【拦截原因 】: 表：").append(table).append(" 查询条件中缺少分区字段").append("\n")
            .append("【表分区字段】: ").append(Arrays.toString(partitionColumns.toArray())).append("\n")
            .append("【表空间大小】: ").append(tableSize).append("MB \n")
            .append("【相关的sql】: ").append(sql);
    return new FilterResult(code, sb.toString());
  }

  public static FilterResult checkPass() {
    return new FilterResult(0);
  }

  public FilterResult(int code, String msg) {
    this.code = code;
    this.msg = msg;
  }

  public FilterResult() {
  }

  public boolean isNoWhere() {
    return this.code == NO_WHERE;
  }

  public static FilterResult buildNoWhere(String table, String sql, List<String> partitionColumns, int tableSize) {
    return buildResult(NO_WHERE, table, sql, partitionColumns, tableSize);
  }

  public int getCode() {
    return code;
  }

  public void setCode(int code) {
    this.code = code;
  }

  public boolean isOK() {
    return this.code == 0;
  }

  public String getMsg() {
    return msg;
  }

  public void setMsg(String msg) {
    this.msg = msg;
  }
}