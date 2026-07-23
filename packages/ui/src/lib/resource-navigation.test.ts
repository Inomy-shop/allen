import { describe, expect, it } from 'vitest';
import { chatSessionIdFromHref, filePathFromReference, mediaKindForPath, mimeTypeForMediaPath } from './resource-navigation';

describe('resource navigation classification', () => {
  it('recognizes repository file references and strips line anchors', () => {
    expect(filePathFromReference('packages/ui/src/App.tsx:42')).toBe('packages/ui/src/App.tsx');
    expect(filePathFromReference('./README.md#L12-L20')).toBe('README.md');
    expect(filePathFromReference('not a file')).toBeNull();
    expect(filePathFromReference('https://example.com/file.ts')).toBeNull();
  });

  it('classifies image and video resources', () => {
    expect(mediaKindForPath('preview.PNG')).toBe('image');
    expect(mediaKindForPath('demo.webm?raw=1')).toBe('video');
    expect(mimeTypeForMediaPath('demo.mov')).toBe('video/quicktime');
    expect(mediaKindForPath('notes.md')).toBeNull();
  });

  it('recognizes same-origin Allen chat routes only', () => {
    window.history.replaceState({}, '', '/chat/current');
    expect(chatSessionIdFromHref('/chat/session-2')).toBe('session-2');
    expect(chatSessionIdFromHref('https://example.com/chat/session-2')).toBeNull();
  });
});
