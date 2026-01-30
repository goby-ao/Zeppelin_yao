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
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * sql filter for mg
 */
public class MgSQLFilter {

  private static final Logger LOGGER = LoggerFactory.getLogger(MgSQLFilter.class);

  private static final String clusters = "cluster1,cluster2,cluster3,dev,hb3_cluster3";

  // 1. 保持 TableCheck 不变，它仍然代表最里面的数据单元
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

    // 这个辅助方法可以保留
    public String getFullTable() {
      return db + "." + table;
    }
  }

  // 2. 新增一个类，用来对应 JSON 中的 "data" 对象结构
  static class CheckData {
    private List<TableCheck> unsafeList;
    private List<TableCheck> unSettingList;

    public List<TableCheck> getUnsafeList() {
      return unsafeList;
    }

    public void setUnsafeList(List<TableCheck> unsafeList) {
      this.unsafeList = unsafeList;
    }

    public List<TableCheck> getUnSettingList() {
      return unSettingList;
    }

    public void setUnSettingList(List<TableCheck> unSettingList) {
      this.unSettingList = unSettingList;
    }
  }

  // 3. 修改 FilterResult，将 data 字段的类型从 List 改为上面的 CheckData 类
  static class FilterResult {
    private String rspdesc;
    private int rspcode;
    // 修改处：这里不再是 List<TableCheck>，而是 CheckData 对象
    private CheckData data;

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

    public CheckData getData() {
      return data;
    }

    public void setData(CheckData data) {
      this.data = data;
    }
  }

  /**
   * filter sensitive table
   *
   * @param sql
   * @param cluster: cluster1 cluster2 cluster3
   * @param restApi
   * @param user
   * @return null if check pass，list when find sensitive table
   */
  public static InterpreterResult filterSensitiveTable(String sql, String cluster, String restApi, String user) {

    // ^ 表示开头，\\s 表示空白字符，+ 表示一个或多个
    String result = sql.replaceFirst("^\\s+", "");
    if (result.startsWith("--;")) {
      return null;
    }

    if (cluster == null || cluster.isEmpty()) {
      LOGGER.warn("[mg] config: 'zeppelin.jdbc.mg.filter.cluster'" +
              " is empty, skip mg filter");
      return null;
    }

    List<SQLStatement> statementList = SQLUtils.parseStatements(sql, DbType.hive);
    List<TableCheck> list = new ArrayList<>();
    LOGGER.info("[mg] config info: cluster:{}, rest:{}", cluster, restApi);

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

    Map<String, Object> requestBody = new HashMap<>();
    requestBody.put("tables", list);
    requestBody.put("accountName", user); // 替换为实际的accountName

    Gson gson = new Gson();
    String checkInfo = gson.toJson(requestBody);
    LOGGER.info("[mg] user: {}, tables to check: {}", user, checkInfo);

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

      // 安全校验：data 为 null 视为无风险
      if (resultList == null || resultList.getData() == null) {
        return null;
      }

      CheckData checkData = resultList.getData();
      List<TableCheck> unsafeList = checkData.getUnsafeList();
      List<TableCheck> unSettingList = checkData.getUnSettingList();

      // 仅当两个列表均为空时放行
      boolean hasUnsafe = unsafeList != null && !unsafeList.isEmpty();
      boolean hasUnSetting = unSettingList != null && !unSettingList.isEmpty();
      if (!hasUnsafe && !hasUnSetting) {
        return null;
      }

      // 构建结构化拦截消息
      StringBuilder msgBuilder = new StringBuilder();
      msgBuilder.append("【查询已拦截】\n\n");

      // 敏感表部分
      if (hasUnsafe) {
        msgBuilder.append("⚠️ 拦截原因：检测到【敏感数据表】\n");
        msgBuilder.append("根据安全规范，查询敏感表需完成金库认证。\n");
        msgBuilder.append("涉及表清单（共 ").append(unsafeList.size()).append(" 个）：\n");
        for (TableCheck table : unsafeList) {
          msgBuilder.append(String.format("  • %s (集群: %s)\n",
                  table.getFullTable(),
                  table.getCluster() != null ? table.getCluster() : "N/A"));
        }
        msgBuilder.append("\n");
      }

      // 未设置敏感级别部分
      if (hasUnSetting) {
        msgBuilder.append("⚠️ 拦截原因：检测到【未配置敏感级别的表】\n");
        msgBuilder.append("根据安全规范，所有查询表必须明确敏感级别，未配置表禁止查询。\n");
        msgBuilder.append("涉及表清单（共 ").append(unSettingList.size()).append(" 个）：\n");
        for (TableCheck table : unSettingList) {
          msgBuilder.append(String.format("  • %s (集群: %s)\n",
                  table.getFullTable(),
                  table.getCluster() != null ? table.getCluster() : "N/A"));
        }
        msgBuilder.append("\n");
      }

      // 操作指引（精准对应问题类型）
      msgBuilder.append("📌 操作指引：\n");
      if (hasUnsafe) {
        msgBuilder.append("1️⃣ 敏感表查询：请通过页面右上角「金库认证」入口完成认证后重试。\n");
      }
      if (hasUnSetting) {
        msgBuilder.append("2️⃣ 未配置表处理：请立即联系数据管理员为上述表设置敏感级别。\n");
        msgBuilder.append("   （路径示例：数据管理 -> hive表管理 -> 编辑表分类分级）\n");
      }
      msgBuilder.append("\n🔒 安全提示：数据安全人人有责，感谢您的理解与配合！");

      String filterMsg = msgBuilder.toString(); // 修正拼写：filterMsg
      LOGGER.warn("Query blocked due to sensitive tables. Details:\n{}", filterMsg);
      return new InterpreterResult(InterpreterResult.Code.ERROR, filterMsg);
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