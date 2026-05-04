import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { validateWorkflow, loadAgents, getBuiltIns } from '@allen/engine';
const doc = yaml.load(readFileSync('/Users/shreemantkumar/flowforge/packages/engine/workflows/resolve-pr-reviews.yml', 'utf-8')) as any;
const agents = loadAgents();
const builtInNames = Object.keys(getBuiltIns());
const result = validateWorkflow(doc, agents, builtInNames, ['resolve-pr-reviews']);
console.log(JSON.stringify(result, null, 2));
