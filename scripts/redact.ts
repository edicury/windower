// redact: `redact <file...|--stdin> [--fix] [--allow-pii] [--json]` scans for secrets and PII.
// Prints file, line, rule and a masked preview, never the value. --fix rewrites files with ‹redacted›.
import {readFileSync, writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {EXIT} from './lib.js';
import {REDACTED, isEnvFile, redactText, scanText, summarize, type Finding} from './redaction.js';

export const REDACT_USAGE =
  'Usage: redact <file...|--stdin> [--fix] [--allow-pii] [--json]\n' +
  '  Scans for secrets and PII. Reports file, line, rule and a masked preview. Exit 2 on findings without --fix.\n' +
  '  --fix rewrites the files with ' +
  REDACTED +
  ' and prints the "Excluded / redacted" list for brief.md. .env* files are skipped, never read.';

export interface FileReport {
  file: string;
  skipped?: string;
  findings: Omit<Finding, 'start' | 'end'>[];
  fixed?: boolean;
}

const strip = (f: Finding) => ({
  rule: f.rule,
  label: f.label,
  line: f.line,
  col: f.col,
  preview: f.preview,
});

function main(): void {
  const {values, positionals} = parseArgs({
    options: {
      stdin: {type: 'boolean'},
      fix: {type: 'boolean'},
      'allow-pii': {type: 'boolean'},
      json: {type: 'boolean'},
    },
    allowPositionals: true,
  });
  if (!values.stdin && !positionals.length) {
    console.error(REDACT_USAGE);
    process.exit(EXIT.validation);
  }
  const opts = {allowPii: values['allow-pii']};
  const reports: FileReport[] = [];

  if (values.stdin) {
    const text = readFileSync(0, 'utf8');
    if (values.fix) {
      const r = redactText(text, opts);
      process.stdout.write(r.text);
      reports.push({file: '<stdin>', findings: r.findings.map(strip), fixed: true});
    } else reports.push({file: '<stdin>', findings: scanText(text, opts).map(strip)});
  }
  for (const file of positionals) {
    if (isEnvFile(file)) {
      reports.push({file, skipped: 'refused: .env* files are never read', findings: []});
      continue;
    }
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      reports.push({
        file,
        skipped: `unreadable: ${(e as NodeJS.ErrnoException).code}`,
        findings: [],
      });
      continue;
    }
    if (values.fix) {
      const r = redactText(text, opts);
      if (r.findings.length) writeFileSync(file, r.text);
      reports.push({file, findings: r.findings.map(strip), fixed: r.findings.length > 0});
    } else reports.push({file, findings: scanText(text, opts).map(strip)});
  }

  const all = reports.flatMap((r) => r.findings);
  const excluded = summarize(all);
  const human = values.stdin && values.fix ? console.error : console.log;
  if (values.json) {
    console.log(JSON.stringify({reports, excluded, clean: all.length === 0}, null, 2));
  } else {
    for (const r of reports) {
      if (r.skipped) human(`${r.file}: skipped (${r.skipped})`);
      for (const f of r.findings)
        human(`${r.file}:${f.line}:${f.col} ${f.rule} (${f.label}): ${f.preview}`);
    }
    if (!all.length)
      human(
        `clean: no secrets or PII found${reports.some((r) => r.skipped) ? ' in scanned files' : ''}`,
      );
    else if (values.fix) {
      human('\nExcluded / redacted (paste under that heading in brief.md):');
      for (const line of excluded) human(`- ${line}`);
    } else human(`\n${all.length} finding(s). Rerun with --fix to replace them with ${REDACTED}.`);
  }
  process.exit(all.length && !values.fix ? EXIT.validation : EXIT.ok);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
