#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { callCore, validateSurvey, protectResponse, aggregateResponses } from '../runtime/client.mjs';

const help = `MoonPrivacyKit — 本地隐私工具箱

node cli/main.mjs init-survey <新问卷.json>
node cli/main.mjs plan <方案.json> <新报告.json>
node cli/main.mjs protect <问卷.json> <新回答.json>
node cli/main.mjs aggregate <问卷.json> <新报告.json> <回答.json>...
node cli/main.mjs redact <csv|json> <原文件> <新文件> <规则.json>

protect 在终端逐题询问；管道输入时接收选项下标数组（从 0 开始）。
所有输出均拒绝覆盖已有文件。重复传送回答时复用已导出的回答文件。
examples/ 提供问卷、方案、脱敏规则与虚构数据。`;

function readText(path) {
  if (statSync(path).size > 4_000_000) throw new Error('Input file exceeds 4 MB.');
  return readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
}
function readJson(path) {
  try { return JSON.parse(readText(path)); }
  catch { throw new Error('Cannot read the JSON input. Check its format and file path.'); }
}
function requireNew(paths) {
  if (new Set(paths.map(p => resolve(p))).size !== paths.length || paths.some(existsSync)) {
    throw new Error('Output already exists or output paths overlap. Choose new output paths.');
  }
}
function writeNew(path, value) {
  writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['--help', '-h', 'help'].includes(command)) { console.log(help); return; }
  if (command === 'init-survey' && args.length === 1) {
    requireNew(args);
    const template = JSON.parse(readFileSync(new URL('../examples/survey.json', import.meta.url), 'utf8'));
    writeNew(args[0], validateSurvey(template));
  } else if (command === 'plan' && args.length === 2) {
    requireNew([args[1]]);
    writeNew(args[1], callCore({ ...readJson(args[0]), op: 'plan' }));
  } else if (command === 'protect' && args.length === 2) {
    requireNew([args[1]]);
    const survey = validateSurvey(readJson(args[0]));
    let answers;
    if (stdin.isTTY) {
      const terminal = createInterface({ input: stdin, output: stdout });
      answers = [];
      try {
        console.log('在本机处理回答。保护的是回答内容，传送文件仍可能暴露参与身份。');
        for (const q of survey.questions) {
          console.log(`\n${q.title}\n${q.options.map((v, i) => `${i + 1}. ${v}`).join('\n')}`);
          const answer = await terminal.question('选项序号：');
          if (!/^[1-9]\d*$/.test(answer)) throw new Error('Choose a valid option number.');
          answers.push(Number(answer) - 1);
        }
      } finally { terminal.close(); }
    } else {
      try {
        const input = readFileSync(0, 'utf8');
        if (input.length > 10000) throw new Error('Answer input is too long.');
        answers = JSON.parse(input);
      }
      catch { throw new Error('Standard input must contain a JSON array of option indices.'); }
    }
    const response = await protectResponse(survey, answers);
    writeNew(args[1], response);
  } else if (command === 'aggregate' && args.length >= 3) {
    requireNew([args[1]]);
    writeNew(args[1], await aggregateResponses(readJson(args[0]), args.slice(2).map(readJson)));
  } else if (command === 'redact' && args.length === 4) {
    const [format, input, output, policyPath] = args;
    const auditPath = `${output}.audit.json`;
    requireNew([output, auditPath]);
    const result = callCore({ op: 'redact', format, input: readText(input), policy: readJson(policyPath), spreadsheet_safe: true });
    writeNew(output, result.output);
    writeNew(auditPath, result.audit);
  } else { throw new Error('Invalid command arguments. Run with --help for usage.'); }
  console.log('完成，结果已写入指定的新文件。');
}

main().catch(error => {
  // Filesystem and JSON parser diagnostics can embed filenames or private input.
  const message = error.code || error instanceof SyntaxError ? 'File operation failed. Check paths and permissions.' : error.message;
  console.error(`未完成：${message}`);
  process.exitCode = 1;
});
