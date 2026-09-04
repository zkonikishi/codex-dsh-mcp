import { readJson } from './workflow-store.mjs';
import { submitReport } from './workflow.mjs';

const args = process.argv.slice(2);
try {
  if (args.length !== 4 || args[0] !== '--ticket' || args[2] !== '--report') throw Error('USAGE');
  const result = await submitReport(args[1], await readJson(args[3], 32768));
  process.stdout.write(JSON.stringify(result) + '\n');
} catch { process.stderr.write('REPORT_REJECTED: check ticket/report format locally; no secret was printed.\n'); process.exitCode = 1; }
