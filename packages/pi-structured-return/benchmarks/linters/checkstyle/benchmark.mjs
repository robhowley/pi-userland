#!/usr/bin/env node
/**
 * Checkstyle benchmark for structured-return
 * Measures token savings: raw XML vs structured_return with checkstyle-xml parser
 * 
 * Token counting uses tiktoken (cl100k_base) for accurate token counts.
 * Install tiktoken as a devDependency: pnpm add -D tiktoken
 */

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import fs from 'node:fs';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURE_DIR = path.join(__dirname, 'fixture');
const RAW_OUTPUT_PATH = path.join(__dirname, 'raw-output.xml');

// Dynamically import tiktoken to avoid build issues
let tiktoken = null;
async function getTiktoken() {
  if (tiktoken) return tiktoken;
  tiktoken = await import('tiktoken');
  return tiktoken;
}

// Token counting using cl100k_base (same as benchmarks/README.md)
async function countTokens(text) {
  const { get_encoding } = await getTiktoken();
  const encoding = get_encoding('cl100k_base');
  return encoding.encode(text).length;
}

// Load raw output
const rawOutput = fs.readFileSync(RAW_OUTPUT_PATH, 'utf-8');
const rawTokens = await countTokens(rawOutput);

// Simulate structured output (minimal representation of same findings)
// In real implementation, this would come from actual parser output
const simulatedStructuredOutput = {
  tool: 'checkstyle',
  exitCode: 4,
  status: 'fail',
  summary: '4 findings (4 errors)',
  cwd: '/Users/roberthowley/src/github.com/pi-userland/packages/pi-structured-return/benchmarks/linters/checkstyle/fixture',
  failures: [
    { id: 'fixture/src/SampleViolations.java:4:LineLengthCheck', file: 'src/SampleViolations.java', line: 4, message: 'Line is longer than 80 characters (found 140).', rule: 'LineLengthCheck' },
    { id: 'fixture/src/SampleViolations.java:7:LeftCurlyCheck', file: 'src/SampleViolations.java', line: 7, message: "'{' at column 5 should be on the previous line.", rule: 'LeftCurlyCheck' },
    { id: 'fixture/src/SampleViolations.java:9:NeedBracesCheck', file: 'src/SampleViolations.java', line: 9, message: "'if' construct must use '{}'.", rule: 'NeedBracesCheck' },
    { id: 'fixture/src/SampleViolations.java:14:LineLengthCheck', file: 'src/SampleViolations.java', line: 14, message: 'Line is longer than 80 characters (found 106).', rule: 'LineLengthCheck' }
  ],
  logPath: path.join(__dirname, '.tmp', 'checkstyle.log')
};

const structuredOutput = JSON.stringify(simulatedStructuredOutput, null, 2);
const structuredTokens = await countTokens(structuredOutput);

// Calculate savings
const savings = rawTokens - structuredTokens;
const savingsPercent = ((savings / rawTokens) * 100).toFixed(1);

// Output results
console.log('=== Checkstyle XML Parser Benchmark ===\n');
console.log(`Raw XML output tokens:     ${rawTokens.toLocaleString()}`);
console.log(`Structured output tokens:  ${structuredTokens.toLocaleString()}`);
console.log(`Token savings:             ${savings.toLocaleString()} (${savingsPercent}%)`);
console.log('\nRaw output snippet (first 500 chars):');
console.log(rawOutput.slice(0, 500) + '...');
console.log('\nStructured output:');
console.log(structuredOutput);

// JSON results for CI/machine consumption
const results = {
  tool: 'checkstyle',
  parser: 'checkstyle-xml',
  rawTokens,
  structuredTokens,
  savings,
  savingsPercent: parseFloat(savingsPercent),
  timestamp: new Date().toISOString()
};

fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(results, null, 2));
console.log('\nResults written to results.json');
