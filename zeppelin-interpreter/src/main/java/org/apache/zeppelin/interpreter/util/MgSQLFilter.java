package org.apache.zeppelin.interpreter.util;

import com.alibaba.druid.DbType;
import com.alibaba.druid.sql.SQLUtils;
import com.alibaba.druid.sql.ast.SQLStatement;
import com.alibaba.druid.sql.ast.statement.SQLDescribeStatement;
import com.alibaba.druid.sql.ast.statement.SQLShowCreateTableStatement;
import com.alibaba.druid.sql.ast.statement.SQLShowCreateViewStatement;
import com.alibaba.druid.sql.ast.statement.SQLUseStatement;
import com.alibaba.druid.sql.dialect.hive.stmt.HiveMsckRepairStatement;
import com.alibaba.druid.sql.visitor.SchemaStatVisitor;
import com.alibaba.druid.stat.TableStat;
import com.google.gson.Gson;
import org.apache.http.HttpResponse;
import org.apache.http.client.methods.HttpPost;
import org.apache.http.config.RegistryBuilder;
import org.apache.http.conn.socket.ConnectionSocketFactory;
import org.apache.http.conn.socket.PlainConnectionSocketFactory;
import org.apache.http.conn.ssl.NoopHostnameVerifier;
import org.apache.http.conn.ssl.SSLConnectionSocketFactory;
import org.apache.http.entity.StringEntity;
import org.apache.http.impl.client.CloseableHttpClient;
import org.apache.http.impl.client.HttpClientBuilder;
import org.apache.http.impl.conn.PoolingHttpClientConnectionManager;
import org.apache.http.ssl.SSLContextBuilder;
import org.apache.http.util.EntityUtils;
import org.apache.zeppelin.interpreter.InterpreterResult;

import javax.net.ssl.SSLContext;
import java.security.KeyManagementException;
import java.security.KeyStoreException;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * sql filter for mg
 */
public class MgSQLFilter {

  private static final Logger LOGGER = LoggerFactory.getLogger(MgSQLFilter.class);

  private static final String clusters = "cluster1,cluster2,cluster3,dev";

  static class TableCheck {
    private String cluster;
    private String db;
    private String table;

    public String getCluster() {
      return cluster;
    }

    public void setCluster(String cluster) {
      this.cluster = cluster;
    }

    public String getDb() {
      return db;
    }

    public void setDb(String db) {
      this.db = db;
    }

    public String getTable() {
      return table;
    }

    public void setTable(String table) {
      this.table = table;
    }

    private String getFullTable() {
      return db + "." + table;
    }
  }

  static class FilterResult {
    private String rspdesc;
    private int rspcode;
    private List<TableCheck> data;

    public String getRspdesc() {
      return rspdesc;
    }

    public void setRspdesc(String rspdesc) {
      this.rspdesc = rspdesc;
    }

    public int getRspcode() {
      return rspcode;
    }

    public void setRspcode(int rspcode) {
      this.rspcode = rspcode;
    }

    public List<TableCheck> getData() {
      return data;
    }

    public void setData(List<TableCheck> data) {
      this.data = data;
    }
  }

  /**
   * filter sensitive table
   *
   * @param sql
   * @param cluster: cluster1 cluster2 cluster3
   * @param restApi
   * @return null if check pass，list when find sensitive table
   */
  public static InterpreterResult filterSensitiveTable(String sql, String cluster, String restApi) {
    List<SQLStatement> statementList = SQLUtils.parseStatements(sql, DbType.hive);
    List<TableCheck> list = new ArrayList<>();
    LOGGER.info("[mg] config info: cluster:{}, rest:{}", cluster, restApi);

    if (!clusters.contains(cluster)) {
      LOGGER.warn("[mg] config: 'zeppelin.jdbc.mg.filter.cluster'" +
              " should set to：cluster1 or cluster2 or cluster3, skip mg filter");
      return null;
    }

    if (restApi.equals("-1")) {
      LOGGER.warn("[mg] filter rest api is empty, please config: " +
              "'zeppelin.jdbc.mg.filter.restapi', skip mg filter");
      return null;
    }

    String db = "default";

    // extract all tables
    for (SQLStatement ss : statementList) {
      if (ss instanceof SQLUseStatement) {
        db = ((SQLUseStatement) ss).getDatabase().getSimpleName();
        continue;
      }
      // skip: show create table; desc; msck
      if (ss instanceof SQLShowCreateTableStatement
              || ss instanceof SQLShowCreateViewStatement
              || ss instanceof SQLDescribeStatement
              || ss instanceof HiveMsckRepairStatement) {
        LOGGER.info("[mg] show or desc sql or desc、msck, skip check...");
        continue;
      }

      SchemaStatVisitor statVisitor = new SchemaStatVisitor(DbType.hive);
      ss.accept(statVisitor);

      Map<TableStat.Name, TableStat> tableList = statVisitor.getTables();
      for (TableStat.Name table : tableList.keySet()) {
        String fullTableName = table.getName();
        if (!fullTableName.contains(".")) {
          fullTableName = db + "." + fullTableName;
        }

        if (fullTableName.split("\\.").length == 2) {
          TableCheck tableCheck = new TableCheck();
          tableCheck.setCluster(cluster);
          tableCheck.setDb(fullTableName.split("\\.")[0]);
          tableCheck.setTable(fullTableName.split("\\.")[1]);
          list.add(tableCheck);
        }
      }
    }

    // no table find，sql like select 1
    if (list.isEmpty()) {
      return null;
    }

    // send post request check if exist Sensitive Table
    HttpPost post = new HttpPost(restApi);
    Gson gson = new Gson();
    String checkInfo = gson.toJson(list);
    LOGGER.info("[mg] tables to check: {}", checkInfo);

    try {
      CloseableHttpClient httpClient = createSSLHttpClient();
      post.setEntity(new StringEntity(checkInfo));
      post.setHeader("Content-type", "application/json");
      HttpResponse response = httpClient.execute(post);

      if (response == null || response.getEntity() == null) {
        LOGGER.warn("[mg] filter http response is null, skip check");
        return null;
      }

      String result_object = EntityUtils.toString(response.getEntity());
      LOGGER.info("filter result: " + result_object);
      FilterResult resultList = gson.fromJson(result_object, FilterResult.class);
      if (resultList.getData().isEmpty()) {
        // no sensitive table find
        return null;
      }

      String filerMsg = "【查询已拦截】 您查询的表涉及敏感数据，按安全规范要求，查询需要通过金库审批。\n" +
              "请使用 \"自助报表-自助取数工具\" 重新提交该任务，并前往 \"个人中心获\" 取结果数据。感谢理解和支持！\n" +
              "敏感表信息：" + gson.toJson(resultList.getData());
      return new InterpreterResult(InterpreterResult.Code.ERROR, filerMsg);
    } catch (Exception e) {
      LOGGER.error("[mg] error when post to filter server {}," +
              " skip filter", restApi, e);
      return null;
    }
  }

  private static CloseableHttpClient createSSLHttpClient() throws NoSuchAlgorithmException,
          KeyManagementException, KeyStoreException {
    final SSLContext sslContext = new SSLContextBuilder()
            .loadTrustMaterial(null, (x509CertChain, authType) -> true)
            .build();

    return HttpClientBuilder.create()
            .setSSLContext(sslContext)
            .setConnectionManager(
                    new PoolingHttpClientConnectionManager(
                            RegistryBuilder.<ConnectionSocketFactory>create()
                                    .register("http", PlainConnectionSocketFactory.INSTANCE)
                                    .register("https", new SSLConnectionSocketFactory(sslContext,
                                            NoopHostnameVerifier.INSTANCE))
                                    .build()
                    ))
            .build();

  }
}
