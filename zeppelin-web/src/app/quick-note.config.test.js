import {
  getEnabledNoteClusters,
  getQuickNoteKey,
  getQuickNoteMagic,
  normalizeNoteCluster,
} from './quick-note.config';

describe('Quick note cluster config', function() {
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
});
