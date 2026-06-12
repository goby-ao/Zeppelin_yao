export const QUICK_NOTE_ROOT = '快速笔记';

export const ZEPPELIN_CLUSTER_CONFIG_KEY = 'zeppelin.audit.cluster.name';
export const DEFAULT_ZEPPELIN_CLUSTER_NAME = 'ns3';
export const DEFAULT_NOTE_CLUSTER = 'hadoop2';
export const NOTE_CLUSTER_STORAGE_KEY = 'zeppelin.quickNote.cluster';
export const RECENT_NOTES_KEY = 'zp_recent_notes';

export const NOTE_CLUSTERS = [
  {key: 'hadoop2', label: 'Hadoop2'},
  {key: 'hadoop3', label: 'Hadoop3'},
];

const ZEPPELIN_CLUSTER_CONFIGS = {
  ns1: {
    enabledClusters: ['hadoop2', 'hadoop3'],
    bindings: {
      hadoop2: {
        hive: 'hive',
        spark: 'spark3',
      },
      hadoop3: {
        hive: 'hive3',
        spark: 'spark3',
      },
    },
  },
  ns2: {
    enabledClusters: ['hadoop2'],
    bindings: {
      hadoop2: {
        hive: 'hive',
        spark: 'spark3',
      },
    },
  },
  ns3: {
    enabledClusters: ['hadoop2', 'hadoop3'],
    bindings: {
      hadoop2: {
        hive: 'hive',
        spark: 'spark3',
      },
      hadoop3: {
        hive: 'hadoop3_hive',
        spark: 'hadoop3_spark',
      },
    },
  },
};

const GLOBAL_INTERPRETER_BINDINGS = {
  shell: 'sh',
  sh: 'sh',
  python: 'python',
};

const QUICK_NOTE_KEY_ALIASES = {
  spark3: 'spark3',
  hive3: 'hive3',
  hadoop3_hive: 'hadoop3_hive',
  hadoop3_spark: 'hadoop3_spark',
};

let currentZeppelinClusterName = DEFAULT_ZEPPELIN_CLUSTER_NAME;

export function normalizeZeppelinClusterName(clusterName) {
  let normalized = clusterName ? String(clusterName).trim().toLowerCase() : '';
  if (ZEPPELIN_CLUSTER_CONFIGS[normalized]) {
    return normalized;
  }
  return DEFAULT_ZEPPELIN_CLUSTER_NAME;
}

export function getCurrentZeppelinClusterName() {
  return currentZeppelinClusterName;
}

export function setCurrentZeppelinClusterName(clusterName) {
  currentZeppelinClusterName = normalizeZeppelinClusterName(clusterName);
  return currentZeppelinClusterName;
}

export function setCurrentZeppelinClusterNameFromConfigurations(configurations) {
  configurations = configurations || {};
  return setCurrentZeppelinClusterName(configurations[ZEPPELIN_CLUSTER_CONFIG_KEY]);
}

function getZeppelinClusterConfig(clusterName) {
  return ZEPPELIN_CLUSTER_CONFIGS[normalizeZeppelinClusterName(clusterName || currentZeppelinClusterName)];
}

export function getEnabledNoteClusters(clusterName) {
  let enabledClusterKeys = getZeppelinClusterConfig(clusterName).enabledClusters;
  return NOTE_CLUSTERS.filter(function(cluster) {
    return enabledClusterKeys.indexOf(cluster.key) !== -1;
  });
}

export function normalizeNoteCluster(cluster, clusterName) {
  let enabledClusters = getEnabledNoteClusters(clusterName);
  for (let i = 0; i < enabledClusters.length; i++) {
    if (enabledClusters[i].key === cluster) {
      return cluster;
    }
  }
  return DEFAULT_NOTE_CLUSTER;
}

// Scope browser caches by Zeppelin cluster; one account may use ns1/ns2/ns3 in the same browser.
export function getScopedStorageKey(storageKey, clusterName) {
  return storageKey + '.' + normalizeZeppelinClusterName(clusterName || currentZeppelinClusterName);
}

export function getNoteClusterStorageKey(clusterName) {
  return getScopedStorageKey(NOTE_CLUSTER_STORAGE_KEY, clusterName);
}

export function getRecentNotesStorageKey(clusterName) {
  return getScopedStorageKey(RECENT_NOTES_KEY, clusterName);
}

export function getSavedNoteCluster(clusterName) {
  try {
    return normalizeNoteCluster(
      window.localStorage.getItem(getNoteClusterStorageKey(clusterName)),
      clusterName
    );
  } catch (e) {
    return DEFAULT_NOTE_CLUSTER;
  }
}

export function saveNoteCluster(cluster, clusterName) {
  try {
    window.localStorage.setItem(
      getNoteClusterStorageKey(clusterName),
      normalizeNoteCluster(cluster, clusterName)
    );
  } catch (e) {
    // ignore localStorage errors
  }
}

export function isClusterAwareInterpreter(interpreter) {
  return interpreter === 'hive' || interpreter === 'spark';
}

export function getQuickNoteBinding(interpreter, cluster, clusterName) {
  if (GLOBAL_INTERPRETER_BINDINGS[interpreter]) {
    return GLOBAL_INTERPRETER_BINDINGS[interpreter];
  }
  if (QUICK_NOTE_KEY_ALIASES[interpreter]) {
    return QUICK_NOTE_KEY_ALIASES[interpreter];
  }
  if (isClusterAwareInterpreter(interpreter)) {
    let noteCluster = normalizeNoteCluster(cluster, clusterName);
    let bindings = getZeppelinClusterConfig(clusterName).bindings[noteCluster] || {};
    return bindings[interpreter] || interpreter;
  }
  return interpreter;
}

export function getQuickNoteMagic(interpreter, cluster, clusterName) {
  return '%' + getQuickNoteBinding(interpreter, cluster, clusterName);
}

export function getQuickNoteKey(interpreter, cluster, clusterName) {
  let binding = getQuickNoteBinding(interpreter, cluster, clusterName);
  if (binding === 'sh') {
    return 'shell';
  }
  if (binding === 'hive' || binding === 'spark') {
    return interpreter;
  }
  return binding;
}

export function getNoteClusterByInterpreterBinding(interpreterName, clusterName) {
  let bindingName = interpreterName ? String(interpreterName).replace(/^%+/, '') : '';
  let clusterConfig = getZeppelinClusterConfig(clusterName);
  let enabledClusters = getEnabledNoteClusters(clusterName);
  for (let i = 0; i < enabledClusters.length; i++) {
    let noteCluster = enabledClusters[i].key;
    let bindings = clusterConfig.bindings[noteCluster] || {};
    if (bindings.hive === bindingName || bindings.spark === bindingName) {
      return noteCluster;
    }
  }
  return null;
}
