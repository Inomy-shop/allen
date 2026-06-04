export interface RuntimeEnvInput {
  baseEnv?: NodeJS.ProcessEnv;
  includeBaseKeys?: string[];
  overrides?: Record<string, string | undefined>;
}

export function buildRuntimeChildEnv(input: RuntimeEnvInput = {}): NodeJS.ProcessEnv {
  const base = input.baseEnv ?? process.env;
  const env: NodeJS.ProcessEnv = {};

  if (input.includeBaseKeys) {
    for (const key of input.includeBaseKeys) {
      const value = base[key];
      if (value !== undefined) env[key] = value;
    }
  } else {
    Object.assign(env, base);
  }

  for (const [key, value] of Object.entries(input.overrides ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  return env;
}

