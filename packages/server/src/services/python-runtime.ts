export function resolveAllenPython(): string {
  const configured = firstNonEmpty(process.env.ALLEN_PYTHON, process.env.PYTHON);
  return configured ? expandHomePath(configured) : 'python3';
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}

function expandHomePath(value: string): string {
  const home = process.env.HOME;
  if (!home) return value;
  if (value === '~') return home;
  if (value.startsWith('~/')) return `${home}${value.slice(1)}`;
  return value
    .replace(/^\$HOME(?=\/|$)/, home)
    .replace(/^\$\{HOME\}(?=\/|$)/, home);
}
