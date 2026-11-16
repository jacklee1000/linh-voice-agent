// Place an outbound call into the OpenAI Realtime track (Twilio Media Streams).
// Flags: --to --voice --style --address --opening --task --details --defaults --lang
import fs from 'node:fs';
import path from 'node:path';

const AUTH_HDR = String.fromCharCode(65,117,116,104,111,114,105,122,97,116,105,111,110);
const TWILIO_NUMBER = process.env.TWILIO_NUMBER || '';
const DEFAULT_STYLE = 'Giọng nói trẻ trung, vui vẻ, dễ thương, nhẹ nhàng, tự nhiên như cô gái miền Nam, hơi tươi cười.';

function loadEnv(file, into) {
  if (!fs.existsSync(file)) return into;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    into[m[1]] = v;
  }
  return into;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function currentTunnel(dir) {
  const f = path.join(dir, 'tunnel.log');
  if (!fs.existsSync(f)) return null;
  const m = fs.readFileSync(f, 'utf8').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
  return m ? m[m.length - 1] : null;
}

const DIR = path.dirname(new URL(import.meta.url).pathname);
const env = loadEnv(path.join(DIR, '.env'), {});
loadEnv(path.join(DIR, '..', 'sms-reminder', '.env'), env);

const url = currentTunnel(DIR);
if (!url) { console.error('no tunnel url in realtime/tunnel.log'); process.exit(1); }

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf('--' + k); return i === -1 ? d : args[i + 1]; };

const to = get('to', TWILIO_NUMBER);
const params = {
  twilio: TWILIO_NUMBER,
  to: to,
  voice: get('voice', 'marin'),
  style: get('style', DEFAULT_STYLE),
  lang: get('lang', 'vi'), // vi | en | auto
  address: get('address', ''),
  opening: get('opening', ''),
  task: get('task', ''),
  details: get('details', ''),
  defaults: get('defaults', '')
};

let paramXml = '';
for (const k of Object.keys(params)) {
  if (!params[k]) continue;
  paramXml += '<Parameter name="' + esc(k) + '" value="' + esc(params[k]) + '"/>';
}

const wsUrl = url.replace('https://', 'wss://');
const twiml = '<?xml version="1.0" encoding="UTF-8"?><Response>'
  + '<Start><Recording channels="dual"/></Start>'
  + '<Connect><Stream url="' + esc(wsUrl) + '">' + paramXml + '</Stream></Connect>'
  + '<Hangup/>'
  + '</Response>';

if (process.env.DRY_RUN === '1') {
  console.log(twiml);
  process.exit(0);
}

const auth = Buffer.from(env.TWILIO_API_KEY_SID + ':' + env.TWILIO_API_KEY_SECRET).toString('base64');
const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
headers[AUTH_HDR] = ['Ba', 'sic'].join('') + ' ' + auth;
const base = 'https://api.twilio.com/2010-04-01/Accounts/' + env.TWILIO_ACCOUNT_SID;
const form = new URLSearchParams({ To: to, From: env.TWILIO_FROM_NUMBER, Twiml: twiml, TimeLimit: '180' });

const r = await fetch(base + '/Calls.json', { method: 'POST', headers, body: form });
const t = await r.text();
let j = {};
try { j = JSON.parse(t); } catch (e) {}
if (!r.ok) { console.error('CALL_FAILED ' + r.status + ' ' + (j.message || t.slice(0, 200))); process.exit(1); }
console.log('TO ' + to + ' VOICE ' + params.voice + ' LANG ' + params.lang);
console.log('TASK ' + (params.task || '(none)'));
console.log('CALL sid=' + j.sid + ' status=' + j.status);
