package org.apache.zeppelin.interpreter.bigsqlfilter;

import com.alibaba.druid.DbType;
import com.alibaba.druid.sql.SQLUtils;
import com.alibaba.druid.sql.ast.SQLStatement;
import com.alibaba.druid.sql.ast.statement.SQLSelectStatement;
import com.alibaba.druid.sql.ast.statement.SQLUseStatement;
import com.alibaba.druid.sql.dialect.hive.ast.HiveMultiInsertStatement;
import com.alibaba.druid.sql.dialect.hive.stmt.HiveCreateTableStatement;
import com.google.common.cache.CacheBuilder;
import com.google.common.cache.CacheLoader;
import com.google.common.cache.LoadingCache;
import com.google.gson.Gson;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.sql.Connection;
import java.sql.ResultSet;
import java.util.*;
import java.util.concurrent.TimeUnit;

public class SqlFilter {

  Logger LOGGER = LoggerFactory.getLogger(SqlFilter.class);

  private static class MySingletonHandler {
    private static final SqlFilter instance = new SqlFilter();
  }

  /**
   * 100G
   */
  static int default_table_size = 1024 * 100;

  /**
   * local cache of hive table info that get from http request
   */
  private final LoadingCache<TableInfo, Optional<TableInfo>> TABLE_CACHE = CacheBuilder.newBuilder()
          .initialCapacity(50).maximumSize(200).expireAfterWrite(48, TimeUnit.HOURS)
          .build(new TableCacheLoader());

  public static SqlFilter getInstance() {
    return MySingletonHandler.instance;
  }

  /**
   * what kind of table need to check：partition table + big size
   *
   * @param tableInfo
   * @return
   */
  private boolean tableNeedCheck(TableInfo tableInfo, int tableSize) {
    // non partition table
    if (tableInfo == null || !tableInfo.isPartitionTable()) {
      LOGGER.info("skip check for non partition table");
      return false;
    }

    // table is big
    LOGGER.info("now size: {}, max: {}", tableInfo.getTableSize(), tableSize);
    return tableInfo.getTableSize() >= tableSize;
  }

  /**
   * 分区条件检查
   *
   * @param queryResults
   * @param defaultDb
   * @param cluster
   * @return
   */
  private FilterResult checkQueries(List<QueryResult> queryResults, String defaultDb, String cluster, int tableSize) {
    // 遍历每一个查询
    for (QueryResult qr : queryResults) {
      for (String table : qr.getTables()) {
        String db = defaultDb;
        String singeTable = table;
        if (table.contains(".")) {
          db = table.split("\\.")[0];
          singeTable = table.split("\\.")[1];
        }
        // 查询分区需要完整库名表名
        TableInfo tableInfo = new TableInfo();
        tableInfo.setDb(db);
        tableInfo.setTableName(singeTable);
        tableInfo.setCluster(cluster);
        Optional<TableInfo> cacheTableInfo;
        try {
          cacheTableInfo = TABLE_CACHE.get(tableInfo);
        } catch (Exception e) {
          LOGGER.error("[mg] error get cache", e);
          return FilterResult.checkPass();
        }

        if (!cacheTableInfo.isPresent()) {
          LOGGER.info("cache is null..............");
          return FilterResult.checkPass();
        }

        LOGGER.info(new Gson().toJson(cacheTableInfo.get()));

        if (tableNeedCheck(cacheTableInfo.get(), tableSize)) {
          // 完全没有查询条件，如果有 limit 可以跳过，没有 limit 拦截
          // select * from table limit 10; 这种不会全表扫
          if (qr.getWhereTableColumns() == null || qr.getWhereTableColumns().get(table) == null) {
            return FilterResult.buildNoWhere(table, qr.getQuerySql()
                    , cacheTableInfo.get().getPartitionColumns(), cacheTableInfo.get().getTableSize());
          }

          // 有查询条件
          Collection<String> tableWhereList = qr.getWhereTableColumns().get(table);
          LOGGER.info("wherelist: " + Arrays.toString(tableWhereList.toArray()));
          boolean existPartitionCol = false;
          for (String con : tableWhereList) {
            if (cacheTableInfo.get().getPartitionColumns().contains(con)) {
              existPartitionCol = true;
            }
          }

          if (!existPartitionCol) {
            return FilterResult.buildNoPartitionColumn(table, qr.getQuerySql()
                    , cacheTableInfo.get().getPartitionColumns(), cacheTableInfo.get().getTableSize());
          }
        }
      }
    }

    return FilterResult.checkPass();

  }

  public FilterResult filter(String sql, String cluster) {
    return filter(sql, cluster, default_table_size);
  }

  /**
   * sql 过滤：针对大表查询，且 where 条件不带分区字段的情况
   *
   * @param sql       支持 use，支持；连接的多段 sql
   * @param cluster   集群信息
   * @param tableSize 拦截的表大小
   * @return {@link FilterResult}
   */
  public FilterResult filter(String sql, String cluster, int tableSize) {
    if ("-1".equals(cluster) || tableSize == -1) {
      return FilterResult.checkPass();
    }

    String db = "default";
    List<SQLStatement> statementList = SQLUtils.parseStatements(sql, DbType.hive);
    // multi sql
    for (SQLStatement ss : statementList) {
      if (ss instanceof SQLUseStatement) {
        db = ((SQLUseStatement) ss).getDatabase().getSimpleName();
        continue;
      }

      if (ss instanceof SQLSelectStatement || ss instanceof HiveCreateTableStatement
              || ss instanceof HiveMultiInsertStatement) {
        QueryVisitor statVisitor = new QueryVisitor(DbType.hive);
        ss.accept(statVisitor);

        // check all queries in a sql
        FilterResult result = checkQueries(statVisitor.getQueryResults(), db, cluster, tableSize);

        // return result
        if (!result.isOK()) {
          // skip: select * from table limit 10;
          if (result.isNoWhere() && statVisitor.getTables().size() == 1
                  && statVisitor.isHasLimit()) {
            return FilterResult.checkPass();
          }
          // no partition in where
          LOGGER.info("[mg] success reject sql: {}", result.getMsg());
          return result;
        }
      }
    }

    return FilterResult.checkPass();
  }

  public static void main(String[] args) throws IOException {
//    String sql = "FROM (SELECT p.datekey datekey, p.userid userid, c.clienttype  FROM detail.usersequence_client c JOIN fact.orderpayment p ON p.orderid = c.orderid  JOIN default.user du ON du.userid = p.userid WHERE p.datekey = 20131118 ) base  INSERT OVERWRITE TABLE `test`.`customer_kpi` SELECT base.datekey,   base.clienttype, count(distinct base.userid) buyer_count GROUP BY base.datekey, base.clienttype";
//    String sql = "insert overwrite table t1 select * from t2 where id = 1;";
//    String sql = "use cc;select c1,c2,t2.c3 from t1 left join t2 on t1.id = t2.id where t2.id = 1 limit 10;";
//    String sql = "select c1,c2 from t1 where day = '123' and age = 'xxx' and name = 'yy' limit 10;";
//    String sql = "select a from t1 union all select b from t2";
//    String sql = "select c1,c2 from db1.t1 tt1 left join (select * from t5) tt2 " +
//            "on tt1.id = tt2.id where tt1.day like '123' and tt1.xx = aa " +
//            "and tt1.xx in (select * from xyz where xyz.id = 5) and 'xxx' = tt2.age limit 10;";
//    String sql = "insert    overwrite local   directory   '/app/hive' select * from b";
//    sql= sql.replace("local directory","table");
//    String sql = "load data inpath '' ";
//    String lower = sql.toLowerCase().replaceAll(" +", " ");
//    if (lower.contains("insert overwrite local directory")) {
//      lower = lower.replace("insert overwrite local directory", "insert overwrite table");
//    } else if (lower.contains("insert overwrite directory")) {
//      lower = lower.replace("insert overwrite directory", "insert overwrite table");
//    }
//
//    List<SQLStatement> statementList = SQLUtils.parseStatements(lower, DbType.hive);
//
//    SchemaStatVisitor ss = new SchemaStatVisitor(DbType.hive);
//    statementList.get(0).accept(ss);
//    System.out.println("");
//

//    String sql = "select c1,c2,t2.c3 from db1.t1 t1 left join db2.t2 t2 on t1.id = t2.id where t1.a= '123'";

//    String sql = "select * from mgwh_rd_rpt.rpt_core_active_d t " +
//            "where t.id in (select * from mgwh_whsjxm_ods.ods_video_vr_app_visit_18267_d) and t.dayid = '20220808'";
//    String sql = "select * from mgwh_rd_rpt.rpt_core_active_d t " +
//            "where t.id in (select * from mgwh_whsjxm_ods.ods_video_vr_app_visit_18267_d where da = 123) and t.dayid = '20220808'";
//    String sql = "select dayid,count(distinct puid),count(distinct case when puid_type='msisdn' then puid end) from mgwh_rd_dwm.dwm_cmread_active_mtd " +
//            "  where dayid >='20220920' and province_name='山东' and city_name='未知' group by  dayid";
//    String sql = "SELECT dayid AS `日期`, phn AS `手机号`,  odid AS `订单号`,  reqt AS `请求时间`,  ctp AS `子公司`,  cc AS `渠道代码`,  spsc AS `业务代码`, fee AS `金额（分）`, cplc AS `验证方式`," +
//            "  rlt AS `返回码`, rmsg AS `计费结果` FROM  sunshine.sunshine20_sdk_jf_month t WHERE (  phn='13413580225' AND ( dayid BETWEEN '2017-06-27' AND '2017-06-27' )   );";
//    String sql = "select * from mgwh_rd_rpt.rpt_core_active_d t1 " +
//            "left join mgwh_whsjxm_ods.ods_video_vr_app_visit_18267_d t2 " +
//            "on t1.id = t2.id where t1.dayid = '20220808'";
//    String sql = "use ods;select * from db.tt where monthid = '123' limit 10;";
//    String sql = "select * from db.tt where substr(hourid,1,8) = '123123'";
//    String sql = "select * from  mgwh_rd_rpt.rpt_core_active_d where substr(dayid,1,6) = '3' and id = 1";
    String sql = "select * from mgwh_rd_dim.dim_cartoon_pack_d where dayid in (select dayid from mgwh_rd_dim.dim_cartoon_pack_d)";

    FilterResult result = SqlFilter.getInstance().filter(sql, "cluster3");
//    System.out.println("");
//    String queryTableSizeSql = "select totalFileSize,totalNumberFiles,table_type,partitioned " +
//            "from hive_table_metadata where db_name ='%s' and table_name = '%s'";
//    String queryTableSize = String.format(queryTableSizeSql, "123", "456");
//    System.out.println(queryTableSize);
    for (String s : "a=1/b=4".split("/")) {
      System.out.println(s);
    }

  }


  public static class TableCacheLoader extends CacheLoader<TableInfo, Optional<TableInfo>> {
    Logger LOGGER = LoggerFactory.getLogger(TableCacheLoader.class);

    @Override
    public Optional<TableInfo> load(TableInfo table) throws Exception {
      LOGGER.info("[mg] no cache find, load cache for: {}.{} ", table.getDb(), table.getTableName());
      // query from hive metastore
      if (!HiveConfig.isValidCluster(table.getCluster())) {
        return Optional.empty();
      }

      Connection conn;
      try {
        conn = JdbcConn.getConn(table.getCluster());
      } catch (Exception e) {
        LOGGER.error("[mg] error when create connection", e);
        return Optional.empty();
      }
      // query size
      String queryTableSizeSql = "select totalFileSize,totalNumberFiles,table_type,partitioned " +
              "from hive_table_metadata where db_name ='%s' and table_name = '%s'";
      String queryTableSize = String.format(queryTableSizeSql, table.getDb(), table.getTableName());
      ResultSet rs = JdbcConn.query(queryTableSize, conn);
      if (rs == null) {
        return Optional.empty();
      }

      boolean partitioned = false;
      while (rs.next()) {
        int totalFileSize = rs.getInt("totalFileSize");
        int totalNumberFiles = rs.getInt("totalNumberFiles");
        partitioned = rs.getBoolean("partitioned");
        table.setTableSize(totalFileSize);
      }

      // 查询分区字段
      if (partitioned) {
        String queryPartitionSql = "select partition_name from hive_partition_visit" +
                " where db_name = '%s' and table_name = '%s' limit 1";
        String queryPartitionColumn = String.format(queryPartitionSql, table.getDb(), table.getTableName());
        ResultSet rs2 = JdbcConn.query(queryPartitionColumn, conn);
        if (rs2 == null) {
          LOGGER.info("rs2 is null....................");
          return Optional.empty();
        }

        while (rs2.next()) {
          // year_month=2018-04/day_id=2018-04-24
          String partStr = rs2.getString("partition_name");
          List<String> columns = new ArrayList<>();
          for (String str : partStr.split("/")) {
            if (str.contains("=")) {
              columns.add(str.split("=")[0]);
            }
          }
          table.setPartitionColumns(columns);
        }
      }

      LOGGER.info("==============================");
      return Optional.of(table);
    }
  }
}
