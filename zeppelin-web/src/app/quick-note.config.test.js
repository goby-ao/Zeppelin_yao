import {
  getCurrentZeppelinClusterName,
  getEnabledNoteClusters,
  getNoteClusterByInterpreterBinding,
  getQuickNoteKey,
  getQuickNoteMagic,
  getRecentNotesStorageKey,
  normalizeNoteCluster,
  setCurrentZeppelinClusterNameFromConfigurations,
} from './quick-note.config';

describe('Quick note cluster config', function() {
  afterEach(function() {
    setCurrentZeppelinClusterNameFromConfigurations({'zeppelin.audit.cluster.name': 'ns3'});
  });

  it('disables Hadoop3 quick notes for ns2 deployment', function() {
    const clusters = getEnabledNoteClusters('ns2').map((cluster) => cluster.key);

    expect(clusters).toEqual(['hadoop2']);
    expect(normalizeNoteCluster('hadoop3', 'ns2')).toEqual('hadoop2');
    expect(getQuickNoteMagic('spark', 'hadoop3', 'ns2')).toEqual('%spark3');
    expect(getQuickNoteKey('spark', 'hadoop3', 'ns2')).toEqual('spark3');
  });

  it('keeps Hadoop3 quick notes available for ns1, ns3 and unknown deployments', function() {
    expect(getEnabledNoteClusters('ns1').map((cluster) => cluster.key)).toEqual(['hadoop2', 'hadoop3']);
    expect(getEnabledNoteClusters('ns3').map((cluster) => cluster.key)).toEqual(['hadoop2', 'hadoop3']);
    expect(getEnabledNoteClusters(undefined).map((cluster) => cluster.key)).toEqual(['hadoop2', 'hadoop3']);
    expect(getQuickNoteMagic('spark', 'hadoop3', 'ns3')).toEqual('%hadoop3_spark');
  });

  it('uses ns1 Hadoop3 interpreter names', function() {
    expect(getQuickNoteMagic('hive', 'hadoop3', 'ns1')).toEqual('%hive3');
    expect(getQuickNoteMagic('spark', 'hadoop3', 'ns1')).toEqual('%spark3');
    expect(getQuickNoteKey('hive', 'hadoop3', 'ns1')).toEqual('hive3');
    expect(getNoteClusterByInterpreterBinding('hive3', 'ns1')).toEqual('hadoop3');
  });

  it('reads current Zeppelin cluster name from configurations', function() {
    setCurrentZeppelinClusterNameFromConfigurations({'zeppelin.audit.cluster.name': 'ns2'});

    expect(getCurrentZeppelinClusterName()).toEqual('ns2');
    expect(getRecentNotesStorageKey()).toEqual('zp_recent_notes.ns2');
  });
});
