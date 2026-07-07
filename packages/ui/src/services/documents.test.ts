import { describe, expect, it } from 'vitest';
import { normalizeTimelineResponse } from './documents';

describe('normalizeTimelineResponse', () => {
  it('accepts the server raw timeline array and maps actor/detail fields', () => {
    const result = normalizeTimelineResponse('doc-1', [
      {
        eventType: 'comment_resolved',
        timestamp: '2026-07-06T12:00:00.000Z',
        data: {
          commentId: 'c1',
          resolvedByDisplayName: 'Frontend Developer',
          resolvedAtVersion: 3,
          resolutionNote: 'Updated the wording',
          lineStart: 42,
        },
      },
    ]);

    expect(result.documentId).toBe('doc-1');
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      type: 'comment_resolved',
      actorName: 'Frontend Developer',
      actorType: 'human',
      versionNumber: 3,
      commentId: 'c1',
      detail: 'Updated the wording',
      lineStart: 42,
    });
  });

  it('keeps wrapped timeline responses backwards compatible', () => {
    const result = normalizeTimelineResponse('doc-1', {
      documentId: 'doc-2',
      events: [
        {
          type: 'version_created',
          eventId: 'v1',
          timestamp: '2026-07-06T12:00:00.000Z',
          versionNumber: 1,
        },
      ],
    });

    expect(result.documentId).toBe('doc-2');
    expect(result.events[0].eventId).toBe('v1');
  });
});
