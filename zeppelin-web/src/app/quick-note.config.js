export const QUICK_NOTE_ROOT = '快速笔记';

export const DEFAULT_NOTE_CLUSTER = 'hadoop2';
export const NOTE_CLUSTER_STORAGE_KEY = 'zeppelin.quickNote.cluster';
export const MISSING_QUICK_NOTE_STORAGE_KEY = 'zeppelin.quickNote.missingNotes';

export const NOTE_CLUSTERS = [
  {key: 'hadoop2', label: 'Hadoop2'},
  {key: 'hadoop3', label: 'Hadoop3'},
];

const CLUSTER_INTERPRETER_BINDINGS = {
  hadoop2: {
    hive: 'hive',
    spark: 'spark3',
  },
  hadoop3: {
    hive: 'hadoop3_hive',
    spark: 'hadoop3_spark',
  },
};

const GLOBAL_INTERPRETER_BINDINGS = {
  shell: 'sh',
  sh: 'sh',
  python: 'python',
};

const QUICK_NOTE_KEY_ALIASES = {
  spark3: 'spark3',
  hadoop3_hive: 'hadoop3_hive',
  hadoop3_spark: 'hadoop3_spark',
};

export function normalizeNoteCluster(cluster) {
  for (let i = 0; i < NOTE_CLUSTERS.length; i++) {
    if (NOTE_CLUSTERS[i].key === cluster) {
      return cluster;
    }
  }
  return DEFAULT_NOTE_CLUSTER;
}

export function getSavedNoteCluster() {
  try {
    return normalizeNoteCluster(window.localStorage.getItem(NOTE_CLUSTER_STORAGE_KEY));
  } catch (e) {
    return DEFAULT_NOTE_CLUSTER;
  }
}

export function saveNoteCluster(cluster) {
  try {
    window.localStorage.setItem(NOTE_CLUSTER_STORAGE_KEY, normalizeNoteCluster(cluster));
  } catch (e) {
    // ignore localStorage errors
  }
}

export function isClusterAwareInterpreter(interpreter) {
  return interpreter === 'hive' || interpreter === 'spark';
}

export function getQuickNoteBinding(interpreter, cluster) {
  if (GLOBAL_INTERPRETER_BINDINGS[interpreter]) {
    return GLOBAL_INTERPRETER_BINDINGS[interpreter];
  }
  if (QUICK_NOTE_KEY_ALIASES[interpreter]) {
    return QUICK_NOTE_KEY_ALIASES[interpreter];
  }
  if (isClusterAwareInterpreter(interpreter)) {
    return CLUSTER_INTERPRETER_BINDINGS[normalizeNoteCluster(cluster)][interpreter];
  }
  return interpreter;
}

export function getQuickNoteMagic(interpreter, cluster) {
  return '%' + getQuickNoteBinding(interpreter, cluster);
}

export function getQuickNoteKey(interpreter, cluster) {
  let binding = getQuickNoteBinding(interpreter, cluster);
  if (binding === 'sh') {
    return 'shell';
  }
  if (binding === 'hive' || binding === 'spark') {
    return interpreter;
  }
  return binding;
}
