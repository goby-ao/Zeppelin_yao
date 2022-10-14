package org.apache.zeppelin.interpreter.bigsqlfilter;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;

public class HiveConfig {

  // n1_mysql_exec="mysql -N -h10.194.154.72 -uhive -P3341 -pHigo6*8uKt metastore -e "
  // n2_mysql_exec="mysql -N -h10.194.154.72 -uhive -P3343 -pKiyM6*8vPs hive -e "
  // n3_mysql_exec="mysql -N -h10.194.154.72 -uhive -P3346 -pYr6u*(e8Vs metastore -e "

  static Map<String, String> urls = new HashMap<>();
  static Map<String, String> users = new HashMap<>();
  static Map<String, String> passwords = new HashMap<>();
  static HashSet<String> all_cluster = new HashSet<>();

  static {
    initClusterHiveMetastoreConfig();
  }

  private static void initClusterHiveMetastoreConfig() {
    urls.put("cluster1", "jdbc:mysql://10.194.146.73:3361/data_asset?useSSL=false&serverTimezone=GMT&characterEncoding=utf-8");
    urls.put("cluster2", "jdbc:mysql://10.194.146.73:3362/data_asset?useSSL=false&serverTimezone=GMT&characterEncoding=utf-8");
    urls.put("cluster3", "jdbc:mysql://10.194.146.73:3363/data_asset?useSSL=false&serverTimezone=GMT&characterEncoding=utf-8");

    users.put("cluster1", "data_asset1");
    users.put("cluster2", "data_asset2");
    users.put("cluster3", "data_asset3");

    passwords.put("cluster1", "Not6*%U8xD");
    passwords.put("cluster2", "Lqr6*%W8zF");
    passwords.put("cluster3", "Mps6*%V8yE");

    all_cluster.add("cluster1");
    all_cluster.add("cluster2");
    all_cluster.add("cluster3");
  }


  public static String getUrl(String cluster) {
    return urls.get(cluster);
  }

  public static String getUser(String cluster) {
    return users.get(cluster);
  }

  public static String getPasswd(String cluster) {
    return passwords.get(cluster);
  }

  public static boolean isValidCluster(String cluster) {
    return all_cluster.contains(cluster);
  }


}
