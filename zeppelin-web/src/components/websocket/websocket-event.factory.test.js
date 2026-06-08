describe('Factory: websocketEvents', function() {
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
    window.localStorage.removeItem('zeppelin.quickNote.missingNotes');
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

  it('creates missing quick note without showing error details dialog', function() {
    spyOn(BootstrapDialog, 'show');
    location.path('/notebook/2MW7UC6MZ');

    onMessageHandler({
      data: angular.toJson({
        op: 'ERROR_INFO',
        data: {
          info: 'java.io.IOException: Can not find note: /快速笔记/chenyao_yy/QuickNote_hadoop3_spark\n\tat line',
        },
      }),
    });

    let sentPayload = angular.fromJson(wsMock.send.calls.mostRecent().args[0]);
    expect(BootstrapDialog.show).not.toHaveBeenCalled();
    expect(sentPayload.op).toEqual('NEW_NOTE');
    expect(sentPayload.data.name).toEqual('快速笔记/chenyao_yy/QuickNote_hadoop3_spark');
    expect(sentPayload.data.defaultInterpreterGroup).toEqual('hadoop3_spark');

    let missingNotes = angular.fromJson(window.localStorage.getItem('zeppelin.quickNote.missingNotes'));
    expect(missingNotes['2MW7UC6MZ']).toEqual('快速笔记/chenyao_yy/QuickNote_hadoop3_spark');
  });
});
