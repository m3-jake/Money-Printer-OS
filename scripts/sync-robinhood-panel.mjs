// Keep the editable paper panel and its inline desktop copy byte-for-byte synchronized.
// Matching and comparing happen on LF-normalized text: a CRLF working tree (git core.autocrlf=true on
// Windows) used to make the marker search fail, which reported a missing panel and — because test:all
// chains with && — silently skipped every target after test:robinhood (P1.4). The file keeps whichever
// EOL it already uses.
import fs from 'node:fs';
const htmlFile=new URL('../public/dashboard.html',import.meta.url);
const panelFile=new URL('../public/assets/robinhood-panel.js',import.meta.url);
const start='// BEGIN ROBINHOOD PAPER PANEL',end='// END ROBINHOOD PAPER PANEL';
const lf=s=>s.replace(/\r\n/g,'\n');
const raw=fs.readFileSync(htmlFile,'utf8'),eol=raw.includes('\r\n')?'\r\n':'\n';
const html=lf(raw),panel=lf(fs.readFileSync(panelFile,'utf8'));
const a=html.indexOf(start),b=html.indexOf(end);
if(a<0||b<a)throw Error('Robinhood panel boundaries not found');
const updated=html.slice(0,a+start.length)+'\n'+panel.trimEnd()+'\n'+html.slice(b);
if(process.argv.includes('--check')){if(html!==updated)throw Error('Run npm run sync:robinhood-panel to update the embedded paper panel');}
else if(html!==updated)fs.writeFileSync(htmlFile,eol==='\r\n'?updated.replace(/\n/g,'\r\n'):updated);
console.log('Robinhood panel synchronized.');
