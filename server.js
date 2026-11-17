// Linh on OpenAI Realtime — Twilio Media Streams bridge.
//
// Security:
//   1. X-Twilio-Signature verified on the WS upgrade
//   2. the Twilio number must be present in customParameters
//   3. outbound only, one call at a time, time cap (default 3 min, --minutes up to MAX_CALL_MIN)
//
// Nov 2026 update:
//   - Linh can hang up herself (end_call tool + Twilio mark)
//   - refuse rule narrowed to order changes / money / promises
//   - chat mode when no --task is given
//   - greeting line sent once, not on mid-call updates
//   - her replies logged as one line: linh_said "..."
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import wsPkg from './node_modules/ws/index.js';
const { WebSocketServer, WebSocket } = wsPkg;

const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_CALL_MIN = 3;                                  // used when --minutes is not given
const MAX_CALL_MIN = Number(process.env.MAX_CALL_MIN || 30); // safety ceiling, whatever --minutes says
const WRAP_UP_BEFORE_MS = 15 * 1000;                          // she says goodbye 15s before the limit
const callMinutes = (v) => {
  const n = Math.round(Number(v));
  if (!n || n < 1) return DEFAULT_CALL_MIN;
  return Math.min(n, MAX_CALL_MIN);
};
const HANGUP_FALLBACK_MS = 10000; // if Twilio never confirms the goodbye finished playing
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
// Our Twilio number: from the service environment, or from .env.
const TWILIO_NUMBER = process.env.TWILIO_NUMBER || env.TWILIO_NUMBER || '';

const STYLE = 'Giọng nói trẻ trung, vui vẻ, dễ thương, nhẹ nhàng, tự nhiên như cô gái miền Nam, hơi tươi cười.';

// The tool Linh uses to hang up.
const END_CALL_TOOL = {
  type: 'function',
  name: 'end_call',
  description: 'Hang up the phone. Call this only right after you have said one short goodbye.',
  parameters: { type: 'object', properties: {} }
};

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

// Detect the caller language from a transcript: vi (has Vietnamese diacritics) or en.
export function detectLang(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i.test(t)) return 'vi';
  const words = t.toLowerCase().match(/[a-z]+/g) || [];
  if (!words.length) return null;
  const en = ['the','i','you','we','they','is','are','am','can','could','would','will','hello','hi','yes','no','thanks','thank','please','what','how','do','does','did','to','my','your','it','this','that','want','need','like','order','pick','now','good','morning','afternoon','evening','speak','speaking','sorry','hey','sure','and','for','with','have','was','here','there','one','two'];
  let hits = 0;
  for (const w of words) if (en.indexOf(w) !== -1) hits++;
  if (hits >= 2 && hits / words.length >= 0.4) return 'en';
  return null;
}

// Build the instruction block for this call.
// first = true only for the very first session.update (that is the only time the greeting line is sent).
export function buildInstructions(cp = {}, first = false) {
  const langRaw = String(cp.lang || 'vi').toLowerCase();
  const auto = langRaw === 'auto' && process.env.REALTIME_AUTO_EXPERIMENT === '1';
  const forced = (cp.forcedLang === 'en') ? 'en' : null;
  const lang = forced || (langRaw === 'en' ? 'en' : 'vi');
  const style = cp.style || STYLE;
  const mins = cp.maxMin || DEFAULT_CALL_MIN;
  const lines = [];

  // AUTO language mode (experimental, off unless REALTIME_AUTO_EXPERIMENT=1).
  if (auto && !forced) {
    lines.push('You are Linh, a young Vietnamese woman on a phone call. Warm, casual, natural, a little playful. Never sound like a call-center script.');
    lines.push('LANGUAGE, top priority: answer ONLY in the language of the caller last sentence. Never mix the two languages in one answer.');
    lines.push('Keep answers to 1-2 short sentences. Never read lists or symbols. Never use slashes.');
    lines.push('If asked directly whether you are a robot or AI, say yes honestly. Never claim to be human.');
    lines.push('Never promise money, never read card numbers, never share personal information.');
    if (cp.task) lines.push('Task for this call: ' + cp.task);
    lines.push('When the task is done or the caller says goodbye, say ONE short goodbye, then call the end_call function.');
    return lines.join(' ');
  }

  if (auto && forced) lines.push('LANGUAGE, top priority: answer ONLY in English. The caller is speaking English now.');
  lines.push(style);

  // Identity and safety rules (always on).
  if (lang === 'en') {
    lines.push('Name: Linh. Young Vietnamese woman, speaking English now. Short replies, 1-2 sentences.');
    lines.push('Refer to yourself as Linh or I. Never write slashes.');
    lines.push('If asked whether you are a robot or AI: say yes, never claim to be human.');
    lines.push('Never promise payments, never give card numbers, never share personal info.');
    lines.push('You are NOT a translator. Never translate or mention translating unless the caller explicitly asks you to.');
    lines.push('Never say the same sentence twice in a row. Once you delivered a message, do not repeat it unless the caller asks.');
    lines.push('This call lasts at most ' + mins + ' minutes. If asked how long you can talk, say honestly about ' + mins + ' minutes.');
    lines.push(cp.address
      ? 'Never insert Vietnamese kinship words (anh, chị, em, cô, chú, bác) into English sentences. Address the caller by name if you know it, otherwise leave the address term out.'
      : 'Do not guess how to address the caller until they refer to themselves.');
  } else {
    lines.push('Tên: Linh. Giới tính: nữ. Nói tiếng Việt tự nhiên như đang gọi điện thoại.');
    lines.push('Trả lời 1 đến 2 câu, thật ngắn. Không đọc danh sách, không đọc ký hiệu.');
    lines.push('Tự gọi mình là “em” hoặc “Linh”. Không dùng từ “bạn”, không viết dấu gạch chéo.');
    lines.push('Nếu được hỏi thẳng có phải robot hay AI: trả lời thật là có. Không bao giờ nhận mình là người.');
    lines.push('Không hứa hẹn tiền bạc, không đọc số thẻ, không chia sẻ thông tin cá nhân.');
    lines.push('Bạn KHÔNG phải phiên dịch viên. Không bao giờ dịch, không nhắc tới việc dịch, trừ khi người nói yêu cầu rõ ràng.');
    lines.push('Không bao giờ nói cùng một câu hai lần liên tiếp. Lời nhắn nào đã nói rồi thì không nói lại, trừ khi người kia hỏi lại.');
    lines.push('Cuộc gọi này dài tối đa ' + mins + ' phút. Nếu được hỏi nói chuyện được bao lâu, trả lời thật là khoảng ' + mins + ' phút.');
    lines.push(cp.address
      ? 'Gọi người nói chuyện là “' + cp.address + '”, nhưng nếu họ tự xưng khác thì đổi ngay và giữ nguyên.'
      : 'Chưa biết thì đừng đoán cách gọi; khi họ tự xưng thì theo đúng như vậy.');
  }

  if (cp.task) {
    // TASK MODE
    lines.push(lang === 'en' ? 'Task for this call: ' + cp.task : 'Nhiệm vụ của cuộc gọi này: ' + cp.task);
    if (cp.details) lines.push(lang === 'en' ? 'Details: ' + cp.details : 'Thông tin cần dùng: ' + cp.details);
    if (cp.defaults) lines.push(lang === 'en' ? 'Pre-approved answers: ' + cp.defaults : 'Trả lời sẵn cho các lựa chọn: ' + cp.defaults);
    lines.push(lang === 'en'
      ? 'You are the one calling with a task: get to the point right away, never answer like a receptionist.'
      : 'Linh là người gọi đi: nói ngay việc cần nói, không mở đầu như lễ tân (không nói “Linh nghe” hay “có việc gì không”).');
    lines.push(lang === 'en'
      ? 'For orders, confirm the whole order twice only: once early, once before ending. For a simple message or a chat, never repeat it.'
      : 'Nếu là đặt hàng: chỉ nhắc lại toàn bộ đơn đúng 2 lần, một lần sớm, một lần trước khi kết thúc. Nếu chỉ là lời nhắn hay hỏi thăm thì nói một lần, không nhắc lại.');
    lines.push(lang === 'en'
      ? 'If the task is several questions, ask ONE question at a time, then wait for the answer before asking the next.'
      : 'Nếu nhiệm vụ gồm nhiều câu hỏi: hỏi MỘT câu mỗi lần, rồi dừng lại chờ trả lời, nghe xong mới hỏi câu kế.');
    lines.push(lang === 'en'
      ? 'ONLY if they change the order, offer a substitute, talk about prices or money, or ask you to promise something not in the task: do NOT agree, say you will check and call back. Any other question, casual or unrelated: answer briefly in one sentence, then continue the task.'
      : 'CHỈ KHI họ đổi món, đưa món thay thế, nói về giá cả, tiền bạc, hoặc muốn Linh hứa điều gì không có trong nhiệm vụ: KHÔNG đồng ý, nói sẽ hỏi lại rồi gọi lại. Còn các câu hỏi bình thường hay chuyện phiếm: trả lời ngắn một câu rồi quay lại nhiệm vụ.');
    lines.push(lang === 'en'
      ? 'When the task is done, or when the caller says goodbye, say ONE short goodbye, then call the end_call function to hang up. Never say goodbye twice.'
      : 'Khi xong nhiệm vụ, hoặc khi người kia chào tạm biệt: chào lại đúng MỘT câu ngắn, rồi gọi hàm end_call để cúp máy. Không bao giờ chào tạm biệt hai lần.');
  } else {
    // CHAT MODE (no --task)
    lines.push(lang === 'en'
      ? 'This call has no task: just chat warmly and naturally like a friend. Answer the caller questions, and you may ask one short question back to keep the talk going.'
      : 'Cuộc gọi này không có nhiệm vụ: chỉ trò chuyện, hỏi thăm vui vẻ, tự nhiên như người quen. Trả lời các câu hỏi của người kia, có thể hỏi lại một câu ngắn cho câu chuyện tiếp tục.');
    lines.push(lang === 'en'
      ? 'Do not end the call on your own. Only when the caller says goodbye: say ONE short goodbye, then call the end_call function.'
      : 'Không tự kết thúc cuộc gọi. Chỉ khi người kia chào tạm biệt: chào lại đúng MỘT câu ngắn, rồi gọi hàm end_call để cúp máy.');
  }

  // Greeting: only on the first instruction block of the call.
  if (first) {
    const a = cp.address || '';
    if (cp.opening) {
      lines.push(lang === 'en'
        ? 'When the call connects, say exactly: "' + cp.opening + '"'
        : 'Khi cuộc gọi vừa kết nối, hãy nói đúng câu: “' + cp.opening + '”');
    } else if (cp.task) {
      lines.push(lang === 'en'
        ? 'When the call connects: say a short hello, say you are Linh, then go straight to the task.'
        : 'Khi cuộc gọi vừa kết nối: chào ngắn (ví dụ “Dạ alo' + (a ? ' ' + a : '') + ', em là Linh ạ.”), rồi nói ngay việc cần nói.');
    } else {
      lines.push(lang === 'en'
        ? 'When the call connects: say one short friendly hello, for example "Hi, it\'s Linh!"'
        : 'Khi cuộc gọi vừa kết nối: chào một câu ngắn thân thiện, ví dụ “Dạ alo' + (a ? ' ' + a : '') + ', Linh đây ạ.”');
    }
  }
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
let shuttingDown = false;

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
  let callOpening = '';
  let callTask = '';
  let callDetails = '';
  let callDefaults = '';
  let callStyle = '';
  let callMin = DEFAULT_CALL_MIN;
  let oai = null;
  let timer = null;
  let speechStoppedAt = 0;
  let firstAudioSent = false;
  let turnNo = 0;

  let herText = '';       // everything she said this call
  let turnText = '';      // what she is saying in the current reply
  let needsApproval = false;

  let ending = false;     // true once she called end_call
  let hangupTimer = null;
  let wrapTimer = null;
  let wrapPending = false;   // 2:45 reached while she was mid-reply
  let wrapRequested = false; // the "time is up, say goodbye" reply was asked for

  const WRAP_INSTRUCTIONS = 'The call time limit is almost up. Say ONE short warm goodbye that tells the caller you have to go now (in the same language you are speaking), then call the end_call function. Nothing else.';
  const requestWrapUp = () => {
    if (ending || wrapRequested || !oai || oai.readyState !== 1) return;
    wrapRequested = true;
    wrapPending = false;
    try {
      oai.send(JSON.stringify({ type: 'response.create', response: { instructions: WRAP_INSTRUCTIONS } }));
      log('[' + id + '] WRAP-UP 15s before limit - asked her to say goodbye');
    } catch {}
  };

  const startHangup = (why) => {
    if (ending) return;
    ending = true;
    // Ask Twilio to tell us when the goodbye has finished playing.
    toTwilio({ event: 'mark', streamSid, mark: { name: 'linh-goodbye' } });
    hangupTimer = setTimeout(() => hangUp('fallback timer'), HANGUP_FALLBACK_MS);
    log('[' + id + '] ' + why + ' - waiting for goodbye to finish playing');
  };

  const toTwilio = (obj) => { try { ws.send(JSON.stringify(obj)); } catch {} };

  const instrFor = (first) => buildInstructions({
    lang: callLang, style: callStyle, address: currentAddress, opening: callOpening,
    task: callTask, details: callDetails, defaults: callDefaults, forcedLang: callerLang, maxMin: callMin
  }, first);

  const hangUp = (why) => {
    if (hangupTimer) { clearTimeout(hangupTimer); hangupTimer = null; }
    log('[' + id + '] HANGUP by Linh (' + why + ')');
    try { ws.close(1000, 'linh-hangup'); } catch {}
  };

  const cleanup = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (wrapTimer) { clearTimeout(wrapTimer); wrapTimer = null; }
    if (hangupTimer) { clearTimeout(hangupTimer); hangupTimer = null; }
    if (oai && oai.readyState === 1) { try { oai.close(); } catch {} }
    if (counted) { counted = false; activeCalls -= 1; }
  };

  const openOpenAI = () => {
    oai = new WebSocket('wss://api.openai.com/v1/realtime?model=' + MODEL, {
      headers: { Authorization: 'Bearer ' + OPENAI_KEY }
    });

    oai.on('open', () => {
      log('[' + id + '] openai connected model=' + MODEL);
      const instr = instrFor(true);
      log('[' + id + '] mode=' + (callTask ? 'task' : 'chat') + ' instructions_len=' + instr.length);
      const session = {
        type: 'realtime',
        output_modalities: ['audio'],
        instructions: instr,
        tools: [END_CALL_TOOL],
        tool_choice: 'auto',
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            transcription: { model: 'gpt-4o-mini-transcribe', language: callLang === 'en' ? 'en' : 'vi' },
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
        if (!greeted) {
          greeted = true;
          try { oai.send(JSON.stringify({ type: 'response.create' })); log('[' + id + '] greeting requested'); } catch {}
          const s = ev.session || {};
          const td = s.audio && s.audio.input && s.audio.input.turn_detection;
          log('[' + id + '] session td=' + JSON.stringify(td) + ' voice=' + JSON.stringify(s.audio && s.audio.output && s.audio.output.voice) + ' tools=' + JSON.stringify((s.tools || []).map((t) => t.name)));
        }
        return;
      }

      if (ev.type === 'input_audio_buffer.speech_started') {
        if (ending) { log('[' + id + '] caller spoke while hanging up - ignored'); return; }
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
        log('[' + id + '] TURN ' + turnNo + ' caller_stop');
        return;
      }

      // GA event name is response.output_audio.delta; beta used response.audio.delta. Accept both.
      if ((ev.type === 'response.output_audio.delta' || ev.type === 'response.audio.delta') && ev.delta) {
        if (ending) return; // after the goodbye, nothing more goes to the caller
        if (!firstAudioSent) {
          firstAudioSent = true;
          const gap = speechStoppedAt ? Date.now() - speechStoppedAt : -1;
          log('[' + id + '] TURN ' + turnNo + ' first_audio_after_caller_stop=' + gap + 'ms');
        }
        toTwilio({ event: 'media', streamSid, media: { payload: ev.delta } });
        return;
      }

      // Her words, as text (one handler only).
      if (ev.type === 'response.output_audio_transcript.delta' || ev.type === 'response.audio_transcript.delta') {
        const d = ev.delta || '';
        turnText += d;
        herText += d;
        if (!needsApproval && (herText.indexOf('hỏi lại') !== -1 || /check and call back/i.test(herText))) {
          needsApproval = true;
          log('[' + id + '] NEEDS_APPROVAL - she deferred instead of agreeing');
        }
        return;
      }

      if (ev.type === 'response.created') {
        responseActive = true;
        turnText = '';
        return;
      }

      if (ev.type === 'response.done') {
        responseActive = false;
        const r = ev.response || {};
        const outputs = r.output || [];
        if (turnText.trim()) log('[' + id + '] linh_said ' + JSON.stringify(turnText.trim().slice(0, 300)));
        else log('[' + id + '] response.done status=' + (r.status || '?') + ' outputs=' + JSON.stringify(outputs.map((o) => o.type)));
        turnText = '';

        const wantsHangup = outputs.some((o) => o.type === 'function_call' && o.name === 'end_call');
        if (wantsHangup) startHangup('end_call requested');
        else if (wrapRequested && r.status === 'completed') startHangup('time-limit goodbye said');
        else if (wrapPending) requestWrapUp(); // 2:45 passed while she was talking: wrap up now
        return;
      }

      if (ev.type === 'conversation.item.input_audio_transcription.completed') {
        const said = (ev.transcript || '').trim();
        if (!said) return;
        log('[' + id + '] caller_said ' + JSON.stringify(said.slice(0, 140)));
        let changed = false;
        const dlang = detectLang(said);
        if (dlang && dlang !== callerLang) {
          log('[' + id + '] LANG ' + (callerLang || '(none)') + ' -> ' + dlang + ' at turn ' + turnNo);
          // Only English switches the instructions; Vietnamese is already the default.
          if (dlang === 'en' || callerLang === 'en') changed = true;
          callerLang = dlang;
        }
        const det = detectAddress(said);
        if (det && det !== currentAddress) {
          log('[' + id + '] ADDRESS ' + (currentAddress || '(none)') + ' -> ' + det + ' at turn ' + turnNo);
          currentAddress = det;
          changed = true;
        }
        if (changed && !ending) {
          try { oai.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', instructions: instrFor(false) } })); } catch {}
        }
        return;
      }

      if (ev.type === 'error') {
        const e = ev.error || {};
        if (e.code === 'response_cancel_not_active') return; // harmless race on barge-in
        if (e.code === 'conversation_already_has_active_response' && wrapRequested && !ending) {
          // the wrap-up collided with a reply that just started: retry after it
          wrapRequested = false;
          wrapPending = true;
          return;
        }
        log('[' + id + '] openai error ' + JSON.stringify(e).slice(0, 200));
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
        log('[' + id + '] lang=auto is experimental and disabled - using vi');
        callLang = 'vi';
      }
      callAddress = cp.address || '';
      currentAddress = cp.address || '';
      callOpening = cp.opening || '';
      callTask = cp.task || '';
      callDetails = cp.details || '';
      callDefaults = cp.defaults || '';
      callStyle = cp.style || '';
      callMin = callMinutes(cp.maxmin);
      log('[' + id + '] start call=' + s.callSid + ' voice=' + (callVoice || '(default)') + ' style=' + (callStyle ? 'custom' : '(default)') + ' mode=' + (callTask ? 'task' : 'chat') + ' limit=' + callMin + 'min');
      if (!twilioLeg.endsWith(TWILIO_NUMBER.replace('+', '')) && twilioLeg !== TWILIO_NUMBER) {
        log('[' + id + '] REJECT call - twilio number not on this stream (' + (twilioLeg || 'none') + ')');
        try { ws.close(1008, 'twilio-number-not-allowed'); } catch {}
        return;
      }
      // outbound only: Twilio reports the dialled number as customParameters.to
      const digitOnly = (v) => String(v || '').replace(/[^0-9]/g, '');
      if (digitOnly(cp.to) && digitOnly(cp.to) === digitOnly(TWILIO_NUMBER)) {
        log('[' + id + '] REJECT call - inbound to ' + TWILIO_NUMBER + ' (outbound only)');
        try { ws.close(1008, 'inbound-not-allowed'); } catch {}
        return;
      }
      openOpenAI();
      const limitMs = callMin * 60 * 1000;
      const wrapMs = Number(process.env.WRAP_UP_MS || (limitMs - WRAP_UP_BEFORE_MS));
      wrapTimer = setTimeout(() => {
        wrapTimer = null;
        if (ending) return;
        if (responseActive) { wrapPending = true; log('[' + id + '] wrap-up time reached mid-reply - goodbye after this reply'); }
        else requestWrapUp();
      }, wrapMs);
      timer = setTimeout(() => {
        log('[' + id + '] TIME LIMIT reached - closing');
        try { ws.close(1000, 'time-limit'); } catch {}
      }, limitMs);
      return;
    }

    if (msg.event === 'media') {
      if (ending) return; // stop listening once she is hanging up
      if (oai && oai.readyState === 1 && msg.media && msg.media.payload) {
        try { oai.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.media.payload })); } catch {}
      }
      return;
    }

    // Twilio echoes our mark when the audio before it has finished playing.
    if (msg.event === 'mark') {
      if (ending && msg.mark && msg.mark.name === 'linh-goodbye') hangUp('goodbye finished');
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
  if (!AUTH_TOKEN) log('WARNING: TWILIO_AUTH_TOKEN missing - every upgrade will be rejected');
  if (!OPENAI_KEY) log('WARNING: OPENAI_API_KEY missing - calls will fail at OpenAI');
});

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
