import { readFileSync } from 'node:fs';
import { backupOffice, dryRun, type Scope, type Source } from './index.js';

// Operator-only offline entry point. No network, runtime construction or mode mutation.
try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'dry-run' && args.length === 5) {
    const [file, officeId, connectionId, companyId, projectId] = args;
    const scope: Scope = { officeId, connectionId, companyId, projectId };
    console.log(JSON.stringify(dryRun(JSON.parse(readFileSync(file, 'utf8')) as Source, scope), null, 2));
  } else if (command === 'backup' && args.length === 2) {
    backupOffice(args[0], args[1]);
    console.log('Backup complete. Keep private; verify before cutover.');
  } else {
    throw new Error('Usage: migration dry-run QUEUE OFFICE CONNECTION COMPANY PROJECT | backup STOPPED_OFFICE_DATA NEW_DESTINATION');
  }
} catch {
  // Never print JSON parse excerpts or filesystem/remote content from sensitive stores.
  console.error('Migration command refused. Check command arguments, source schema, stopped-office state and destination.');
  process.exitCode = 1;
}
