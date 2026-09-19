import { cfg } from './config.js';
import { withTimeout } from './utils.js';

export async function alert(text){
  console.log(`ALERT: ${text}`);
  const jobs=[];
  if(cfg.telegramBotToken&&cfg.telegramChatId)jobs.push(withTimeout(fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:cfg.telegramChatId,text})}),5000,'Telegram alert'));
  if(cfg.alertWebhookUrl)jobs.push(withTimeout(fetch(cfg.alertWebhookUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,ts:Date.now()})}),5000,'Webhook alert'));
  await Promise.allSettled(jobs);
}
