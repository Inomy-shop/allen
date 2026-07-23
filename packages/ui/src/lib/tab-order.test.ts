import { describe, expect, it } from 'vitest';
import { insertSiblingTab } from './tab-order';

describe('insertSiblingTab', () => {
  it('places a new view directly after the active tab', () => {
    const tabs = [{ id: 'chat-1' }, { id: 'chat-2' }];
    expect(insertSiblingTab(tabs, 'chat-1', tab => tab.id, { id: 'file-explorer' }))
      .toEqual([{ id: 'chat-1' }, { id: 'file-explorer' }, { id: 'chat-2' }]);
  });

  it('appends when there is no active tab', () => {
    expect(insertSiblingTab([{ id: 'chat-1' }], null, tab => tab.id, { id: 'new-chat' }))
      .toEqual([{ id: 'chat-1' }, { id: 'new-chat' }]);
  });
});
