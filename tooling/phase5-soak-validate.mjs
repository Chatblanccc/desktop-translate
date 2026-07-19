import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import Ajv2020 from 'ajv/dist/2020.js';

const root = resolve(import.meta.dirname, '..');
const outputRoot = resolve(valueAfter('--output-root') ?? 'artifacts/phase5/local/lane-a');
const eventSchema = JSON.parse(
  await readFile(resolve(root, 'schemas/phase5/soak-event.schema.json'), 'utf8')
);
const summarySchema = JSON.parse(
  await readFile(resolve(root, 'schemas/phase5/soak-summary.schema.json'), 'utf8')
);
const eventsText = await readFile(resolve(outputRoot, 'events.jsonl'), 'utf8');
const summary = JSON.parse(await readFile(resolve(outputRoot, 'summary.json'), 'utf8'));

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateEvent = ajv.compile(eventSchema);
const validateSummary = ajv.compile(summarySchema);
const failures = [];

const lines = eventsText.split(/\r?\n/u).filter((line) => line.trim() !== '');
for (let index = 0; index < lines.length; index += 1) {
  let event;
  try {
    event = JSON.parse(lines[index]);
  } catch {
    failures.push(`event ${index + 1}: invalid JSON`);
    continue;
  }
  if (!validateEvent(event)) failures.push(`event ${index + 1}: ${ajv.errorsText(validateEvent.errors)}`);
}
if (!validateSummary(summary)) failures.push(`summary: ${ajv.errorsText(validateSummary.errors)}`);

if (lines.length < 2) failures.push('events: run-start and run-end are required');
if (failures.length > 0) {
  for (const failure of failures) console.error(`[phase5-soak-schema] ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`[phase5-soak-schema] PASS (${lines.length} events)`);
}

function valueAfter(name) {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
}
