/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export const VIEWPORT_WATCH_MIN_PARAGRAPH_HEIGHT = 20;
const VIEWPORT_WATCH_UPDATE_DEBOUNCE_MS = 10;
const PENDING_PARAGRAPH_INTERPOLATION = /\{\{\s*currentParagraph\./;

export function isParagraphScopeInitializing(scope) {
  return !!(scope &&
    ((scope.paragraph && scope.paragraph._initializing) ||
      (scope.currentParagraph && scope.currentParagraph._initializing)));
}

export function isViewportWatchSuspended(scope) {
  let current = scope;
  while (current) {
    if (current.viewportWatchSuspend > 0) {
      return true;
    }
    current = current.$parent;
  }
  return false;
}

export function shouldSkipViewportWatchDisable(scope, element) {
  return isViewportWatchSuspended(scope) ||
    isParagraphScopeInitializing(scope) ||
    hasPendingParagraphInterpolation(element) ||
    isParagraphElementShell(scope, element);
}

export function hasPendingParagraphInterpolation(element) {
  let node = element && (element[0] || element);
  if (!node) {
    return false;
  }

  if (node.attributes) {
    for (let i = 0; i < node.attributes.length; i++) {
      if (PENDING_PARAGRAPH_INTERPOLATION.test(node.attributes[i].value || '')) {
        return true;
      }
    }
  }

  return PENDING_PARAGRAPH_INTERPOLATION.test(node.outerHTML || '');
}

export function isParagraphElementShell(scope, element) {
  let node = element && (element[0] || element);
  if (!node || typeof node.offsetHeight !== 'number') {
    return false;
  }
  if (!scope || (!scope.paragraph && !scope.currentParagraph)) {
    return false;
  }

  return node.offsetHeight < VIEWPORT_WATCH_MIN_PARAGRAPH_HEIGHT;
}

export function decorateViewportWatchDirective($provide) {
  // Use array-style DI because this decorator also runs in the minified WAR.
  // Without explicit dependency names, Angular cannot inject the right services
  // after parameter names are mangled by the production build.
  $provide.decorator('viewportWatchDirective', [
    '$delegate',
    'scrollMonitor',
    '$timeout',
    function($delegate, scrollMonitor, $timeout) {
      let originalDirective = $delegate && $delegate[0];
      if (!originalDirective) {
        return $delegate;
      }

      $delegate[0] = angular.extend({}, originalDirective, {
        compile: function() {
          return createSafeViewportWatchLink(scrollMonitor, $timeout);
        },
      });
      delete $delegate[0].link;
      return $delegate;
    },
  ]);
}

function createSafeViewportWatchLink(scrollMonitor, $timeout) {
  return function(scope, element, attr) {
    let viewportUpdateTimeout;
    let elementWatcher = scrollMonitor.create(element, scope.$eval(attr.viewportWatch || '0'));

    function debouncedViewportUpdate() {
      $timeout.cancel(viewportUpdateTimeout);
      viewportUpdateTimeout = $timeout(function() {
        if (scrollMonitor.update) {
          scrollMonitor.update();
        } else if (scrollMonitor.recalculateLocations) {
          scrollMonitor.recalculateLocations();
        }
      }, VIEWPORT_WATCH_UPDATE_DEBOUNCE_MS);
    }

    function watchDuringDisable(...watchArgs) {
      /* eslint-disable no-invalid-this */
      this.$$watchersBackup = this.$$watchersBackup || [];
      this.$$watchers = this.$$watchersBackup;
      let unwatch = this.constructor.prototype.$watch.apply(this, watchArgs);
      this.$$watchers = null;
      return unwatch;
      /* eslint-enable no-invalid-this */
    }

    function toggleWatchers(scope, enable) {
      let digest;
      let current;
      let next = scope;

      do {
        current = next;

        if (enable) {
          if (current.hasOwnProperty('$$watchersBackup')) {
            current.$$watchers = current.$$watchersBackup;
            delete current.$$watchersBackup;
            delete current.$watch;
            digest = !scope.$root.$$phase;
          }
        } else if (!current.hasOwnProperty('$$watchersBackup')) {
          current.$$watchersBackup = current.$$watchers;
          current.$$watchers = null;
          current.$watch = watchDuringDisable;
        }

        next = current.$$childHead;
        while (!next && current !== scope) {
          if (current.$$nextSibling) {
            next = current.$$nextSibling;
          } else {
            current = current.$parent;
          }
        }
      } while (next);

      if (digest) {
        scope.$digest();
      }
    }

    function disableDigest() {
      if (scope.$$destroyed) {
        return;
      }

      // New paragraphs first render as a tiny ng-repeat shell with raw
      // {{currentParagraph.id}} attributes.  scrollMonitor can measure that
      // shell as off-screen and fire exitViewport before ng-include / ui-ace
      // have had their first full digest.  During that window we must not move
      // watchers into $$watchersBackup; otherwise the shell can stay frozen
      // until a full page refresh.
      if (shouldSkipViewportWatchDisable(scope, element)) {
        toggleWatchers(scope, true);
        return;
      }

      toggleWatchers(scope, false);
    }

    function enableDigest() {
      toggleWatchers(scope, true);
    }

    if (!elementWatcher.isInViewport && !shouldSkipViewportWatchDisable(scope, element)) {
      scope.$evalAsync(disableDigest);
      debouncedViewportUpdate();
    }

    elementWatcher.enterViewport(enableDigest);
    elementWatcher.exitViewport(disableDigest);
    scope.$on('toggleWatchers', function(event, enable) {
      if (enable) {
        enableDigest();
      } else {
        disableDigest();
      }
    });
    let paragraphInitialized = false;
    scope.$on('paragraphInitialized', function() {
      enableDigest();
      if (paragraphInitialized) {
        return;
      }
      paragraphInitialized = true;
      debouncedViewportUpdate();
    });
    scope.$on('$destroy', function() {
      $timeout.cancel(viewportUpdateTimeout);
      elementWatcher.destroy();
      debouncedViewportUpdate();
    });
  };
}
