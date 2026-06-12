describe('Factory: websocketEvents', function() {
  const RECENT_NOTES_STORAGE_KEY = 'zp_recent_notes.ns3';
  let onMessageHandler;
  let location;
  let rootScope;
  let wsMock;
  let websocketEventsSrv;

  beforeEach(angular.mock.module('zeppelinWebApp', function($provide) {
    wsMock = {
      socket: {
        readyState: 1,
      },
      send: jasmine.createSpy('send'),
      onOpen: jasmine.createSpy('onOpen'),
      onMessage: function(handler) {
        onMessageHandler = handler;
      },
      onError: jasmine.createSpy('onError'),
      onClose: jasmine.createSpy('onClose'),
    };

    $provide.value('$websocket', function() {
      return wsMock;
    });
    $provide.value('baseUrlSrv', {
      getWebsocketUrl: function() {
        return 'ws://localhost/ws';
      },
    });
    $provide.value('saveAsService', {});
    $provide.value('ngToast', {
      info: jasmine.createSpy('info'),
    });
  }));

  beforeEach(inject(function($rootScope, websocketEvents, $location) {
    rootScope = $rootScope;
    location = $location;
    websocketEventsSrv = websocketEvents;
    rootScope.ticket = {
      principal: 'anonymous',
      ticket: 'anonymous',
      roles: '[]',
    };
    expect(websocketEventsSrv).toBeDefined();
  }));

  afterEach(function() {
    delete rootScope.ticket;
    window.localStorage.removeItem(RECENT_NOTES_STORAGE_KEY);
  });

  it('does not show an empty error details dialog', function() {
    spyOn(BootstrapDialog, 'show');
    onMessageHandler({
      data: angular.toJson({
        op: 'ERROR_INFO',
        data: {
          info: '',
        },
      }),
    });
    expect(BootstrapDialog.show).not.toHaveBeenCalled();
  });

  it('uses anonymous websocket identity before auth ticket exists', function() {
    delete rootScope.ticket;

    websocketEventsSrv.sendNewEvent({op: 'PING'});

    let sentPayload = angular.fromJson(wsMock.send.calls.mostRecent().args[0]);
    expect(sentPayload.principal).toEqual('anonymous');
    expect(sentPayload.ticket).toEqual('anonymous');
    expect(sentPayload.roles).toEqual('[]');
  });

  it('still shows non-empty error details dialog', function() {
    spyOn(BootstrapDialog, 'show');
    onMessageHandler({
      data: angular.toJson({
        op: 'ERROR_INFO',
        data: {
          info: 'Permission denied',
        },
      }),
    });
    expect(BootstrapDialog.show).toHaveBeenCalled();
  });

  it('silently redirects and cleans up recent notes for missing quick notes', function() {
    spyOn(BootstrapDialog, 'show');
    location.path('/notebook/2MW7UC6MZ');

    // Seed recent notes with the deleted note so we can verify cleanup
    window.localStorage.setItem(RECENT_NOTES_STORAGE_KEY, angular.toJson([
      {id: '2MW7UC6MZ', name: 'QuickNote_hadoop3_spark', time: 1},
      {id: 'OTHER_NOTE', name: 'other', time: 2},
    ]));

    onMessageHandler({
      data: angular.toJson({
        op: 'ERROR_INFO',
        data: {
          info: 'java.io.IOException: Can not find note: /快速笔记/chenyao_yy/QuickNote_hadoop3_spark\n\tat line',
        },
      }),
    });

    expect(BootstrapDialog.show).not.toHaveBeenCalled();
    expect(location.path()).toEqual('/');

    // Should have removed the deleted note from recent notes
    let recentNotes = angular.fromJson(window.localStorage.getItem(RECENT_NOTES_STORAGE_KEY));
    expect(recentNotes.length).toEqual(1);
    expect(recentNotes[0].id).toEqual('OTHER_NOTE');
  });

  it('reloads note list and shows toast for stale quick notes in trash operations', function() {
    spyOn(BootstrapDialog, 'show');
    location.path('/');

    // Simulate clicking delete on a stale quick note in trash
    onMessageHandler({
      data: angular.toJson({
        op: 'ERROR_INFO',
        data: {
          info: 'java.io.IOException: Can not find note: /~Trash/快速笔记/chenyao_yy/QuickNote_hadoop3_hive\n\tat line',
        },
      }),
    });

    expect(BootstrapDialog.show).not.toHaveBeenCalled();
    // Should still be on home page (no redirect since we were already there)
    expect(location.path()).toEqual('/');

    // Should have sent RELOAD_NOTES_FROM_REPO to refresh the list
    let lastPayload = angular.fromJson(wsMock.send.calls.mostRecent().args[0]);
    expect(lastPayload.op).toEqual('RELOAD_NOTES_FROM_REPO');
  });
});
