import { describe, expect, it } from 'vitest';
import {
  commentOverlapsMarkdownBlock,
  commentStartsInMarkdownBlock,
  findRenderedLineElement,
  splitMarkdownIntoRenderedLineBlocks,
  type MarkdownLineBlock,
} from './ArtifactViewer';
import type { DocumentCommentDoc } from '../../services/documents';

function makeComment(lineStart: number, lineEnd = lineStart): DocumentCommentDoc {
  return {
    commentId: `c-${lineStart}-${lineEnd}`,
    documentId: 'doc-1',
    threadId: 'thread-1',
    authorType: 'human',
    body: 'comment',
    status: 'open',
    anchor: {
      type: lineStart === lineEnd ? 'line' : 'range',
      lineStart,
      lineEnd,
      context: '',
      anchoredAtVersion: 1,
    },
    reopenCount: 0,
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
  };
}

describe('markdown rendered line anchors', () => {
  it('keeps source line numbers attached to rendered markdown blocks', () => {
    const blocks = splitMarkdownIntoRenderedLineBlocks([
      '# Title',
      '',
      'First rendered line',
      '```ts',
      'const value = 1;',
      '```',
      '| Name | Value |',
      '| ---- | ----- |',
      '| A | B |',
      'Last line',
    ].join('\n'));

    expect(blocks.map(({ startLine, endLine, blank }) => ({ startLine, endLine, blank }))).toEqual([
      { startLine: 1, endLine: 1, blank: false },
      { startLine: 2, endLine: 2, blank: true },
      { startLine: 3, endLine: 3, blank: false },
      { startLine: 4, endLine: 6, blank: false },
      { startLine: 7, endLine: 9, blank: false },
      { startLine: 10, endLine: 10, blank: false },
    ]);
  });

  it('matches comments to the rendered block that contains their source line', () => {
    const plainLine: MarkdownLineBlock = {
      key: 'line-3',
      startLine: 3,
      endLine: 3,
      text: 'First rendered line',
      blank: false,
    };
    const codeBlock: MarkdownLineBlock = {
      key: 'fence-4',
      startLine: 4,
      endLine: 6,
      text: '```ts\nconst value = 1;\n```',
      blank: false,
    };

    expect(commentOverlapsMarkdownBlock(makeComment(3), plainLine)).toBe(true);
    expect(commentOverlapsMarkdownBlock(makeComment(5), plainLine)).toBe(false);
    expect(commentOverlapsMarkdownBlock(makeComment(5), codeBlock)).toBe(true);
    expect(commentOverlapsMarkdownBlock(makeComment(2, 5), codeBlock)).toBe(true);
  });

  it('shows the marker only on the block where the comment anchor starts', () => {
    const firstHighlightedLine: MarkdownLineBlock = {
      key: 'line-2',
      startLine: 2,
      endLine: 2,
      text: 'First highlighted line',
      blank: false,
    };
    const continuedHighlightedLine: MarkdownLineBlock = {
      key: 'line-3',
      startLine: 3,
      endLine: 3,
      text: 'Second highlighted line',
      blank: false,
    };
    const rangeComment = makeComment(2, 3);

    expect(commentOverlapsMarkdownBlock(rangeComment, firstHighlightedLine)).toBe(true);
    expect(commentOverlapsMarkdownBlock(rangeComment, continuedHighlightedLine)).toBe(true);
    expect(commentStartsInMarkdownBlock(rangeComment, firstHighlightedLine)).toBe(true);
    expect(commentStartsInMarkdownBlock(rangeComment, continuedHighlightedLine)).toBe(false);
  });

  it('finds the rendered element by source-line range instead of raw percentage math', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <div data-source-line="1" data-source-line-end="1"></div>
      <div data-source-line="4" data-source-line-end="6"></div>
    `;

    expect(findRenderedLineElement(container, 1)).toBe(container.children[0]);
    expect(findRenderedLineElement(container, 5)).toBe(container.children[1]);
    expect(findRenderedLineElement(container, 7)).toBeNull();
  });
});
