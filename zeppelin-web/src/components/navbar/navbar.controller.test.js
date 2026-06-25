import {
  setCurrentZeppelinClusterNameFromConfigurations,
} from '../../app/quick-note.config';

describe('Controller: NavCtrl', function() {
  // load the controller's module
  beforeEach(angular.mock.module('zeppelinWebApp'));
  const RECENT_NOTES_KEY = 'zp_recent_notes.ns3';
  const NS2_RECENT_NOTES_KEY = 'zp_recent_notes.ns2';
  const OLD_RECENT_NOTES_KEY = 'zp_recent_notes';
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

  function createController($controller, ticket, overrides) {
    overrides = overrides || {};
    if (ticket === undefined) {
      delete rootScope.ticket;
    } else {
      rootScope.ticket = ticket;
    }
    websocketMsgSrvMock.getNoteList.calls.reset();
    NavCtrl = $controller('NavCtrl', {
      $scope: scope,
      $http: httpMock,
      noteListFactory: overrides.noteListFactory || {},
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
    setCurrentZeppelinClusterNameFromConfigurations({'zeppelin.audit.cluster.name': 'ns3'});
    window.localStorage.removeItem(RECENT_NOTES_KEY);
    window.localStorage.removeItem(NS2_RECENT_NOTES_KEY);
    window.localStorage.removeItem(OLD_RECENT_NOTES_KEY);
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

  afterEach(function() {
    setCurrentZeppelinClusterNameFromConfigurations({'zeppelin.audit.cluster.name': 'ns3'});
    window.localStorage.removeItem(RECENT_NOTES_KEY);
    window.localStorage.removeItem(NS2_RECENT_NOTES_KEY);
    window.localStorage.removeItem(OLD_RECENT_NOTES_KEY);
  });

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

  it('reads recent notes from localStorage and keeps starred notes first', inject(function($controller) {
    window.localStorage.setItem(RECENT_NOTES_KEY, angular.toJson([
      {id: '2', name: 'Later note', time: 1000},
      {id: '1', name: 'Starred note', time: 100, starred: true},
      {id: '3', name: 'Newest note', time: 2000},
    ]));

    NavCtrl = createController($controller, {
      principal: 'anonymous',
      ticket: 'anonymous',
      roles: '[]',
    });

    expect(NavCtrl.recentNotes.length).toEqual(3);
    expect(NavCtrl.recentNotes[0].id).toEqual('1');
    expect(NavCtrl.recentNotes[1].id).toEqual('3');
    expect(NavCtrl.recentNotes[2].id).toEqual('2');
  }));

  it('shows all recent notes in descending time order', inject(function($controller) {
    let notes = [];
    for (let i = 0; i < 10; i++) {
      notes.push({id: String(i), name: 'Note ' + i, time: i});
    }
    window.localStorage.setItem(RECENT_NOTES_KEY, angular.toJson(notes));

    NavCtrl = createController($controller, {
      principal: 'anonymous',
      ticket: 'anonymous',
      roles: '[]',
    });

    expect(NavCtrl.recentNotes.length).toEqual(10);
    expect(NavCtrl.recentNotes[0].id).toEqual('9');
    expect(NavCtrl.recentNotes[9].id).toEqual('0');
  }));

  it('filters out stale recent notes when note list is available', inject(function($controller) {
    window.localStorage.setItem(RECENT_NOTES_KEY, angular.toJson([
      {id: '1', name: 'Existing note', time: 200},
      {id: '2', name: 'Deleted note', time: 100},
    ]));

    NavCtrl = createController($controller, {
      principal: 'anonymous',
      ticket: 'anonymous',
      roles: '[]',
    }, {
      noteListFactory: {
        flatList: [{id: '1', name: 'Existing note'}],
      },
    });

    expect(NavCtrl.recentNotes.length).toEqual(1);
    expect(NavCtrl.recentNotes[0].id).toEqual('1');
  }));

  it('refreshes recent notes from the active Zeppelin cluster storage key', inject(function($controller) {
    window.localStorage.setItem(OLD_RECENT_NOTES_KEY, angular.toJson([
      {id: 'old', name: 'Old unscoped note', time: 300},
    ]));
    window.localStorage.setItem(RECENT_NOTES_KEY, angular.toJson([
      {id: 'ns3', name: 'NS3 note', time: 100},
    ]));
    window.localStorage.setItem(NS2_RECENT_NOTES_KEY, angular.toJson([
      {id: 'ns2-a', name: 'NS2 note A', time: 200},
      {id: 'ns2-b', name: 'NS2 note B', time: 100},
    ]));

    NavCtrl = createController($controller, {
      principal: 'anonymous',
      ticket: 'anonymous',
      roles: '[]',
    });

    expect(NavCtrl.recentNotes.length).toEqual(1);
    expect(NavCtrl.recentNotes[0].id).toEqual('ns3');

    setCurrentZeppelinClusterNameFromConfigurations({'zeppelin.audit.cluster.name': 'ns2'});
    rootScope.$broadcast('zeppelinClusterNameChanged', 'ns2');

    expect(NavCtrl.recentNotes.length).toEqual(2);
    expect(NavCtrl.recentNotes[0].id).toEqual('ns2-a');
    expect(NavCtrl.recentNotes[1].id).toEqual('ns2-b');
  }));
});
