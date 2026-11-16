import fs from 'node:fs';
import crypto from 'node:crypto';
import wsPkg from '../node_modules/ws/index.js';

const env = {};
for (const l of fs.readFileSync(new URL('../.env', import.meta.url),'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }

const extra = process.argv[2] ? JSON.parse(process.argv[2]) : {};
const customParameters = Object.assign({ twilio: process.env.TWILIO_NUMBER || '+15551234567' }, extra);

const TARGET = process.env.TARGET || '127.0.0.1:8090';
const url = 'wss://' + TARGET;
const sig = crypto.createHmac('sha1', env.TWILIO_AUTH_TOKEN).update(Buffer.from(url, 'utf8')).digest('base64');
const ws = new wsPkg('ws://' + TARGET, { headers: { 'X-Twilio-Signature': sig, Host: TARGET } });

const clips = [process.env.RAW || '/tmp/talk.raw'];
if (process.env.RAW2) clips.push(process.env.RAW2);
if (process.env.RAW3) clips.push(process.env.RAW3);
const TAIL = Number(process.env.TAIL || 18000);
const GAP = Number(process.env.GAP || 9000);
const FRAME = 160;
let deltas = 0, bytes = 0, firstDeltaAt = 0;

ws.on('open', () => {
  ws.send(JSON.stringify({ event: 'connected' }));
  ws.send(JSON.stringify({ event: 'start', start: { streamSid: 'MZtask1', callSid: 'CAtask1', tracks: ['inbound'], customParameters, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } } }));

  let clipIdx = 0;
  const playNext = () => {
    if (clipIdx >= clips.length) { console.log('SIM all_clips_sent'); return; }
    const raw0 = fs.readFileSync(clips[clipIdx]);
    const SIL = Math.round((Number(process.env.SILENCE || 1200) / 1000) * 8000);
    const raw = Buffer.concat([raw0, Buffer.alloc(SIL, 0xFF)]);
    console.log('SIM playing ' + clips[clipIdx] + ' bytes=' + raw.length);
    clipIdx += 1;
    let sent = 0;
    const timer = setInterval(() => {
      if (sent * FRAME >= raw.length) {
        clearInterval(timer);
        setTimeout(playNext, GAP);
        return;
      }
      const chunk = raw.subarray(sent * FRAME, (sent + 1) * FRAME);
      sent += 1;
      ws.send(JSON.stringify({ event: 'media', streamSid: 'MZtask1', media: { payload: chunk.toString('base64') } }));
    }, 20);
  };
  setTimeout(playNext, 1200);
});

ws.on('message', (m) => {
  let j; try { j = JSON.parse(m.toString()); } catch { return; }
  if (j.event === 'media') {
    deltas += 1; bytes += Buffer.from(j.media.payload, 'base64').length;
    if (!firstDeltaAt) { firstDeltaAt = Date.now(); console.log('SIM first_audio_frame bytes=' + bytes); }
  }
  if (j.event === 'clear') console.log('SIM clear');
});

setTimeout(() => { console.log('SIM summary deltas=' + deltas + ' bytes=' + bytes); process.exit(0); }, TAIL);
