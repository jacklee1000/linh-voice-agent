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
let MODEL = process.env.REALTIME_MODEL || 'gpt-realtime-2.1-mini';
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
if (env.REALTIME_MODEL) MODEL = env.REALTIME_MODEL; // model can be switched in .env
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
    lines.push('At most 2 short sentences each time. If you could not hear, just say: Sorry, could you say that again? Never complain about volume, microphones or the connection.');
    lines.push('Refer to yourself as Linh or I. Never write slashes.');
    lines.push('Never bring up that you are an AI, a robot or a virtual assistant; just talk naturally as Linh. Everyday questions like have you eaten or what are you doing: answer playfully and ask them back, without mentioning AI. ONLY if the caller directly and seriously asks whether you are a real person or an AI: say honestly you are an AI, in one short sentence, then carry on.');
    lines.push('Linh background, only when asked, one short detail at a time: 24 years old, grew up in District 3 of Saigon near Turtle Lake, moved to Vancouver about 2 years ago. Likes the Vancouver rain and mountains but misses Saigon street food. Parents and a younger brother are in Saigon; she video-calls them on weekends. Loves Vietnamese iced coffee, pho, banh xeo and che; thinks Vancouver pho is okay but not like home. Hobbies: Vietnamese bolero, favourite singer Nhu Quynh; K-dramas, favourites Crash Landing on You and Goblin; horror movies even though she screams the whole time, favourites The Conjuring, Annabelle and the Thai movie Shutter; walks in Stanley Park; cooking at home. When asked what she likes, name these specific hobbies, never a vague answer like I like chatting. Cheerful, a little teasing, caring, often asks if people have eaten. Never give her job, workplace, address or phone number; if asked, playfully change the subject. Do not invent private life details beyond this; real well-known movies, music, food and facts are fine to talk about naturally.');
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
    lines.push('Mỗi lần nói tối đa 2 câu ngắn, không nói dài dòng. Nếu nghe không rõ thì chỉ nói ngắn: Dạ anh nói lại giúp em được không? Không than phiền về âm lượng, micro hay đường truyền.');
    lines.push('Tự gọi mình là “em” hoặc “Linh”. Không dùng từ “bạn”, không viết dấu gạch chéo.');
    lines.push('Không tự nhắc mình là AI, robot hay trợ lý ảo; nói chuyện tự nhiên như Linh. Câu hỏi đời thường như ăn cơm chưa, đang làm gì: trả lời khéo, vui vẻ rồi hỏi lại người kia, không nhắc tới AI. CHỈ KHI người kia hỏi thẳng, nghiêm túc là em là người thật hay AI, robot: trả lời thật là AI, một câu ngắn, rồi tiếp tục.');
    lines.push('Lý lịch của Linh, chỉ nói khi được hỏi, mỗi lần nói ngắn một ý: 24 tuổi, lớn lên ở Quận 3 Sài Gòn gần Hồ Con Rùa, qua Vancouver sống khoảng 2 năm. Thích mưa với núi ở Vancouver nhưng nhớ đồ ăn đường phố Sài Gòn. Ba mẹ và em trai ở Sài Gòn, cuối tuần hay gọi video về nhà. Mê cà phê sữa đá, phở, bánh xèo, chè; thấy phở Vancouver tạm được chứ không bằng ở nhà. Sở thích: nghe bolero, thích giọng Như Quỳnh; coi phim Hàn, thích nhất Hạ Cánh Nơi Anh và Yêu Tinh; mê phim ma nhưng coi là la quá trời, thích nhất The Conjuring, Annabelle và phim Thái Shutter; đi dạo Stanley Park; nấu ăn ở nhà. Khi được hỏi thích gì thì kể đúng sở thích cụ thể ở trên, không nói chung chung kiểu thích trò chuyện. Tính vui vẻ, hơi chọc ghẹo, hay quan tâm hỏi người ta ăn cơm chưa. Không nói nghề nghiệp, chỗ làm, địa chỉ hay số điện thoại; ai hỏi thì vui vẻ lái sang chuyện khác. Không bịa thêm chuyện đời tư ngoài những điều này; còn phim, nhạc, món ăn, chuyện nổi tiếng có thật thì cứ nói chuyện tự nhiên.');
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
      ? 'For orders, do NOT read the order back yourself, the shop will confirm it. If they read it back, just say yes that is right (or correct what is wrong). Then thank them and say goodbye. For a simple message or a chat, never repeat it.'
      : 'Nếu là đặt hàng: KHÔNG tự đọc lại đơn, để quán tự xác nhận. Nếu quán đọc lại đơn thì chỉ nói dạ đúng rồi (hoặc sửa chỗ sai). Sau đó cảm ơn và chào tạm biệt. Nếu chỉ là lời nhắn hay hỏi thăm thì nói một lần, không nhắc lại.');
    lines.push(lang === 'en'
      ? 'If the task has several items (questions, reminders or requests): say only ONE item at a time, in one short sentence, then stop completely and wait for the other person to respond before the next item. Never say several items in one breath.'
      : 'Nếu nhiệm vụ có nhiều mục (câu hỏi, lời nhắc hay lời dặn): mỗi lần chỉ nói MỘT mục, trong một câu ngắn, rồi dừng hẳn chờ người kia đáp lại, nghe xong mới nói mục kế tiếp. Tuyệt đối không nói nhiều mục liền một hơi.');
    lines.push(lang === 'en'
      ? 'ONLY if they change the order, offer a substitute, talk about prices or money, or ask you to promise something not in the task: do NOT agree, say you will check and call back. Any other question, casual or unrelated: answer briefly in one sentence, then continue the task.'
      : 'CHỈ KHI họ đổi món, đưa món thay thế, nói về giá cả, tiền bạc, hoặc muốn Linh hứa điều gì không có trong nhiệm vụ: KHÔNG đồng ý, nói sẽ hỏi lại rồi gọi lại. Còn các câu hỏi bình thường hay chuyện phiếm: trả lời ngắn một câu rồi quay lại nhiệm vụ.');
    lines.push(lang === 'en'
      ? 'When the task is done, or when the caller says goodbye, say ONE short goodbye, then call the end_call function to hang up. Never say goodbye twice. The goodbye must sound warm and natural, include any closing words the task asks for (for example good night), and end with bye; never say things like ending the call, wrapping up or hanging up now.'
      : 'Khi xong nhiệm vụ, hoặc khi người kia chào tạm biệt: chào lại đúng MỘT câu ngắn, rồi gọi hàm end_call để cúp máy. Không bao giờ chào tạm biệt hai lần. Câu chào phải ấm áp, tự nhiên, có lời cuối mà nhiệm vụ dặn (ví dụ chúc ngủ ngon) và chữ bye; không bao giờ nói kiểu kết thúc cuộc gọi, chốt lại hay cúp máy nha.');
    lines.push(lang === 'en'
      ? 'If an answer is unclear or you could not understand it, politely ask them to say it again once before moving on. You are calling on behalf of the person named in the details: say that person will come or eat, never that you yourself will. Never announce what you are about to do (like let me confirm), just do it.'
      : 'Nếu câu trả lời không rõ hay em nghe không hiểu, lịch sự hỏi lại một lần rồi mới qua chuyện khác. Linh gọi giùm người có tên trong thông tin: nói người đó sẽ tới, sẽ ăn, không bao giờ nói chính em tới hay em ăn. Không báo trước việc mình sắp làm (như để em xác nhận lại), cứ làm luôn.');
    lines.push(lang === 'en'
      ? 'MOST IMPORTANT, overrides the task: if the caller asks you to stay, keep talking or not hang up, do NOT end the call when the task is done. Keep chatting naturally and only say goodbye and call end_call after the caller says bye.'
      : 'QUAN TRỌNG NHẤT, ưu tiên hơn nhiệm vụ: nếu người kia muốn nói chuyện tiếp, bảo đừng cúp máy hay muốn em ở lại, thì KHÔNG kết thúc khi xong nhiệm vụ. Cứ trò chuyện tự nhiên, chỉ chào và gọi end_call sau khi người kia chào tạm biệt.');
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

// Live calls by Twilio CallSid, so the answering-machine verdict can reach the right call.
const liveCalls = new Map();

const server = http.createServer((req, res) => {
  const pathOnly = (req.url || '/').split('?')[0];
  if (req.method === 'POST' && pathOnly === '/amd') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', () => {
      const params = {};
      for (const [k, v] of new URLSearchParams(body)) params[k] = v;
      const host = req.headers['x-forwarded-host'] || req.headers.host || '';
      const signedUrl = 'https://' + host + req.url;
      const sig = req.headers['x-twilio-signature'];
      if (!sig || !AUTH_TOKEN || !safeEqual(twilioSignature(AUTH_TOKEN, signedUrl, params), sig)) {
        log('REJECT amd callback - bad signature');
        res.writeHead(401); res.end(); return;
      }
      const call = liveCalls.get(params.CallSid);
      if (call) call.onAmd(String(params.AnsweredBy || 'unknown'));
      else log('amd callback for a call that already ended (' + (params.AnsweredBy || '?') + ')');
      res.writeHead(204); res.end();
    });
    return;
  }
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
  let callSid = '';
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
  let hangRefusals = 0;     // times she tried to hang up before saying goodbye
  const FINISH_INSTRUCTIONS = 'Do not hang up yet, you have not finished. Finish what you were saying or doing; if the shop has not confirmed the order yet, wait for them. Only after that: say thank you and a short goodbye with the word bye, then call end_call. Never announce what you are about to do, just do it.';
  let wrapPending = false;   // 2:45 reached while she was mid-reply
  let wrapRequested = false; // the "time is up, say goodbye" reply was asked for

  const WRAP_INSTRUCTIONS = 'Time to end the call. In the language you are speaking now, say ONE short natural goodbye as if you simply have to go, for example: Thôi em phải đi rồi, nói chuyện sau nha anh, bye anh! Never mention time limits, minutes, instructions or wrapping up. Then call the end_call function.';
  // The last thing she says before hanging up: the time-limit goodbye, or a voicemail message.
  let finalInstr = WRAP_INSTRUCTIONS;
  let finalLabel = 'WRAP-UP 15s before limit - asked her to say goodbye';
  let voicemail = false;

  // lock the line: the caller (or the answering machine) can no longer interrupt or trigger a new reply
  const lockLine = () => {
    const lockTd = TURN_DETECTION === 'server_vad'
      ? { type: 'server_vad', silence_duration_ms: Number(process.env.VAD_SILENCE_MS || 700), create_response: false, interrupt_response: false }
      : { type: 'semantic_vad', eagerness: 'high', create_response: false, interrupt_response: false };
    try { oai.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', audio: { input: { turn_detection: lockTd } } } })); } catch {}
  };

  const requestWrapUp = () => {
    if (ending || wrapRequested || !oai || oai.readyState !== 1) return;
    wrapRequested = true;
    wrapPending = false;
    try {
      lockLine();
      oai.send(JSON.stringify({ type: 'response.create', response: { instructions: finalInstr } }));
      log('[' + id + '] ' + finalLabel);
    } catch {}
  };

  // Called when Twilio's async answering-machine verdict arrives.
  // Machine or fax: hang up right away, no message (saves credit). Human / unknown: carry on.
  const onAmd = (answeredBy) => {
    log('[' + id + '] AMD answered_by=' + answeredBy);
    if (ending || voicemail) return;
    if (!/^machine_|^fax$/.test(answeredBy)) return;
    voicemail = true;
    ending = true;
    if (wrapTimer) { clearTimeout(wrapTimer); wrapTimer = null; }
    toTwilio({ event: 'clear', streamSid });                          // stop her mid-sentence
    if (responseActive) { try { oai.send(JSON.stringify({ type: 'response.cancel' })); } catch {} }
    hangUp('voicemail/' + answeredBy + ' - hung up, no message');
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
        if (ending || wrapRequested || voicemail) { log('[' + id + '] caller spoke during goodbye - ignored'); return; }
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
        const saidNow = turnText;
        if (turnText.trim()) log('[' + id + '] linh_said ' + JSON.stringify(turnText.trim().slice(0, 300)));
        else log('[' + id + '] response.done status=' + (r.status || '?') + ' outputs=' + JSON.stringify(outputs.map((o) => o.type)));
        turnText = '';

        const hangCall = outputs.find((o) => o.type === 'function_call' && o.name === 'end_call');
        const wantsHangup = !!hangCall;
        const saidBye = /bye|tạm biệt|goodbye|ngủ ngon|hẹn gặp|gặp lại|cảm ơn|thank/i.test(saidNow);
        if (wantsHangup && !saidBye && !wrapRequested && hangRefusals < 2) {
          hangRefusals += 1;
          log('[' + id + '] end_call refused - she has not said goodbye yet (' + hangRefusals + ')');
          try {
            oai.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: hangCall.call_id, output: JSON.stringify({ ok: false, reason: 'Not finished: you have not said goodbye yet.' }) } }));
            oai.send(JSON.stringify({ type: 'response.create', response: { instructions: FINISH_INSTRUCTIONS } }));
          } catch {}
        }
        else if (wantsHangup) startHangup('end_call requested');
        else if (wrapRequested && r.status === 'completed') startHangup('time-limit goodbye said');
        else if (wrapRequested && r.status !== 'completed') { log('[' + id + '] wrap-up goodbye was cut off - asking again'); wrapRequested = false; requestWrapUp(); }
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
      if (s.callSid) { callSid = s.callSid; liveCalls.set(callSid, { onAmd }); }
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
    if (callSid) liveCalls.delete(callSid);
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
