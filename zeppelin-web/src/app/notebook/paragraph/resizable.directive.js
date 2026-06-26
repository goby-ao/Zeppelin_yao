/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

angular.module('zeppelinWebApp').directive('resizable', ResizableDirective);

function ResizableDirective() {
  const FLOATING_HEIGHT_RESIZE_TYPES = ['TABLE', 'NETWORK'];
  const MAX_FLOATING_HEIGHT = 2400;
  const TABLE_HEIGHT_RESIZING_CLASS = 'zp-table-height-resizing';

  let resizableConfig = {
    autoHide: true,
    handles: 'se',
    helper: 'resizable-helper',
    stop: function() {
      angular.element(this).css({'width': '100%', 'height': '100%'});
    },
  };

  let addEvent = function(config) {
    let removeEventByID = function(id) {
      let events = jQuery._data(config.element, 'events')[config.eventType];
      for (let i=0; i < events.length; i++) {
        if (events[i].data && events[i].data.eventID === id) {
          events.splice(i, 1);
          i--;
        }
      }
    };
    removeEventByID(config.eventID);
    angular.element(config.element).bind(config.eventType, {eventID: config.eventID}, config.handler);
    angular.element(config.onDestroyElement).scope().$on('$destroy', () => {
      removeEventByID(config.eventID);
    });
  };

  let shouldShowFloatingHeightHandle = function(resize, elem) {
    return FLOATING_HEIGHT_RESIZE_TYPES.indexOf(resize.graphType) !== -1 &&
      !elem.closest('.zp-pinned-paragraph').length;
  };

  let syncTableResizeHeight = function(elem, height) {
    let heightPx = height + 'px';
    elem.find('.graphContainer').css('height', heightPx);
    elem.find('.ui-grid').css('height', heightPx);
  };

  return {
    restrict: 'A',
    scope: {
      callback: '&onResize',
    },
    link: function postLink(scope, elem, attrs) {
      attrs.$observe('resize', function(resize) {
        let resetResize = function(elem, resize) {
          let colStep = window.innerWidth / 12;
          elem.off('resizestop');
          let conf = angular.copy(resizableConfig);
          if (resize.graphType === 'TABLE' || resize.graphType === 'NETWORK' || resize.graphType === 'TEXT') {
            conf.grid = [colStep, 10];
            conf.minHeight = 100;
          } else {
            conf.grid = [colStep, 10000];
            conf.minHeight = 0;
          }
          if (shouldShowFloatingHeightHandle(resize, elem)) {
            elem.addClass('zp-table-resize-enabled');
            conf.autoHide = false;
            conf.handles = 's,se';
            conf.maxHeight = MAX_FLOATING_HEIGHT;
            conf.start = function() {
              angular.element(document.body).addClass(TABLE_HEIGHT_RESIZING_CLASS);
            };
            conf.resize = function(event, ui) {
              elem.data('zeppelinResizeHeight', ui.size.height);
              syncTableResizeHeight(elem, ui.size.height);
            };
            conf.stop = function(event, ui) {
              angular.element(document.body).removeClass(TABLE_HEIGHT_RESIZING_CLASS);
              elem.data('zeppelinResizeHeight', ui.size.height);
              syncTableResizeHeight(elem, ui.size.height);
              resizableConfig.stop.call(this);
            };
          } else {
            elem.removeClass('zp-table-resize-enabled');
          }
          conf.maxWidth = window.innerWidth;

          elem.resizable(conf);
          elem.on('resizestop', function() {
            if (scope.callback) {
              let height = elem.data('zeppelinResizeHeight') || elem.height();
              elem.removeData('zeppelinResizeHeight');
              if (height < 50) {
                height = 300;
              }
              scope.callback({width: Math.ceil(elem.width() / colStep), height: height});
            }
          });
        };

        resize = JSON.parse(resize);
        if (resize.allowresize === 'true') {
          resetResize(elem, resize);

          addEvent({
            eventID: elem[0].id,
            eventType: 'resize',
            element: window,
            onDestroyElement: elem[0],
            handler: () => resetResize(elem, resize),
          });
        }
      });
    },
  };
}
