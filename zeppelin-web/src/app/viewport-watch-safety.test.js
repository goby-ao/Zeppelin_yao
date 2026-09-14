import {
  decorateViewportWatchDirective,
  hasPendingParagraphInterpolation,
  isParagraphElementShell,
  isParagraphScopeInitializing,
  isViewportWatchSuspended,
  shouldSkipViewportWatchDisable,
  VIEWPORT_WATCH_MIN_PARAGRAPH_HEIGHT,
} from './viewport-watch-safety';

describe('viewport watch safety', function() {
  it('detects initializing paragraph scopes', function() {
    expect(isParagraphScopeInitializing({
      paragraph: {_initializing: true},
    })).toBe(true);
    expect(isParagraphScopeInitializing({
      currentParagraph: {_initializing: true},
    })).toBe(true);
    expect(isParagraphScopeInitializing({
      paragraph: {_initializing: false},
    })).toBe(false);
  });

  it('detects note-level viewport-watch suspension from a parent scope', function() {
    expect(isViewportWatchSuspended({
      $parent: {
        viewportWatchSuspend: 1,
      },
    })).toBe(true);
    expect(isViewportWatchSuspended({
      $parent: {
        viewportWatchSuspend: 0,
      },
    })).toBe(false);
  });

  it('skips disabling watchers while a new paragraph is initializing', function() {
    expect(shouldSkipViewportWatchDisable({
      paragraph: {_initializing: true},
    })).toBe(true);
  });

  it('detects paragraph nodes whose id interpolation has not finished', function() {
    expect(hasPendingParagraphInterpolation({
      attributes: [
        {value: '{{currentParagraph.id}}_paragraphColumn_main'},
      ],
    })).toBe(true);
    expect(hasPendingParagraphInterpolation({
      outerHTML: '<div id="{{currentParagraph.id}}_paragraphColumn_main"></div>',
    })).toBe(true);
    expect(hasPendingParagraphInterpolation([{
      attributes: [
        {value: 'paragraph_1_paragraphColumn_main'},
      ],
    }])).toBe(false);
  });

  it('skips disabling watchers while paragraph id interpolation is still pending', function() {
    let rawParagraphElement = [{
      attributes: [
        {value: '{{currentParagraph.id}}_paragraphColumn_main'},
      ],
    }];

    expect(shouldSkipViewportWatchDisable(
      {},
      rawParagraphElement
    )).toBe(true);
  });

  it('skips disabling watchers while paragraph element is still a tiny shell', function() {
    let shellElement = [{
      offsetHeight: VIEWPORT_WATCH_MIN_PARAGRAPH_HEIGHT - 1,
    }];

    expect(isParagraphElementShell({
      currentParagraph: {},
    }, shellElement)).toBe(true);
    expect(shouldSkipViewportWatchDisable({
      currentParagraph: {},
    }, shellElement)).toBe(true);
  });

  it('allows disabling watchers after paragraph rendering is stable', function() {
    expect(shouldSkipViewportWatchDisable({
      currentParagraph: {_initializing: false},
    }, [{
      offsetHeight: VIEWPORT_WATCH_MIN_PARAGRAPH_HEIGHT + 1,
      attributes: [
        {value: 'paragraph_1_paragraphColumn_main'},
      ],
    }])).toBe(false);
  });

  it('keeps watchers enabled while an off-screen paragraph initializes', function() {
    let decoratorFactory;
    decorateViewportWatchDirective({
      decorator: function(name, factory) {
        expect(name).toBe('viewportWatchDirective');
        expect(factory.slice(0, 3)).toEqual(['$delegate', 'scrollMonitor', '$timeout']);
        decoratorFactory = factory[factory.length - 1];
      },
    });

    let timeoutCalls = [];
    let fakeTimeout = function(callback, delay) {
      timeoutCalls.push({
        callback: callback,
        delay: delay,
      });
      return timeoutCalls.length;
    };
    fakeTimeout.cancel = angular.noop;

    let watcher = {
      isInViewport: false,
      enterViewport: angular.noop,
      exitViewport: angular.noop,
      destroy: angular.noop,
    };
    let decorated = decoratorFactory([{}], {
      create: function() {
        return watcher;
      },
      update: angular.noop,
    }, fakeTimeout);
    let link = decorated[0].compile();

    let scope = {
      currentParagraph: {_initializing: true},
      $$watchers: ['interpolation'],
      $eval: function() {
        return 0;
      },
      $evalAsync: function(callback) {
        callback();
      },
      $on: angular.noop,
      $root: {},
    };

    expect(decorated[0].link).toBeUndefined();
    link(scope, {}, {});

    expect(scope.$$watchers).toEqual(['interpolation']);
    expect(scope.$$watchersBackup).toBeUndefined();
  });

  it('disables watchers once the off-screen paragraph is rendered', function() {
    let decoratorFactory;
    decorateViewportWatchDirective({
      decorator: function(name, factory) {
        expect(name).toBe('viewportWatchDirective');
        decoratorFactory = factory[factory.length - 1];
      },
    });

    let fakeTimeout = function() {
      return 1;
    };
    fakeTimeout.cancel = angular.noop;

    let watcher = {
      isInViewport: false,
      enterViewport: angular.noop,
      exitViewport: angular.noop,
      destroy: angular.noop,
    };
    let decorated = decoratorFactory([{}], {
      create: function() {
        return watcher;
      },
      update: angular.noop,
    }, fakeTimeout);
    let link = decorated[0].compile();

    let scope = {
      currentParagraph: {_initializing: false},
      $$watchers: ['interpolation'],
      $eval: function() {
        return 0;
      },
      $evalAsync: function(callback) {
        callback();
      },
      $on: angular.noop,
      $root: {},
    };

    expect(decorated[0].link).toBeUndefined();
    link(scope, [{
      offsetHeight: VIEWPORT_WATCH_MIN_PARAGRAPH_HEIGHT + 1,
      attributes: [
        {value: 'paragraph_1_paragraphColumn_main'},
      ],
    }], {});

    expect(scope.$$watchers).toBeNull();
    expect(scope.$$watchersBackup).toEqual(['interpolation']);
  });

  it('restores disabled watchers while pending paragraph interpolation is protected', function() {
    let decoratorFactory;
    decorateViewportWatchDirective({
      decorator: function(name, factory) {
        expect(name).toBe('viewportWatchDirective');
        decoratorFactory = factory[factory.length - 1];
      },
    });

    let fakeTimeout = function() {
      return 1;
    };
    fakeTimeout.cancel = angular.noop;

    let exitViewport;
    let watcher = {
      isInViewport: false,
      enterViewport: angular.noop,
      exitViewport: function(callback) {
        exitViewport = callback;
      },
      destroy: angular.noop,
    };
    let decorated = decoratorFactory([{}], {
      create: function() {
        return watcher;
      },
      update: angular.noop,
    }, fakeTimeout);
    let link = decorated[0].compile();

    let scope = {
      currentParagraph: {_initializing: true},
      $$watchers: null,
      $$watchersBackup: ['interpolation'],
      $eval: function() {
        return 0;
      },
      $evalAsync: function(callback) {
        callback();
      },
      $digest: jasmine.createSpy('$digest'),
      $on: angular.noop,
      $root: {},
    };

    expect(decorated[0].link).toBeUndefined();
    link(scope, [{
      attributes: [
        {value: '{{currentParagraph.id}}_paragraphColumn_main'},
      ],
    }], {});
    exitViewport();

    expect(scope.$$watchers).toEqual(['interpolation']);
    expect(scope.$$watchersBackup).toBeUndefined();
    expect(scope.$digest).toHaveBeenCalled();
  });

  it('restores watchers and recalculates locations when paragraph initialization finishes', function() {
    let decoratorFactory;
    decorateViewportWatchDirective({
      decorator: function(name, factory) {
        expect(name).toBe('viewportWatchDirective');
        decoratorFactory = factory[factory.length - 1];
      },
    });

    let timeoutCalls = [];
    let fakeTimeout = function(callback, delay) {
      timeoutCalls.push({
        callback: callback,
        delay: delay,
      });
      return timeoutCalls.length;
    };
    fakeTimeout.cancel = angular.noop;

    let registeredEvents = {};
    let watcher = {
      isInViewport: true,
      enterViewport: angular.noop,
      exitViewport: angular.noop,
      destroy: angular.noop,
    };
    let scrollMonitor = {
      create: function() {
        return watcher;
      },
      update: jasmine.createSpy('update'),
      recalculateLocations: jasmine.createSpy('recalculateLocations'),
    };
    let decorated = decoratorFactory([{}], scrollMonitor, fakeTimeout);
    let link = decorated[0].compile();
    let scope = {
      currentParagraph: {_initializing: false},
      $$watchers: null,
      $$watchersBackup: ['interpolation'],
      $eval: function() {
        return 0;
      },
      $digest: jasmine.createSpy('$digest'),
      $on: function(name, callback) {
        registeredEvents[name] = callback;
      },
      $root: {},
    };

    link(scope, [{
      offsetHeight: VIEWPORT_WATCH_MIN_PARAGRAPH_HEIGHT + 1,
      attributes: [
        {value: 'paragraph_1_paragraphColumn_main'},
      ],
    }], {});
    registeredEvents.paragraphInitialized();
    timeoutCalls[0].callback();

    expect(scope.$$watchers).toEqual(['interpolation']);
    expect(scope.$$watchersBackup).toBeUndefined();
    expect(scrollMonitor.update).toHaveBeenCalled();
    expect(scrollMonitor.recalculateLocations).not.toHaveBeenCalled();
  });
});
