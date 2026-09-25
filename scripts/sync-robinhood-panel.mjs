// Keep the editable paper panel and its inline desktop copy byte-for-byte synchronized.
import fs from 'node:fs';
const htmlFile=new URL('../public/dashboard.html',import.meta.url);
const panelFile=new URL('../public/assets/robinhood-panel.js',import.meta.url);
const start='// BEGIN ROBINHOOD PAPER PANEL\n',end='// END ROBINHOOD PAPER PANEL';
const html=fs.readFileSync(htmlFile,'utf8'),panel=fs.readFileSync(panelFile,'utf8');
const a=html.indexOf(start),b=html.indexOf(end);
if(a<0||b<a)throw Error('Robinhood panel boundaries not found');
const updated=html.slice(0,a+start.length)+panel.trimEnd()+'\n'+html.slice(b);
if(process.argv.includes('--check')){if(html!==updated)throw Error('Run npm run sync:robinhood-panel to update the embedded paper panel');}
else if(html!==updated)fs.writeFileSync(htmlFile,updated);
console.log('Robinhood panel synchronized.');
