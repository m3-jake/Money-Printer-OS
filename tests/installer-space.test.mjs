import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const script = fs.readFileSync(new URL('../scripts/update-local-install.ps1', import.meta.url), 'utf8');

test('installer picks a work drive with room for the verified backup before touching anything', () => {
  const preflight = script.indexOf('Get-BackupEstimate $store'), stop = script.indexOf("Stop-App 'Money Printer OS'"), build = script.indexOf("Run 'Building Money Printer OS'");
  assert.ok(preflight > 0 && preflight < build && build < stop, 'space preflight runs before building and stopping the apps');
  assert.match(script, /\$drive\.Free -ge \$needBytes \+ \$headroom/);
  assert.match(script, /MPO_UPDATE_ROOT/);
  assert.match(script, /'W:\\money-printer-backups'/);
  assert.match(script, /No drive has room[^\n]*Nothing was changed/);
  assert.match(script, /Install drive has only/);
});

test('sealed past-day evidence is stored once, hash-verified and listed in every manifest; nothing is deleted', () => {
  assert.match(script, /AddDays\(-1\)/);
  assert.match(script, /if \(\$sourceHash -ne \$storeHash\) \{ throw "Sealed evidence did not verify/);
  assert.match(script, /sealedStore=\$true/);
  assert.doesNotMatch(script, /Remove-Item[^\n]*(research-evidence|evidence-store|paper-data-backup)/);
});
