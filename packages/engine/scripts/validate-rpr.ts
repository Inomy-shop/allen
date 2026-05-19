import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { validateWorkflow, loadAgents, getBuiltIns } from '@allen/engine';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflowPath = join(__dirname, '..', 'workflows', 'resolve-pr-reviews.yml');

const doc = yaml.load(readFileSync(workflowPath, 'utf-8')) as any;
const agents = loadAgents();
const builtInNames = Object.keys(getBuiltIns());
const result = validateWorkflow(doc, agents, builtInNames, ['resolve-pr-reviews']);
console.log(JSON.stringify(result, null, 2));
