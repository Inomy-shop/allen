import { describe, expect, it } from 'vitest';
import { normalizeInputFieldDef } from '../canvas/InputSchemaEditor';
import {
  castWorkflowRunInput,
  defaultWorkflowRunInput,
  isRequiredWorkflowInput,
  resolveWorkflowInputWidget,
} from './WorkflowRunDialog';

describe('workflow input schema helpers', () => {
  it('normalizes number defaults and keeps unchecked required as false', () => {
    expect(normalizeInputFieldDef({
      type: 'number',
      default: '3',
      min: 1,
      max: 10,
      required: false,
    })).toEqual({
      type: 'number',
      default: 3,
      min: 1,
      max: 10,
      required: false,
      widget: 'number',
    });
  });

  it('turns enum fields into dropdown widgets', () => {
    expect(normalizeInputFieldDef({
      type: 'string',
      enum: ['low', 'medium', 'high'],
    })).toEqual({
      type: 'string',
      enum: ['low', 'medium', 'high'],
      widget: 'select',
    });
  });

  it('does not render an empty explicit select as an unusable dropdown', () => {
    expect(resolveWorkflowInputWidget('count', { type: 'string', widget: 'select' })).toBe('text');
  });

  it('keeps explicit built-in widgets for preview and run dialogs', () => {
    expect(resolveWorkflowInputWidget('project', { type: 'string', widget: 'repo_picker' })).toBe('repo_picker');
  });

  it('requires only fields explicitly marked required', () => {
    expect(isRequiredWorkflowInput({ type: 'string' })).toBe(false);
    expect(isRequiredWorkflowInput({ type: 'string', required: false })).toBe(false);
    expect(isRequiredWorkflowInput({ type: 'string', required: true })).toBe(true);
  });

  it('casts captured input values by schema type and omits blank optional values', () => {
    const schema = {
      user_question: { type: 'string', required: true },
      number_of_points: { type: 'number', enum: ['1', '2', '3'], default: 1 },
      include_sources: { type: 'boolean', default: false },
      optional_note: { type: 'string' },
    };

    expect(defaultWorkflowRunInput(schema)).toEqual({
      user_question: '',
      number_of_points: '1',
      include_sources: 'false',
      optional_note: '',
    });

    const result = castWorkflowRunInput(schema, {
      user_question: 'Explain this',
      number_of_points: '2',
      include_sources: 'true',
      optional_note: '',
    });

    expect(result).toEqual({
      input: {
        user_question: 'Explain this',
        number_of_points: 2,
        include_sources: true,
      },
    });
  });

  it('reports missing required and invalid number values', () => {
    expect(castWorkflowRunInput({ task: { type: 'string', required: true } }, { task: '' }).error)
      .toBe('task is required');
    expect(castWorkflowRunInput({ count: { type: 'number' } }, { count: 'abc' }).error)
      .toBe('count must be a number');
  });
});
