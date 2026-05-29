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

angular.module('zeppelinWebApp').directive('paragraphNav', paragraphNav);

function paragraphNav() {
  'ngInject';

  return {
    restrict: 'E',
    template: require('./paragraph-nav.html'),
    scope: {
      paragraphs: '=',
      lockedParagraphId: '=',
      onLockToggle: '&',
      onNodeClick: '&',
    },
    link: function(scope) {
      scope.nodes = [];
      scope.hoveredNodeId = null;
      scope.currentViewingId = null;

      let observer = null;
      let hideTooltipTimer = null;

      scope.onNodeEnter = function(nodeId) {
        if (hideTooltipTimer) {
          clearTimeout(hideTooltipTimer);
          hideTooltipTimer = null;
        }
        scope.hoveredNodeId = nodeId;
      };

      scope.onNodeLeave = function() {
        hideTooltipTimer = setTimeout(function() {
          scope.hoveredNodeId = null;
          scope.$apply();
        }, 200);
      };

      scope.onTooltipEnter = function() {
        if (hideTooltipTimer) {
          clearTimeout(hideTooltipTimer);
          hideTooltipTimer = null;
        }
      };

      scope.onTooltipLeave = function() {
        scope.hoveredNodeId = null;
      };

      function buildNodes() {
        let paragraphs = scope.paragraphs || [];
        scope.nodes = paragraphs.map(function(p, i) {
          return {
            id: p.id,
            index: i,
            title: p.title || 'Paragraph #' + (i + 1),
            status: p.status || 'READY',
            codeSummary: getCodeSummary(p),
            fullCode: (p.text || '').trim(),
            duration: getDuration(p),
            errorMessage: p.errorMessage || '',
            isLocked: p.id === scope.lockedParagraphId,
          };
        });
      }

      function updateLockState() {
        scope.nodes.forEach(function(n) {
          n.isLocked = n.id === scope.lockedParagraphId;
        });
      }

      function getCodeSummary(p) {
        let text = (p.text || '').trim();
        if (!text) {
          return '';
        }
        let lines = text.split('\n');
        let firstLine = lines[0].replace(/^%\w+\s*/, '').trim();
        return (firstLine || text).substring(0, 50);
      }

      function getDuration(p) {
        if (!p.dateStarted) {
          return '';
        }
        let start = new Date(p.dateStarted).getTime();
        let end = p.dateFinished ? new Date(p.dateFinished).getTime() : Date.now();
        let seconds = (end - start) / 1000;
        if (seconds < 0) {
          return '';
        }
        if (seconds < 60) {
          return seconds.toFixed(1) + 's';
        }
        let minutes = Math.floor(seconds / 60);
        let remainSec = Math.floor(seconds % 60);
        return minutes + 'm ' + remainSec + 's';
      }

      scope.getNodeTop = function(index) {
        if (scope.nodes.length <= 1) {
          return 0;
        }
        return (index / (scope.nodes.length - 1)) * 100;
      };

      scope.isCurrentViewing = function(nodeId) {
        if (scope.lockedParagraphId) {
          return nodeId === scope.lockedParagraphId;
        }
        return nodeId === scope.currentViewingId;
      };

      scope.getStatusColor = function(status) {
        switch (status) {
          case 'PENDING': return '#1f6feb';
          case 'RUNNING': return '#1f6feb';
          case 'FINISHED': return '#16a34a';
          case 'ERROR': return '#dc2626';
          case 'ABORT': return '#ca8a04';
          default: return '#bfbfbf';
        }
      };

      scope.getStatusLabel = function(status) {
        switch (status) {
          case 'READY': return 'Ready';
          case 'PENDING': return 'Pending';
          case 'RUNNING': return 'Running';
          case 'FINISHED': return 'Finished';
          case 'ERROR': return 'Error';
          case 'ABORT': return 'Aborted';
          default: return status;
        }
      };

      function setupObserver() {
        if (observer) {
          observer.disconnect();
        }
        if (!scope.paragraphs || !scope.paragraphs.length) {
          return;
        }

        observer = new IntersectionObserver(function(entries) {
          if (scope.lockedParagraphId) {
            scope.currentViewingId = scope.lockedParagraphId;
          } else {
            let bestId = null;
            let bestRatio = 0;
            entries.forEach(function(entry) {
              let id = entry.target.getAttribute('data-paragraph-id');
              if (id && entry.intersectionRatio > bestRatio) {
                bestRatio = entry.intersectionRatio;
                bestId = id;
              }
            });
            if (bestId && bestRatio > 0.3) {
              scope.currentViewingId = bestId;
            }
          }
          scope.$apply();
        }, {threshold: [0, 0.3, 0.5, 0.7, 1.0]});

        setTimeout(function() {
          let elements = document.querySelectorAll('[data-paragraph-id]');
          for (let i = 0; i < elements.length; i++) {
            observer.observe(elements[i]);
          }
        });
      }

      scope.$watch('paragraphs', function(newVal) {
        if (newVal && newVal.length) {
          buildNodes();
          setupObserver();
        }
      });

      scope.$watch('lockedParagraphId', function() {
        updateLockState();
      });

      scope.$on('$destroy', function() {
        if (observer) {
          observer.disconnect();
          observer = null;
        }
      });
    },
  };
}
