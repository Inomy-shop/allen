import { afterEach, describe, expect, it } from 'vitest';
import {
  configuredContextProvider,
  contextIndexGraphModeForProvider,
  contextProviderRuntimeConfig,
  cogneeMandatoryGraphMode,
  isCogneeContextEnabled,
  isContextEngineEnabled,
} from '../../../../src/services/context/config/context-provider-config.js';

const originalAllenContextProvider = process.env.ALLEN_CONTEXT_PROVIDER;
const originalCogneeMandatoryGraph = process.env.ALLEN_COGNEE_MANDATORY_GRAPH;

afterEach(() => {
  if (originalAllenContextProvider === undefined) delete process.env.ALLEN_CONTEXT_PROVIDER;
  else process.env.ALLEN_CONTEXT_PROVIDER = originalAllenContextProvider;
  if (originalCogneeMandatoryGraph === undefined) delete process.env.ALLEN_COGNEE_MANDATORY_GRAPH;
  else process.env.ALLEN_COGNEE_MANDATORY_GRAPH = originalCogneeMandatoryGraph;
});

describe('context-provider-config', () => {
  it('disables context engine flows when no provider is configured', () => {
    delete process.env.ALLEN_CONTEXT_PROVIDER;

    expect(configuredContextProvider()).toBeNull();
    expect(isContextEngineEnabled()).toBe(false);
    expect(contextProviderRuntimeConfig()).toEqual({
      enabled: false,
      provider: null,
      cogneeEnabled: false,
    });
    expect(contextIndexGraphModeForProvider()).toBeNull();
  });

  it('enables Cognee context flows from ALLEN_CONTEXT_PROVIDER', () => {
    process.env.ALLEN_CONTEXT_PROVIDER = 'cognee';

    expect(configuredContextProvider()).toBe('cognee');
    expect(contextIndexGraphModeForProvider()).toBe('mandatory_context_map');
    expect(isContextEngineEnabled()).toBe(true);
    expect(isCogneeContextEnabled()).toBe(true);
  });

  it('enables Allen built-in context flows from ALLEN_CONTEXT_PROVIDER', () => {
    process.env.ALLEN_CONTEXT_PROVIDER = 'allen';

    expect(configuredContextProvider()).toBe('allen');
    expect(contextIndexGraphModeForProvider()).toBe('full_graph');
    expect(isContextEngineEnabled()).toBe(true);
    expect(isCogneeContextEnabled()).toBe(false);
    expect(contextProviderRuntimeConfig()).toEqual({
      enabled: true,
      provider: 'allen',
      cogneeEnabled: false,
    });
  });

  it('normalizes the legacy graph provider value to allen', () => {
    process.env.ALLEN_CONTEXT_PROVIDER = 'graph';

    expect(configuredContextProvider()).toBe('allen');
    expect(contextProviderRuntimeConfig().provider).toBe('allen');
  });

  it('treats disabled provider values as off', () => {
    process.env.ALLEN_CONTEXT_PROVIDER = 'disabled';

    expect(configuredContextProvider()).toBeNull();
    expect(isContextEngineEnabled()).toBe(false);
  });

  it('defaults Cognee mandatory graph mode to auto and normalizes off aliases', () => {
    delete process.env.ALLEN_COGNEE_MANDATORY_GRAPH;
    expect(cogneeMandatoryGraphMode()).toBe('auto');

    process.env.ALLEN_COGNEE_MANDATORY_GRAPH = 'required';
    expect(cogneeMandatoryGraphMode()).toBe('required');

    process.env.ALLEN_COGNEE_MANDATORY_GRAPH = 'disabled';
    expect(cogneeMandatoryGraphMode()).toBe('off');
  });
});
