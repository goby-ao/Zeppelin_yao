/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  QueryList,
  SimpleChanges,
  ViewChildren
} from '@angular/core';
import { ParagraphItem } from '@zeppelin/sdk';

export interface NavNode {
  id: string;
  index: number;
  title: string;
  status: string;
  codeSummary: string;
  fullCode: string;
  duration: string;
  errorMessage: string;
  isVisible: boolean;
  isLocked: boolean;
}

@Component({
  selector: 'zeppelin-notebook-paragraph-nav',
  templateUrl: './paragraph-nav.component.html',
  styleUrls: ['./paragraph-nav.component.less'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class NotebookParagraphNavComponent implements OnChanges, AfterViewInit, OnDestroy {
  @Input() paragraphs: ParagraphItem[] = [];
  @Input() lockedParagraphId: string | null = null;
  @Output() readonly scrollToParagraph = new EventEmitter<string>();
  @Output() readonly lockParagraph = new EventEmitter<string>();
  @Output() readonly unlockParagraph = new EventEmitter<void>();

  nodes: NavNode[] = [];
  hoveredNodeId: string | null = null;
  currentViewingId: string | null = null;

  private observer: IntersectionObserver | null = null;
  private destroy$ = false;

  constructor(private cdr: ChangeDetectorRef, private host: ElementRef) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes.paragraphs) {
      this.buildNodes();
      this.setupObserver();
    }
    if (changes.lockedParagraphId) {
      this.updateLockState();
    }
  }

  ngAfterViewInit(): void {
    this.setupObserver();
  }

  ngOnDestroy(): void {
    this.destroy$ = true;
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }

  private buildNodes(): void {
    this.nodes = (this.paragraphs || []).map((p, i) => ({
      id: p.id,
      index: i,
      title: p.title || `Paragraph #${i + 1}`,
      status: p.status || 'READY',
      codeSummary: this.getCodeSummary(p),
      fullCode: (p.text || '').trim(),
      duration: this.getDuration(p),
      errorMessage: p.errorMessage || '',
      isVisible: false,
      isLocked: p.id === this.lockedParagraphId
    }));
  }

  private updateLockState(): void {
    this.nodes.forEach(n => {
      n.isLocked = n.id === this.lockedParagraphId;
    });
    this.cdr.markForCheck();
  }

  private setupObserver(): void {
    if (this.observer) {
      this.observer.disconnect();
    }
    if (this.destroy$ || !this.paragraphs || !this.paragraphs.length) {
      return;
    }

    this.observer = new IntersectionObserver(
      entries => {
        if (this.lockedParagraphId) {
          this.currentViewingId = this.lockedParagraphId;
        } else {
          let bestId: string | null = null;
          let bestRatio = 0;
          entries.forEach(entry => {
            const id = entry.target.getAttribute('data-paragraph-id');
            if (id && entry.intersectionRatio > bestRatio) {
              bestRatio = entry.intersectionRatio;
              bestId = id;
            }
          });
          if (bestId && bestRatio > 0.3) {
            this.currentViewingId = bestId;
          }
        }
        this.cdr.markForCheck();
      },
      { threshold: [0, 0.3, 0.5, 0.7, 1] }
    );

    setTimeout(() => {
      const elements = document.querySelectorAll('.paragraph-container');
      elements.forEach(el => {
        if (this.observer) {
          this.observer.observe(el);
        }
      });
    });
  }

  onNodeClick(nodeId: string): void {
    this.scrollToParagraph.emit(nodeId);
  }

  onLockToggle(nodeId: string, event: Event): void {
    event.stopPropagation();
    if (this.lockedParagraphId === nodeId) {
      this.unlockParagraph.emit();
    } else {
      this.lockParagraph.emit(nodeId);
    }
  }

  onNodeMouseEnter(nodeId: string): void {
    this.hoveredNodeId = nodeId;
    this.cdr.markForCheck();
  }

  onNodeMouseLeave(): void {
    this.hoveredNodeId = null;
    this.cdr.markForCheck();
  }

  trackById(index: number, node: NavNode): string {
    return node.id;
  }

  getNodeTop(index: number): number {
    if (this.nodes.length <= 1) {
      return 0;
    }
    return (index / (this.nodes.length - 1)) * 100;
  }

  isCurrentViewing(nodeId: string): boolean {
    if (this.lockedParagraphId) {
      return nodeId === this.lockedParagraphId;
    }
    return nodeId === this.currentViewingId;
  }

  getStatusColor(status: string): string {
    switch (status) {
      case 'PENDING':
        return '#1890ff';
      case 'RUNNING':
        return '#1890ff';
      case 'FINISHED':
        return '#52c41a';
      case 'ERROR':
        return '#ff4d4f';
      case 'ABORT':
        return '#faad14';
      default:
        return '#bfbfbf';
    }
  }

  getStatusIcon(status: string): string {
    switch (status) {
      case 'PENDING':
        return 'clock-circle';
      case 'RUNNING':
        return 'sync';
      case 'FINISHED':
        return 'check-circle';
      case 'ERROR':
        return 'close-circle';
      case 'ABORT':
        return 'warning';
      default:
        return 'minus-circle';
    }
  }

  getStatusLabel(status: string): string {
    switch (status) {
      case 'READY':
        return 'Ready';
      case 'PENDING':
        return 'Pending';
      case 'RUNNING':
        return 'Running';
      case 'FINISHED':
        return 'Finished';
      case 'ERROR':
        return 'Error';
      case 'ABORT':
        return 'Aborted';
      default:
        return status;
    }
  }

  private getCodeSummary(p: ParagraphItem): string {
    const text = (p.text || '').trim();
    if (!text) {
      return '';
    }
    const lines = text.split('\n');
    const firstLine = lines[0].replace(/^%\w+\s*/, '').trim();
    return (firstLine || text).substring(0, 50);
  }

  private getDuration(p: ParagraphItem): string {
    if (!p.dateStarted) {
      return '';
    }
    const start = new Date(p.dateStarted).getTime();
    const end = p.dateFinished ? new Date(p.dateFinished).getTime() : Date.now();
    const seconds = (end - start) / 1000;
    if (seconds < 0) {
      return '';
    }
    if (seconds < 60) {
      return `${seconds.toFixed(1)}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainSec = Math.floor(seconds % 60);
    return `${minutes}m ${remainSec}s`;
  }
}
