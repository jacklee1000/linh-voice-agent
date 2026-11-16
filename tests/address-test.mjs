process.env.REALTIME_NO_LISTEN = '1';
const m = await import('../server.js');
const cases = [
  ['anh hỏi em nè', 'anh'],
  ['chị muốn đặt 2 tô', 'chị'],
  ['cô cần gì không', 'cô'],
  ['chú hỏi chút', 'chú'],
  ['em muốn đặt 2 tô', null],
  ['dạ quán nghe ạ', null]
];
let pass = 0;
for (const [text, want] of cases) {
  const got = m.detectAddress(text);
  const ok = got === want;
  if (ok) pass++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + JSON.stringify(text) + ' -> ' + got + ' (want ' + want + ')');
}
console.log('detector ' + pass + '/' + cases.length);