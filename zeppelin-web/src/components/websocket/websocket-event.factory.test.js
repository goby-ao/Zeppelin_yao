describe('Factory: websocketEvents', function() {
  let onMessageHandler;
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

  beforeEach(inject(function($rootScope, websocketEvents) {
    rootScope = $rootScope;
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
});
