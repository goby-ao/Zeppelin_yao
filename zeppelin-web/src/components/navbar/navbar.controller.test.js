describe('Controller: NavCtrl', function() {
  // load the controller's module
  beforeEach(angular.mock.module('zeppelinWebApp'));
  let NavCtrl;
  let scope;
  let rootScope;
  let httpMock;
  let websocketMsgSrvMock;

  function httpGetResponse() {
    let response = {};
    response.success = function() {
      return response;
    };
    response.error = function() {
      return response;
    };
    return response;
  }

  function createController($controller, ticket) {
    if (ticket === undefined) {
      delete rootScope.ticket;
    } else {
      rootScope.ticket = ticket;
    }
    websocketMsgSrvMock.getNoteList.calls.reset();
    NavCtrl = $controller('NavCtrl', {
      $scope: scope,
      $http: httpMock,
      noteListFactory: {},
      baseUrlSrv: {
        getRestApiBase: function() {
          return '/api';
        },
      },
      websocketMsgSrv: websocketMsgSrvMock,
      arrayOrderingSrv: {},
      searchService: {},
    });
    return NavCtrl;
  }

  // Initialize the controller and a mock scope
  beforeEach(inject(function($rootScope) {
    rootScope = $rootScope;
    scope = $rootScope.$new();
    httpMock = {
      get: jasmine.createSpy('get').and.returnValue(httpGetResponse()),
    };
    websocketMsgSrvMock = {
      isConnected: jasmine.createSpy('isConnected').and.returnValue(false),
      getNoteList: jasmine.createSpy('getNoteList'),
      listConfigurations: jasmine.createSpy('listConfigurations'),
      getHomeNote: jasmine.createSpy('getHomeNote'),
    };
  }));

  it('does not load notes before auth ticket exists', inject(function($controller) {
    NavCtrl = createController($controller);
    expect(NavCtrl).toBeDefined();
    expect(websocketMsgSrvMock.getNoteList).not.toHaveBeenCalled();
  }));

  it('loads notes when auth ticket exists', inject(function($controller) {
    NavCtrl = createController($controller, {
      principal: 'anonymous',
      ticket: 'anonymous',
      roles: '[]',
    });
    expect(NavCtrl).toBeDefined();
    expect(websocketMsgSrvMock.getNoteList).toHaveBeenCalled();
  }));
});
