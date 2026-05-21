import type { BuiltInFunction } from '../types.js';

/**
 * Bridge for human-in-the-loop — this built-in is primarily used
 * when a code node needs to prompt the user.
 * For full HITL, use type: human nodes instead.
 */
export const promptUser: BuiltInFunction = async (_config, state, ctx) => {
  const prompt = (state.prompt_message as string) ?? 'Please provide input';

  ctx.emitter.emit({
    event: 'input_required',
    data: { node: '__prompt_user', prompt, fields: [] },
  });

  // In CLI mode this would block; in server mode the engine handles it.
  // Return a marker that the engine recognizes.
  return { __waiting_for_input: true };
};
