import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import Ajv2020 from 'ajv/dist/2020.js';

const root = resolve(import.meta.dirname, '..');
const definitions = [
  ['resource', 'schemas/phase5/resource-summary.schema.json'],
  ['residual', 'schemas/phase5/residual-processes.schema.json'],
  ['privacy', 'schemas/phase5/privacy-scan.schema.json']
];
const options = parseArguments(process.argv.slice(2));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validators = new Map();

for (const [name, schemaPath] of definitions) {
  const schema = JSON.parse((await readFile(resolve(root, schemaPath), 'utf8')).replace(/^\uFEFF/u, ''));
  validators.set(name, ajv.compile(schema));
}

let reportsValidated = 0;
for (const [name, reportPaths] of options.entries()) {
  const validate = validators.get(name);
  for (const reportPath of reportPaths) {
    const report = JSON.parse((await readFile(resolve(reportPath), 'utf8')).replace(/^\uFEFF/u, ''));
    if (!validate(report)) {
      throw new Error(`${name} report schema validation failed: ${ajv.errorsText(validate.errors)}`);
    }
    reportsValidated += 1;
  }
}

console.log(`[phase5-hardening-schema] PASS (3 schemas, ${reportsValidated} reports)`);

function parseArguments(args) {
  const values = new Map(definitions.map(([name]) => [name, []]));
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${option}`);
    const name = option.startsWith('--') ? option.slice(2) : '';
    if (!values.has(name)) throw new Error(`Unknown argument: ${option}`);
    values.get(name).push(value);
    index += 1;
  }
  return values;
}
