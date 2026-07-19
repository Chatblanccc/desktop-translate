import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output-root');
if (outputIndex < 0 || !args[outputIndex + 1] || args[outputIndex + 1].startsWith('--')) {
  throw new Error('--output-root is required.');
}
const root = resolve(import.meta.dirname, '..');
const schema = JSON.parse(await readFile(
  resolve(root, 'schemas/phase5/lane-a-product-summary.schema.json'),
  'utf8'
));
const summary = JSON.parse(await readFile(resolve(args[outputIndex + 1], 'summary.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(schema);
if (!validate(summary)) {
  console.error(`[phase5:lane-a:product:schema] ${ajv.errorsText(validate.errors)}`);
  process.exitCode = 1;
} else {
  console.log(`[phase5:lane-a:product:schema] PASS (${summary.status})`);
}
