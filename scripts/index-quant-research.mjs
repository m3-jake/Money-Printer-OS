import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Read source documents as data. Never evaluate source blocks or follow embedded commands.
const [specs, vault] = process.argv.slice(2);
if (!specs || !vault) throw new Error('Usage: node scripts/index-quant-research.mjs <specs checkout> <vault checkout>');
const sha = text => createHash('sha256').update(text).digest('hex');
const families = {
  momentum: /momentum/i, trend: /trend|moving.average|donchian|breakout/i,
  'mean-reversion': /mean.reversion|reversal|\bIBS\b/i, grid: /\bgrid\b/i,
  'market-making': /market.making/i, options: /option|straddle|strangle|condor|butterfly|covered.call/i,
  arbitrage: /arbitrage|pairs.trading/i, volatility: /volatility|\bATR\b/i,
};
const sources = [], entries = [];
for (const [id, root, repo] of [['specs', specs, 'Quant-Trading-Strategies'], ['vault', vault, 'The-Quant-Trading-Vault']]) {
  const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const source = { id, repo, commit, url: `https://github.com/brainbrick-trades/${repo}`, licenseFiles: fs.readdirSync(root).filter(x => /^(license|copying)/i.test(x)) };
  sources.push(source);
  const dir = path.join(root, 'strategies');
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.md') || /^(README|INDEX|_shared-notation)\.md$/i.test(file)) continue;
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const field = name => text.match(new RegExp(`^${name}:\\s*"?([^\\r\\n]+)`, 'm'))?.[1]?.replace(/"$/, '') || null;
    const title = field('title') || file.replace(/\.md$/, '').replaceAll('-', ' ');
    const language = text.match(/> Source\s*\(([^)]+)\)/i)?.[1]?.trim().toLowerCase() || 'specification';
    const code = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(x => x[1]).join('\n');
    const flags = [];
    if (/lookahead\s*=\s*(?:barmerge\.)?lookahead_on|lookahead\s*:\s*true/i.test(code)) flags.push('lookahead-setting-review');
    if (/\brepaint|\bsecurity\s*\(|request\.security\s*\(/i.test(code)) flags.push('multi-timeframe-or-repainting-review');
    if (/martingale|pyramiding\s*[=:]\s*(?:[2-9]|\d{2,})/i.test(text)) flags.push('inventory-escalation-review');
    if (/exchange\.(Buy|Sell|SetDirection|SetContractType)|exchanges\[|_C\(exchange/i.test(code)) flags.push('fmz-runtime-dependency');
    entries.push({ id: `${id}:${file.slice(0, -3)}`, source: id, title, file: `strategies/${file}`, url: `${source.url}/blob/${commit}/strategies/${encodeURIComponent(file)}`, sha256: sha(text), codeSha256: code ? sha(code.replace(/\s+/g, ' ').trim()) : null, language, assetClass: field('asset_class'), families: Object.entries(families).filter(([, re]) => re.test(title)).map(([name]) => name), reviewFlags: flags, status: 'UNVALIDATED', executionAllowed: false });
  }
}
const counts = key => entries.reduce((out, row) => { out[row[key] || 'unspecified'] = (out[row[key] || 'unspecified'] || 0) + 1; return out; }, {});
const codeGroups = new Map();
for (const row of entries) if (row.codeSha256) codeGroups.set(row.codeSha256, [...(codeGroups.get(row.codeSha256) || []), row.id]);
const catalog = { schema: 'mpo.quant-research-catalog.v1', sources, summary: { total: entries.length, bySource: counts('source'), byLanguage: counts('language'), byAssetClass: counts('assetClass'), reviewFlags: Object.fromEntries([...new Set(entries.flatMap(x => x.reviewFlags))].map(flag => [flag, entries.filter(x => x.reviewFlags.includes(flag)).length])), duplicateCodeGroups: [...codeGroups.values()].filter(x => x.length > 1).length }, entries };
fs.writeFileSync('src/quant-catalog.json', JSON.stringify(catalog));
console.log(JSON.stringify(catalog.summary, null, 2));
