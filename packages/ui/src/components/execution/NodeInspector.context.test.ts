import { describe, expect, it } from 'vitest';
import {
  groupContextRefs,
  isManifestOnlyRef,
  type ContextLifecycleAttemptSummary,
  type ContextLifecycleRefSummary,
} from './NodeInspector';

function attempt(refs: ContextLifecycleRefSummary[], injectedRefs: ContextLifecycleRefSummary[] = []): ContextLifecycleAttemptSummary {
  return {
    refs,
    contextInjection: { injectedRefs },
  } as ContextLifecycleAttemptSummary;
}

function ids(refs: ContextLifecycleRefSummary[]): Array<string | undefined> {
  return refs.map(ref => ref.refId);
}

describe('context ref visibility groups', () => {
  it('puts full-body injected refs only in Injected', () => {
    const ref: ContextLifecycleRefSummary = {
      refId: 'full',
      lifecycleStatus: 'injected',
      injectionMode: 'full',
      isInjected: true,
      providerMetadata: { injectionDecision: 'snippet' },
    };

    const groups = groupContextRefs(attempt([ref], [ref]));

    expect(ids(groups.injected)).toEqual(['full']);
    expect(groups.selected).toHaveLength(0);
    expect(groups.filtered).toHaveLength(0);
  });

  it('treats provider-native refs as injected runtime context', () => {
    const groups = groupContextRefs(attempt([
      {
        refId: 'native',
        lifecycleStatus: 'provider_native',
        injectionMode: 'provider_native',
        isInjected: true,
      },
    ]));

    expect(ids(groups.injected)).toEqual(['native']);
  });

  it('shows selected manifest-only refs in Selected', () => {
    const ref: ContextLifecycleRefSummary = {
      refId: 'manifest',
      lifecycleStatus: 'selected',
      injectionMode: 'manifest',
      providerMetadata: { injectionDecision: 'manifest_only', injectionPolicy: 'manifest_only' },
    };

    const groups = groupContextRefs(attempt([ref]));

    expect(ids(groups.selected)).toEqual(['manifest']);
    expect(isManifestOnlyRef(ref)).toBe(true);
  });

  it('keeps selected snippet candidates in Selected until actually injected', () => {
    const groups = groupContextRefs(attempt([
      {
        refId: 'snippet',
        lifecycleStatus: 'selected',
        providerMetadata: { injectionDecision: 'snippet' },
      },
    ]));

    expect(ids(groups.selected)).toEqual(['snippet']);
    expect(groups.injected).toHaveLength(0);
  });

  it('keeps previously injected chat repeats in Selected instead of Filtered', () => {
    const groups = groupContextRefs(attempt([
      {
        refId: 'previous',
        lifecycleStatus: 'skipped',
        injectionMode: 'skipped',
        filterReason: 'previously_injected',
        providerMetadata: { previouslyInjected: true, curatedInjectionPolicy: 'snippet' },
        timeline: [{ type: 'injected_manifest' }, { type: 'skipped', reason: 'previously_injected' }],
      },
    ]));

    expect(ids(groups.selected)).toEqual(['previous']);
    expect(groups.filtered).toHaveLength(0);
  });

  it('puts filtered, rejected, and skipped refs only in Filtered', () => {
    const groups = groupContextRefs(attempt([
      { refId: 'filtered', lifecycleStatus: 'filtered', isFiltered: true },
      { refId: 'rejected', lifecycleStatus: 'rejected' },
      { refId: 'skipped', lifecycleStatus: 'skipped', injectionMode: 'skipped' },
    ]));

    expect(ids(groups.filtered)).toEqual(['filtered', 'rejected', 'skipped']);
    expect(groups.selected).toHaveLength(0);
    expect(groups.injected).toHaveLength(0);
  });

  it('does not double-count refs when lifecycle signals overlap', () => {
    const groups = groupContextRefs(attempt([
      {
        refId: 'selected-then-injected',
        lifecycleStatus: 'selected',
        isInjected: true,
        timeline: [{ type: 'selected' }, { type: 'injected_full' }],
      },
      {
        refId: 'selected-then-filtered',
        lifecycleStatus: 'selected',
        isFiltered: true,
        timeline: [{ type: 'selected' }, { type: 'filtered' }],
      },
    ]));

    expect(ids(groups.injected)).toEqual(['selected-then-injected']);
    expect(ids(groups.filtered)).toEqual(['selected-then-filtered']);
    expect(groups.selected).toHaveLength(0);
  });
});
