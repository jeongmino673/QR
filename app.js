// ===== 설정 =====
const API_URL = 'https://jiyun9517.github.io/jiyun/'; // 백엔드 주소 (배포 후 https 주소로 변경)
const USE_MOCK = false; // true: 백엔드 없이 가짜 판정으로 화면 테스트 / false: 실제 API 호출

// 백엔드 응답 형식: { "label": "safe" | "caution" | "danger", "score": 0~1, "reasons": ["..."] }

const $ = id => document.getElementById(id);
const video = $('video'), canvas = $('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
let stream = null, rafId = 0, scanning = false, audioCtx = null;

const TITLES = { safe: '안전해 보여요', caution: '주의가 필요해요', danger: '위험한 링크예요' };

function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
}
const setStatus = t => { $('status').textContent = t; };

// ===== 카메라 (후면 카메라 실시간 영상, 저장 안 함) =====
async function startCamera() {
  show('scan');
  $('scan').classList.remove('busy');
  setStatus('카메라 준비 중…');
  if (!navigator.mediaDevices?.getUserMedia) {
    return setStatus('HTTPS 주소로 접속해야 카메라를 쓸 수 있어요');
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    scanning = true;
    setStatus('QR을 사각형 안에 맞춰주세요');
    tick();
  } catch (e) {
    setStatus(e.name === 'NotAllowedError' ? '카메라 권한을 허용해 주세요' : '카메라를 열 수 없어요');
  }
}

function stopCamera() {
  scanning = false;
  cancelAnimationFrame(rafId);
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  video.srcObject = null;
}

// ===== QR 자동 인식 =====
function tick() {
  if (!scanning) return;
  if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth) {
    const w = 640, h = Math.round(w * video.videoHeight / video.videoWidth);
    canvas.width = w; canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
    if (code && code.data) return onDetect(code.data);
  }
  rafId = requestAnimationFrame(tick);
}

async function onDetect(text) {
  scanning = false;
  navigator.vibrate?.(60);
  $('scan').classList.add('busy');
  setStatus('QR 인식! 분석 중…');

  let res;
  if (!/^https?:\/\//i.test(text)) {
    res = { label: 'caution', score: null, noOpen: true,
            reasons: ['URL이 아닌 QR이에요', '내용: ' + text.slice(0, 80)] };
  } else {
    try { res = await analyze(text); } catch { res = { error: true }; }
  }
  stopCamera();
  render(text, res);
}

// ===== 백엔드 연결 =====
async function analyze(url) {
  if (USE_MOCK) return mock(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: ctrl.signal
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

// 화면 테스트용 가짜 판정 (실제 AI 아님)
function mock(url) {
  const u = new URL(url), reasons = [];
  let s = 0.05;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) { s += .4; reasons.push('도메인 대신 IP 주소를 써요'); }
  if (u.protocol !== 'https:') { s += .15; reasons.push('HTTPS가 아니에요'); }
  if (url.length > 75) { s += .15; reasons.push('URL이 비정상적으로 길어요'); }
  if (url.includes('@')) { s += .25; reasons.push('주소에 @가 들어 있어요'); }
  if (/login|verify|secure|bank|update/i.test(url)) { s += .25; reasons.push('의심 키워드가 들어 있어요'); }
  s = Math.min(s, .99);
  return new Promise(ok => setTimeout(() => ok({
    label: s >= .7 ? 'danger' : s >= .35 ? 'caution' : 'safe',
    score: s,
    reasons: reasons.length ? reasons : ['의심스러운 특징이 발견되지 않았어요']
  }), 700));
}

// ===== 결과 화면 =====
function render(url, res) {
  const bad = !!res.error;
  const lv = bad ? 'caution' : res.label;
  const pct = bad || res.score == null ? 0 : Math.round(res.score * 100);
  let host = ''; try { host = new URL(url).hostname; } catch {}

  $('result').dataset.level = lv;
  $('title').textContent = bad ? '분석하지 못했어요' : (res.noOpen ? 'URL이 아니에요' : TITLES[lv]);
  $('score').textContent = bad || res.score == null ? '위험도 -' : `위험도 ${pct}%`;
  $('bar').style.width = '0';
  requestAnimationFrame(() => requestAnimationFrame(() => { $('bar').style.width = pct + '%'; }));
  $('domain').textContent = host;
  $('url').textContent = url;

  $('reasons').replaceChildren();
  (bad ? ['서버에 연결하지 못했어요. 네트워크와 API 주소를 확인해 주세요'] : res.reasons || [])
    .forEach(t => { const li = document.createElement('li'); li.textContent = t; $('reasons').append(li); });

  $('open').hidden = bad || !!res.noOpen;
  $('open').onclick = () => openLink(url, lv);
  show('result');
  if (lv === 'danger') showAlert();
}

function openLink(url, lv) {
  if (!/^https?:\/\//i.test(url)) return;
  const msg = lv === 'danger' ? '위험 판정을 받은 링크예요. 정말 열까요?'
            : lv === 'caution' ? '주의가 필요한 링크예요. 열까요?' : '이 링크를 열까요?';
  if (confirm(msg)) window.open(url, '_blank', 'noopener,noreferrer');
}

// ===== 위험 경고 (화면 + 소리 + 진동) =====
function showAlert() {
  $('alert').hidden = false;
  navigator.vibrate?.([200, 100, 200]); // iPhone Safari는 진동 미지원
  try {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'square'; o.frequency.value = 880; g.gain.value = .15;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + .45);
  } catch {}
}

// ===== 버튼 =====
$('start').onclick = () => {
  // 경고음은 사용자가 화면을 누른 시점에 오디오를 열어둬야 iPhone에서 재생돼요
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  audioCtx.resume();
  startCamera();
};
$('stop').onclick = () => { stopCamera(); show('home'); };
$('again').onclick = startCamera;
$('alert-close').onclick = () => { $('alert').hidden = true; };
