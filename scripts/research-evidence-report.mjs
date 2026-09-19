#!/usr/bin/env node
import fs from 'node:fs';
import { evaluateResearchEvidence } from '../src/researchEvidenceGate.js';
const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/research-evidence-report.mjs <evidence.json>'); process.exitCode=2; }
else { try { console.log(JSON.stringify(evaluateResearchEvidence(JSON.parse(fs.readFileSync(file,'utf8'))),null,2)); }
catch (error) { console.error('Cannot evaluate evidence: '+error.message); process.exitCode=2; } }
