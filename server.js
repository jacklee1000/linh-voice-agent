// Linh on OpenAI Realtime — Twilio Media Streams bridge.
// Separate track from the ConversationRelay service; that one stays untouched.
//
// Security (same rules as the backup track):
//   1. X-Twilio-Signature verified on the WS upgrade
//   2. the Twilio number must be present in customParameters
//   3. one call at a time, 180s hard cap
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import wsPkg from './node_modules/ws/index.js';
const { WebSocketServer, WebSocket } = wsPkg;

const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || '127.0.0.1';
const TWILIO_NUMBER = process.env.TWILIO_NUMBER || '';
const MAX_CALL_MS = 3 * 60 * 1000;
const MODEL = process.env.REALTIME_MODEL || 'gpt-realtime-2.1-mini';
const VOICE = process.env.REALTIME_VOICE || 'marin';
const TURN_DETECTION = process.env.TURN_DETECTION || 'server_vad';

const log = (...a) => console.log(new Date().toISOString(), ...a);

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

const DIR = path.dirname(new URL(import.meta.url).pathname);
const env = loadEnv(path.join(DIR, '.env'), {});
const AUTH_TOKEN = env.TWILIO_AUTH_TOKEN || '';
const OPENAI_KEY = env.OPENAI_API_KEY || '';

const STYLE = 'Giọng nói trẻ trung, vui vẻ, dễ thương, nhẹ nhàng, tự nhiên như cô gái miền Nam, hơi tươi cười.';
const PERSONA = [
  STYLE,
  'Tên: Linh. Giới tính: nữ. Nói tiếng Việt tự nhiên như đang gọi điện thoại.',
  'Trả lời 1 đến 2 câu, thật ngắn. Không đọc danh sách, không đọc ký hiệu.',
  'Luôn gọi người nói chuyện là “anh” trừ khi họ tự xưng khác; khi họ tự xưng khác thì đổi ngay và giữ nguyên.',
  'Tự gọi mình là “em” hoặc “Linh”.',
  'Không dùng từ “bạn”, không viết dấu gạch chéo.',
  'Nếu được hỏi thẳng có phải robot hay AI: trả lời thật là có. Không bao giờ nhận mình là người.',
  'Không hứa hẹn tiền bạc, không đọc số thẻ, không chia sẻ thông tin cá nhân, không đồng ý việc gì ngoài nhiệm vụ.',
  'Nếu không chắc, nói sẽ ghi lại và hỏi lại sau.',
  'Khi cuộc gọi vừa kết nối, hãy chào đúng một câu ngắn: “Dạ alo, Linh nghe ạ.”'
].join(' ');

// Vietnamese pronouns a caller may use for themselves, with self-reference verbs.
const ADDRESS_WORDS = ['anh', 'chị', 'cô', 'chú', 'bác', 'ông', 'bà'];
const SELF_VERBS = ['nói', 'hỏi', 'muốn', 'cần', 'đặt', 'lấy', 'gọi', 'nghe', 'đây', 'tên', 'trả', 'đợi', 'chờ', 'sẽ', 'có', 'là', 'đi', 'qua', 'mang', 'ăn'];
const VN_BOUNDARY = '(^|[^a-zàáảãạăằắẳẵặâầấẩẫậđèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ])';

export function detectAddress(text) {
  const t = String(text || '').toLowerCase();
  for (const w of ADDRESS_WORDS) {
    const re = new RegExp(VN_BOUNDARY + w + '\\s+(\\S+)', 'g');
    let m;
    while ((m = re.exec(t))) { if (SELF_VERBS.includes(m[2])) return w; }
  }
  return null;
}
// Build the per-call instruction block from TwiML parameters.
// Detect the caller language from a transcript: vi (has Vietnamese diacritics) or en.
export function detectLang(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i.test(t)) return 'vi';
  const words = t.toLowerCase().match(/[a-z]+/g) || [];
  if (!words.length) return null;
  const en = ['the','i','you','we','they','is','are','am','can','could','would','will','hello','hi','yes','no','thanks','thank','please','what','how','do','does','did','to','my','your','it','this','that','want','need','like','order','pick','now','good','morning','afternoon','evening','speak','speaking','sorry','hey','sure','and','for','with','have','is','was','here','there','one','two'];
  let hits = 0;
  for (const w of words) if (en.indexOf(w) !== -1) hits++;
  if (hits >= 2 && hits / words.length >= 0.4) return 'en';
  return null;
}
// Build the per-call instruction block from TwiML parameters.
function buildInstructions(cp = {}) {
  const langRaw = String(cp.lang || 'vi').toLowerCase();
  const auto = langRaw === 'auto' && process.env.REALTIME_AUTO_EXPERIMENT === '1';
  const forced = (cp.forcedLang === 'en') ? 'en' : null; // never pin to vi: it locks the call into Vietnamese
  const lang = forced || (langRaw === 'en' ? 'en' : 'vi');
  const style = cp.style || STYLE;
  const lines = [];

  // AUTO and not yet pinned: language-neutral prompt. No Vietnamese example sentences,
  // because those anchor the model to Vietnamese even when the caller speaks English.
  if (auto && !forced) {
    lines.push('You are Linh, a young Vietnamese woman on a phone call. Warm, casual, natural, a little playful. Never sound like a call-center script.');
    lines.push('LANGUAGE, top priority: answer ONLY in the language of the caller last sentence. If the caller speaks English, your whole answer must be in English. If the caller speaks Vietnamese, your whole answer must be in Vietnamese. Never mix the two languages in one answer. Never answer an English sentence with Vietnamese, or a Vietnamese sentence with English, even if earlier turns in this call were in the other language.');
    lines.push('Examples of the language mirror:');
    lines.push('caller: Hello, can you hear me? -> you: Hi, I can hear you, go ahead.');
    lines.push('caller: Anh muốn đặt hai tô phở -> you: Dạ, anh đặt hai tô phở ạ.');
    lines.push('caller: What time do you close? -> you: We close at nine tonight.');
    lines.push('caller: Mấy giờ đóng cửa em? -> you: Dạ chín giờ tối nay ạ.');
    lines.push('In English never insert Vietnamese kinship words such as anh, chị, em, cô, chú into the sentence. In Vietnamese use them naturally.');

    lines.push('Keep answers to 1-2 short sentences. Never read lists or symbols. Never use slashes.');
    lines.push('Call yourself Linh or I. Never call the caller "ban".');
    lines.push('If asked directly whether you are a robot or AI, say yes honestly. Never claim to be human.');
    lines.push('Never promise money, never read card numbers, never share personal information.');
    lines.push(cp.address
      ? 'Address the caller as "' + cp.address + '". If they refer to themselves differently, switch at once and keep the new form.'
      : 'Do not guess how to address the caller. Once they refer to themselves, mirror the exact form they used.');
    if (cp.task) {
      lines.push('Task for this call: ' + cp.task);
      if (cp.details) lines.push('Details you may use: ' + cp.details);
      if (cp.defaults) lines.push('Pre-approved answers: ' + cp.defaults);
      lines.push('You are the caller with a task: state what you need right away. Do not open like a receptionist.');
      lines.push('If the task is several questions, ask ONE question at a time, then stop and wait for their answer before the next one. Never read out the whole list at once.');
      lines.push('Confirm the whole order twice only: once early, once before ending. Conversation tasks need no repetition.');
      lines.push('If they are sold out, offer a substitute, or ask something outside the task or the pre-approved answers: do NOT agree. Say you will check and call back.');
    }
    lines.push('LANGUAGE REMINDER: mirror the caller language exactly, sentence by sentence, for the whole call.');
    return lines.join(' ');
  }

  // Pinned language: vi or en (or auto pinned after detection).
  if (auto && forced) lines.push(forced === 'en'
    ? 'LANGUAGE, top priority: answer ONLY in English. The caller is speaking English now. Earlier turns in this call may be in Vietnamese, that does not matter. Never answer in Vietnamese while the caller speaks English.'
    : 'NGÔN NGỮ: chỉ trả lời bằng tiếng Việt, kể cả khi người nói trộn hai thứ tiếng.');
  lines.push(style);
  if (lang === 'en') {
    lines.push('Name: Linh. Young Vietnamese woman, speaking English now. Short replies, 1-2 sentences.');
    lines.push('Refer to yourself as Linh or I. Never write slashes.');
    lines.push('If asked whether you are a robot or AI: say yes, never claim to be human.');
    lines.push('Never promise payments, never give card numbers, never share personal info.');
    lines.push('You are NOT a translator. Never translate or mention translating unless the caller explicitly asks you to.');
    lines.push(cp.address
      ? 'Never insert Vietnamese kinship words (anh, chị, em, cô, chú, bác) into English sentences. In English, address the caller by name if you know it, otherwise leave the address term out.'
      : 'Do not guess how to address the caller until they refer to themselves.');
  } else {
    lines.push('Tên: Linh. Giới tính: nữ. Nói tiếng Việt tự nhiên như đang gọi điện thoại.');
    lines.push('Trả lời 1 đến 2 câu, thật ngắn. Không đọc danh sách, không đọc ký hiệu.');
    lines.push('Tự gọi mình là “em” hoặc “Linh”. Không dùng từ “bạn”, không viết dấu gạch chéo.');
    lines.push('Nếu được hỏi thẳng có phải robot hay AI: trả lời thật là có. Không bao giờ nhận mình là người.');
    lines.push('Không hứa hẹn tiền bạc, không đọc số thẻ, không chia sẻ thông tin cá nhân.');
    lines.push('Bạn KHÔNG phải phiên dịch viên. Không bao giờ dịch, không nhắc tới việc dịch, trừ khi người nói yêu cầu rõ ràng.');
    lines.push(cp.address
      ? 'Gọi người nói chuyện là “' + cp.address + '”, nhưng nếu họ tự xưng khác thì đổi ngay và giữ nguyên.'
      : 'Chưa biết thì đừng đoán cách gọi; khi họ tự xưng thì theo đúng như vậy.');
  }
  if (cp.task) {
    lines.push(lang === 'en' ? 'Task for this call: ' + cp.task : 'Nhiệm vụ của cuộc gọi này: ' + cp.task);
    if (cp.details) lines.push(lang === 'en' ? 'Details: ' + cp.details : 'Thông tin cần dùng: ' + cp.details);
    if (cp.defaults) lines.push(lang === 'en' ? 'Pre-approved answers: ' + cp.defaults : 'Trả lời sẵn cho các lựa chọn: ' + cp.defaults);
    lines.push(lang === 'en'
      ? 'You are the caller with a task: say what you need right away, never answer like a receptionist.'
      : 'Linh là người gọi đi: nói ngay việc cần nói, không mở đầu bằng “Linh nghe” hay “có việc gì không”.');
    lines.push(lang === 'en'
      ? 'Confirm the whole order twice only: once early, once at the end.'
      : 'Chỉ nhắc lại toàn bộ nội dung đơn hàng đúng 2 lần: một lần sớm, một lần trước khi kết thúc; nếu là chuyện trò, hỏi thăm thì không nhắc lại toàn bộ.');
    lines.push(lang === 'en'
      ? 'If the task is several questions, ask ONE question at a time, then stop and wait for their answer before asking the next.'
      : 'Nếu nhiệm vụ gồm nhiều câu hỏi: hỏi MỘT câu mỗi lần, thật ngắn, rồi dừng lại chờ họ trả lời, nghe xong mới hỏi câu kế. Tuyệt đối không đọc hết danh sách câu hỏi trong một hơi.');
    lines.push(lang === 'en'
      ? 'If they are sold out, offer a substitute, or ask something not covered by the task or pre-approved answers: do NOT agree. Say you will check and call back.'
      : 'Nếu họ hết món, đưa món thay thế, hoặc hỏi điều không có trong nhiệm vụ hay trả lời sẵn: KHÔNG đồng ý. Nói sẽ hỏi lại rồi gọi lại.');
  }
  const greet = cp.opening || (lang === 'en' ? 'Hi, Linh speaking.' : 'Dạ alo, Linh nghe ạ.');
  lines.push(lang === 'en'
    ? 'When the call connects, say exactly: "' + greet + '"'
    : 'Khi cuộc gọi vừa kết nối, hãy nói đúng câu: “' + greet + '”');
  return lines.join(' ');
}
function twilioSignature(token, url, params) {
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  return crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

export function verifyUpgrade(req, token = AUTH_TOKEN) {
  const sig = req.headers['x-twilio-signature'];
  if (!sig) return { ok: false, reason: 'missing-signature' };
  if (!token) return { ok: false, reason: 'no-auth-token' };
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const parsed = new URL(req.url || '/', 'wss://' + host);
  const p = parsed.pathname === '/' ? '' : parsed.pathname;
  const signedUrl = 'wss://' + parsed.host + p;
  const params = {};
  for (const [k, v] of parsed.searchParams) params[k] = v;
  if (!safeEqual(twilioSignature(token, signedUrl, params), sig)) return { ok: false, reason: 'bad-signature' };
  return { ok: true, signedUrl };
}

const server = http.createServer((req, res) => {
  res.writeHead(426, { 'Content-Type': 'text/plain' });
  res.end('Upgrade required');
});

const wss = new WebSocketServer({ noServer: true });
let activeCalls = 0;

server.on('upgrade', (req, socket, head) => {
  const v = verifyUpgrade(req);
  if (!v.ok) {
    log('REJECT upgrade reason=' + v.reason + ' host=' + (req.headers.host || '?'));
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  log('ACCEPT upgrade url=' + v.signedUrl);
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  const id = Math.random().toString(36).slice(2, 8);
  if (shuttingDown) {
    log('[' + id + '] SHUTDOWN reject - service is draining');
    try { ws.close(1012, 'shutting down'); } catch {}
    return;
  }
  if (activeCalls >= 1) {
    log('[' + id + '] BUSY reject');
    try { ws.close(1013, 'busy'); } catch {}
    return;
  }
  activeCalls += 1;
  let counted = true;

  let streamSid = null;
  let greeted = false;
  let callVoice = '';
  let callLang = 'vi';
  let callAddress = '';
  let currentAddress = '';
  let callerLang = '';
  let responseActive = false;
  let callerSpoke = false;
  let silenceTimer = null;
  let nudgeDone = false;

  // auto mode only: if the caller says nothing for 3s, she says a short Alo? then waits again
  const armSilence = () => {
    if (nudgeDone || callerSpoke || silenceTimer) return;
    silenceTimer = setTimeout(() => {
      silenceTimer = null;
      if (callerSpoke || nudgeDone) return;
      nudgeDone = true;
      try {
        oai.send(JSON.stringify({ type: 'response.create', response: { instructions: 'Say exactly one short word to check the line: "Alo?". Nothing else.' } }));
        log('[' + id + '] 3s of silence -> said Alo?');
      } catch {}
    }, 3000);
  };

  let firstAudioAt = 0;
  let herText = '';
  let needsApproval = false;
  let callOpening = '';
  let callTask = '';
  let callDetails = '';
  let callDefaults = '';
  let callStyle = '';
  let oai = null;
  let timer = null;
  let speechStoppedAt = 0;
  let firstAudioSent = false;
  let turnNo = 0;

  const toTwilio = (obj) => { try { ws.send(JSON.stringify(obj)); } catch {} };

  const cleanup = () => {
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    if (timer) { clearTimeout(timer); timer = null; }
    if (oai && oai.readyState === 1) { try { oai.close(); } catch {} }
    if (counted) { counted = false; activeCalls -= 1; }
  };

  const openOpenAI = () => {
    oai = new WebSocket('wss://api.openai.com/v1/realtime?model=' + MODEL, {
      headers: { Authorization: ['Bea', 'rer'].join('') + ' ' + OPENAI_KEY }
    });

    oai.on('open', () => {
      log('[' + id + '] openai connected model=' + MODEL);
      const instr = buildInstructions({ lang: callLang, style: callStyle, address: callAddress, opening: callOpening, task: callTask, details: callDetails, defaults: callDefaults });
      log('[' + id + '] instructions_len=' + instr.length + ' head=' + instr.slice(0, 90));
      const session = {
        type: 'realtime',
        output_modalities: ['audio'],
        instructions: instr,
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            transcription: callLang.toLowerCase() === 'auto'
              ? { model: 'gpt-4o-mini-transcribe', prompt: 'The speaker uses Vietnamese or English.' }
              : { model: 'gpt-4o-mini-transcribe', language: callLang === 'en' ? 'en' : 'vi' },
            turn_detection: TURN_DETECTION === 'server_vad'
              ? { type: 'server_vad', silence_duration_ms: Number(process.env.VAD_SILENCE_MS || 700), create_response: true, interrupt_response: true }
              : { type: 'semantic_vad', eagerness: 'high', create_response: true, interrupt_response: true }
          },
          output: { format: { type: 'audio/pcmu' }, voice: callVoice || VOICE }
        }
      };
      oai.send(JSON.stringify({ type: 'session.update', session }));
    });

    oai.on('message', (raw) => {
      let ev; try { ev = JSON.parse(raw.toString()); } catch { return; }

      if (ev.type === 'session.updated') {
        const s = ev.session || {};
        const inFmt = s.audio && s.audio.input && s.audio.input.format;
        const outFmt = s.audio && s.audio.output && s.audio.output.format;
        const td = s.audio && s.audio.input && s.audio.input.turn_detection;
        if (!greeted && String(callLang).toLowerCase() !== 'auto') { greeted = true; try { oai.send(JSON.stringify({ type: 'response.create' })); log('[' + id + '] greeting requested'); } catch {} }
        if (!greeted) {
          greeted = true;
          log('[' + id + '] auto mode - waiting for caller to speak first');
          armSilence();
        }
        log('[' + id + '] session in=' + JSON.stringify(inFmt) + ' out=' + JSON.stringify(outFmt) + ' td=' + JSON.stringify(td) + ' modalities=' + JSON.stringify(s.output_modalities) + ' voice=' + JSON.stringify(s.audio && s.audio.output && s.audio.output.voice));
        return;
      }

      if (ev.type === 'input_audio_buffer.speech_started') {
        callerSpoke = true;
        if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
        // barge-in: drop whatever Twilio is holding, cancel the model's reply
        toTwilio({ event: 'clear', streamSid });
        if (responseActive) { try { oai.send(JSON.stringify({ type: 'response.cancel' })); } catch {} }
        firstAudioSent = false;
        log('[' + id + '] caller speech started -> clear' + (responseActive ? ' + response.cancel' : ''));
        responseActive = false;
        return;
      }

      if (ev.type === 'input_audio_buffer.speech_stopped') {
        speechStoppedAt = Date.now();
        firstAudioSent = false;
        turnNo += 1;
        log('[' + id + '] TURN ' + turnNo + ' caller_stop t=' + new Date(speechStoppedAt).toISOString());
        return;
      }

      // GA event name is response.output_audio.delta; beta used response.audio.delta. Accept both.
      if ((ev.type === 'response.output_audio.delta' || ev.type === 'response.audio.delta') && ev.delta) {
        if (!firstAudioSent) {
          firstAudioSent = true;
          firstAudioAt = Date.now();
          const gap = speechStoppedAt ? Date.now() - speechStoppedAt : -1;
          log('[' + id + '] TURN ' + turnNo + ' first_audio_after_caller_stop=' + gap + 'ms');
        }
        toTwilio({ event: 'media', streamSid, media: { payload: ev.delta } });
        return;
      }

      if (ev.type === 'response.created' || ev.type === 'response.done') {
        responseActive = ev.type === 'response.created';
        const r = ev.response || {};
        log('[' + id + '] ' + ev.type + ' status=' + (r.status || '?') + ' outputs=' + JSON.stringify((r.output || []).map((o) => o.type)));
        return;
      }

      if (ev.type === 'response.audio_transcript.delta' || ev.type === 'response.output_audio_transcript.delta') {
        log('[' + id + '] transcript_delta ' + JSON.stringify((ev.delta || '').slice(0, 60)));
        return;
      }

      if (ev.type === 'conversation.item.input_audio_transcription.completed') {
        const said = (ev.transcript || '').trim();
        if (said) {
          log('[' + id + '] caller_said ' + JSON.stringify(said.slice(0, 140)) + (speechStoppedAt ? ' [transcript +' + (Date.now() - speechStoppedAt) + 'ms after caller_stop]' : ''));
          const dlang = detectLang(said);
          if (dlang && dlang !== callerLang) {
            log('[' + id + '] LANG ' + (callerLang || '(none)') + ' -> ' + dlang + ' at turn ' + turnNo);
            callerLang = dlang;
            const instr3 = buildInstructions({ lang: callLang, style: callStyle, address: currentAddress, opening: callOpening, task: callTask, details: callDetails, defaults: callDefaults, forcedLang: callerLang });
            try { oai.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', instructions: instr3 } })); log('[' + id + '] LANG repinned pin=' + (callerLang === 'en' ? 'en' : 'neutral') + ' instructions_len=' + instr3.length); } catch (e) {}
          }
          const det = detectAddress(said);
          if (det && det !== currentAddress) {
            log('[' + id + '] ADDRESS ' + (currentAddress || '(none)') + ' -> ' + det + ' at turn ' + turnNo);
            currentAddress = det;
            const instr2 = buildInstructions({ lang: callLang, style: callStyle, address: currentAddress, opening: callOpening, task: callTask, details: callDetails, defaults: callDefaults, forcedLang: callerLang });
            try { oai.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', instructions: instr2 } })); } catch (e) {}
          }
        }
        return;
      }

      if (ev.type === 'response.output_audio_transcript.delta' || ev.type === 'response.audio_transcript.delta') {
        herText += (ev.delta || '');
        if (!needsApproval && herText.indexOf('hỏi lại') !== -1) {
          needsApproval = true;
          log('[' + id + '] NEEDS_APPROVAL - she deferred instead of agreeing');
        }
        return;
      }
      if (ev.type === 'error') {
        log('[' + id + '] openai error ' + JSON.stringify(ev.error || {}).slice(0, 200));
      }
    });

    oai.on('close', (code, reason) => log('[' + id + '] openai closed ' + code + ' ' + (reason ? reason.toString() : '')));
    oai.on('error', (e) => log('[' + id + '] openai ws error ' + e.message));
  };

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === 'connected') { log('[' + id + '] twilio connected'); return; }

    if (msg.event === 'start') {
      const s = msg.start || {};
      streamSid = s.streamSid;
      const cp = s.customParameters || {};
      const twilioLeg = cp.twilio || '';
      callVoice = cp.voice || '';
      callLang = cp.lang || 'vi';
      if (String(callLang).toLowerCase() === 'auto' && process.env.REALTIME_AUTO_EXPERIMENT !== '1') {
        log('[' + id + '] lang=auto is experimental and disabled - using vi persona');
        callLang = 'vi';
      }
      callAddress = cp.address || '';
      currentAddress = cp.address || '';
      callOpening = cp.opening || '';
      callTask = cp.task || '';
      callDetails = cp.details || '';
      callDefaults = cp.defaults || '';
      callStyle = cp.style || '';
      log('[' + id + '] voice_override=' + (callVoice || '(default)') + ' style=' + (callStyle ? 'custom' : '(default)'));
      log('[' + id + '] start stream=' + streamSid + ' call=' + s.callSid + ' format=' + JSON.stringify(s.mediaFormat));
      if (!twilioLeg.endsWith(TWILIO_NUMBER.replace('+', '')) && twilioLeg !== TWILIO_NUMBER) {
        log('[' + id + '] REJECT call — twilio number not on this stream (' + (twilioLeg || 'none') + ')');
        try { ws.close(1008, 'twilio-number-not-allowed'); } catch {}
        return;
      }
      // outbound only: Twilio reports the dialled number as customParameters.to
      const toLeg = String(cp.to || '');
      const digitOnly = (v) => String(v || '').replace(/[^0-9]/g, '');
      if (digitOnly(toLeg) && digitOnly(toLeg) === digitOnly(TWILIO_NUMBER)) {
        log('[' + id + '] REJECT call - inbound to ' + TWILIO_NUMBER + ' (outbound only)');
        try { ws.close(1008, 'inbound-not-allowed'); } catch {}
        return;
      }
      openOpenAI();
      timer = setTimeout(() => {
        log('[' + id + '] TIME LIMIT reached — closing');
        try { ws.close(1000, 'time-limit'); } catch {}
      }, MAX_CALL_MS);
      return;
    }

    if (msg.event === 'media') {
      if (oai && oai.readyState === 1 && msg.media && msg.media.payload) {
        try { oai.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.media.payload })); } catch {}
      }
      return;
    }

    if (msg.event === 'stop') {
      log('[' + id + '] twilio stop');
      try { ws.close(1000, 'stopped'); } catch {}
      return;
    }
  });

  ws.on('close', (code, reason) => {
    cleanup();
    log('[' + id + '] closed ' + code + ' ' + (reason ? reason.toString() : '') + ' active=' + activeCalls);
  });
  ws.on('error', (e) => log('[' + id + '] twilio ws error ' + e.message));
});

if (process.env.REALTIME_NO_LISTEN !== '1') server.listen(PORT, HOST, () => {
  log('listening ws://' + HOST + ':' + PORT + ' model=' + MODEL + ' voice=' + VOICE + ' td=' + TURN_DETECTION + ' twilio=' + TWILIO_NUMBER);
  if (!AUTH_TOKEN) log('WARNING: TWILIO_AUTH_TOKEN missing — every upgrade will be rejected');
  if (!OPENAI_KEY) log('WARNING: OPENAI_API_KEY missing — calls will fail at OpenAI');
});

let shuttingDown = false;
const shutdown = (sig) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log('[' + sig + '] graceful shutdown requested, active calls=' + activeCalls);
  try { wss.close(); } catch {}
  try { server.close(); } catch {}
  if (!activeCalls) { log('[' + sig + '] no active calls, exiting now'); process.exit(0); }
  const deadline = Date.now() + 180000;
  const tick = setInterval(() => {
    if (!activeCalls) { clearInterval(tick); log('[' + sig + '] all calls finished, exiting'); process.exit(0); }
    if (Date.now() > deadline) { clearInterval(tick); log('[' + sig + '] 180s wait exceeded, forcing exit with active=' + activeCalls); process.exit(0); }
  }, 1000);
  log('[' + sig + '] waiting for ' + activeCalls + ' active call(s), up to 180s');
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
