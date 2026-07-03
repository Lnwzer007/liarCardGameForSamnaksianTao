/* ==========================================================================
   ไพ่โป้ (Liar's Cards) — เล่นไพ่ให้ตรงไพ่ส่วนกลาง หรือกล้าโป้เพื่อน
   Vanilla JS + Firebase Realtime Database
   ========================================================================== */

const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const HAND_SIZE = 8;
const MAX_PLAYERS = 10;
const REVEAL_PAUSE_MS = 3800;

const JOKER = 'JOKER';       // ไพ่โจ๊กเกอร์ — เป็นไพ่อันดับไหนก็ได้ ตรงกับไพ่ส่วนกลางเสมอ
const SET_SIZE = 3;          // แต่ละ "ชุดไพ่" ที่ใช้เล่นในหนึ่งรอบใหญ่ มีกี่อันดับ (เหมือนเกม Liar's Bar ที่ใช้ Q/K/A)
// ชุดไพ่ทั้งหมดที่กำหนดไว้ล่วงหน้า — สร้างจากอันดับที่เรียงติดกันในสำรับ (2,3,4 / 3,4,5 / ... / J,Q,A) เป็นชุดๆ
const CARD_SETS = (() => {
  const sets = [];
  for (let i = 0; i + SET_SIZE <= RANKS.length; i++){
    sets.push(Array.from({ length: SET_SIZE }, (_, k) => i + k)); // เก็บเป็น index ของ RANKS
  }
  return sets;
})();

const db = firebase.database();
const auth = firebase.auth();

let myUid = null;
let myName = '';
let roomCode = null;
let isHost = false;
let roomCache = null;
let handsCache = null;
let selectedIdx = [];         // indexes selected in my hand for the next play
let roomListener = null;
let handListener = null;
let pendingWatchAttached = false;

/* ---------------------------- small utilities ---------------------------- */

function cardLabel(v){ return v === JOKER ? '🃏' : RANKS[v]; }
function isMatch(v, centerRank){ return v === JOKER || v === centerRank; } // โจ๊กเกอร์ตรงกับไพ่ส่วนกลางเสมอ

function $(id){ return document.getElementById(id); }
function showScreen(id){
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}
function toast(msg){
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove('show'), 2600);
}
function randCode(len=6){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i=0;i<len;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}
function shuffle(arr){
  for (let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i+1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

/* ------------------------------- auth boot ------------------------------- */

auth.onAuthStateChanged(user => { if (user) myUid = user.uid; else {
  auth.signInAnonymously().catch(err => { toast('เชื่อมต่อ Firebase ไม่สำเร็จ: ' + err.message); console.error(err); });
}});
function waitForAuth(){
  return new Promise(resolve => { const unsub = auth.onAuthStateChanged(u => { if (u){ unsub(); resolve(); } }); });
}

/* ============================== HOME SCREEN ============================== */

$('btn-create').addEventListener('click', async () => {
  myName = $('input-name').value.trim();
  if (!myName){ $('home-error').textContent = 'กรุณาใส่ชื่อก่อนนะ'; return; }
  if (!myUid) await waitForAuth();

  const code = randCode();
  const now = Date.now();
  try {
    await db.ref('rooms/' + code).set({ hostUid: myUid, status: 'lobby', startingLives: 3, round: 0, createdAt: now });
    await db.ref(`rooms/${code}/players/${myUid}`).set({ name: myName, lives: 3, alive: true, connected: true, joinedAt: now });
    db.ref(`rooms/${code}/players/${myUid}/connected`).onDisconnect().set(false);
    enterRoom(code, true);
  } catch (err){
    $('home-error').textContent = 'สร้างห้องไม่สำเร็จ: ' + err.message; console.error(err);
  }
});

$('btn-join').addEventListener('click', async () => {
  myName = $('input-name').value.trim();
  const code = $('input-code').value.trim().toUpperCase();
  if (!myName){ $('home-error').textContent = 'กรุณาใส่ชื่อก่อนนะ'; return; }
  if (!code){ $('home-error').textContent = 'กรุณาใส่รหัสห้อง'; return; }
  if (!myUid) await waitForAuth();

  const snap = await db.ref('rooms/' + code).get();
  if (!snap.exists()){ $('home-error').textContent = 'ไม่พบห้องรหัสนี้'; return; }
  const room = snap.val();
  if (room.status !== 'lobby'){ $('home-error').textContent = 'เกมนี้เริ่มไปแล้ว'; return; }

  const playersSnap = await db.ref(`rooms/${code}/players`).get();
  const players = playersSnap.val() || {};
  if (Object.keys(players).length >= MAX_PLAYERS){ $('home-error').textContent = 'ห้องเต็มแล้ว (สูงสุด 10 คน)'; return; }

  await db.ref(`rooms/${code}/players/${myUid}`).set({ name: myName, lives: room.startingLives || 3, alive: true, connected: true, joinedAt: Date.now() });
  db.ref(`rooms/${code}/players/${myUid}/connected`).onDisconnect().set(false);
  enterRoom(code, room.hostUid === myUid);
});

/* ================================ ROOM ================================ */

function enterRoom(code, host){
  roomCode = code; isHost = host;
  $('lobby-code').textContent = code;
  $('hud-code').textContent = code;
  $('home-error').textContent = '';
  showScreen('screen-lobby');
  attachRoomListener();
}

function attachRoomListener(){
  if (roomListener) db.ref('rooms/' + roomCode).off('value', roomListener);
  roomListener = snap => {
    const room = snap.val();
    if (!room){ toast('ห้องถูกปิดไปแล้ว'); goHome(); return; }
    roomCache = room;
    onRoomUpdate(room);
  };
  db.ref('rooms/' + roomCode).on('value', roomListener);
}

function attachHandListener(){
  if (handListener) db.ref(`rooms/${roomCode}/hands/${myUid}`).off('value', handListener);
  handListener = snap => { handsCache = snap.val() || []; renderMyHand(); };
  db.ref(`rooms/${roomCode}/hands/${myUid}`).on('value', handListener);
}

function onRoomUpdate(room){
  if (room.status === 'lobby'){
    renderLobby(room);
  } else if (room.status === 'playing' || room.status === 'revealing'){
    if (!handListener) attachHandListener();
    showScreen('screen-game');
    renderGame(room);
    if (isHost) hostWatchPendingAction();
  } else if (room.status === 'ended'){
    showScreen('screen-over');
    const winner = room.players ? room.players[room.winnerUid] : null;
    $('over-text').innerHTML = winner
      ? `👑 ผู้รอดชีวิตคนสุดท้าย: <strong style="color:var(--primary)">${escapeHtml(winner.name)}</strong>`
      : 'เกมจบแล้ว';
    renderRematch(room);
    if (isHost) hostWatchRematch();
  }
}

/* ------------------------------- LOBBY UI ------------------------------- */

function renderLobby(room){
  const players = room.players || {};
  const list = $('lobby-players');
  list.innerHTML = '';
  Object.entries(players).forEach(([uid, p]) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHtml(p.name)}${uid===room.hostUid?'<span class="pm-host">HOST</span>':''}</span>
                     <span class="muted">${p.connected===false?'ออฟไลน์':'พร้อม'}</span>`;
    list.appendChild(li);
  });
  const count = Object.keys(players).length;
  $('btn-start').disabled = !(isHost && count >= 2);
  $('btn-start').textContent = isHost ? 'เริ่มเกม' : 'เริ่มเกม (ต้องมี ≥ 2 คน)';
  $('lives-setting').style.display = isHost ? 'flex' : 'none';
  $('input-lives').value = room.startingLives || 3;
  $('lobby-wait').style.display = isHost ? 'none' : 'block';
}

$('btn-copy-code').addEventListener('click', () => {
  navigator.clipboard.writeText(roomCode).then(() => toast('คัดลอกรหัสห้องแล้ว'));
});
$('input-lives').addEventListener('change', () => {
  if (isHost && roomCode) db.ref(`rooms/${roomCode}/startingLives`).set(parseInt($('input-lives').value, 10));
});

$('btn-start').addEventListener('click', async () => {
  if (!isHost) return;
  const snap = await db.ref(`rooms/${roomCode}/players`).get();
  const players = snap.val() || {};
  const uids = Object.keys(players);
  if (uids.length < 2) return;
  const lives = roomCache.startingLives || 3;
  shuffle(uids);

  const { hands, drawPile, centerRank, total, setIndex, order, pos, setRanks } = dealNewRound(uids);
  const updates = {};
  updates[`rooms/${roomCode}/status`] = 'playing';
  updates[`rooms/${roomCode}/round`] = 1;
  updates[`rooms/${roomCode}/turnOrder`] = uids;
  updates[`rooms/${roomCode}/currentTurnIndex`] = 0;
  updates[`rooms/${roomCode}/centerRank`] = centerRank;
  updates[`rooms/${roomCode}/centerRankTotal`] = total;
  updates[`rooms/${roomCode}/cardSetIndex`] = setIndex;
  updates[`rooms/${roomCode}/cycleOrder`] = order;
  updates[`rooms/${roomCode}/cyclePos`] = pos;
  updates[`rooms/${roomCode}/pile`] = null;
  updates[`rooms/${roomCode}/secretPile`] = null;
  updates[`rooms/${roomCode}/challengeReveal`] = null;
  updates[`rooms/${roomCode}/pendingAction`] = null;
  updates[`rooms/${roomCode}/drawPile`] = drawPile;
  updates[`rooms/${roomCode}/hasDrawnThisTurn`] = false;
  uids.forEach(uid => { updates[`rooms/${roomCode}/players/${uid}/lives`] = lives; updates[`rooms/${roomCode}/players/${uid}/alive`] = true; });
  updates[`rooms/${roomCode}/hands`] = hands;
  updates[`rooms/${roomCode}/log`] = { [Date.now()]: { text: `🎮 เกมเริ่ม! ชุดไพ่รอบนี้: ${setRanks.map(r=>RANKS[r]).join(', ')} + 🃏 โจ๊กเกอร์ · แจกคนละ ${HAND_SIZE} ใบ เหลือ ${drawPile.length} ใบในกองจั่ว`, type:'info', ts: Date.now() } };

  await db.ref().update(updates);
});

$('btn-leave-lobby').addEventListener('click', () => leaveRoom());
$('btn-leave-game').addEventListener('click', () => leaveRoom());
$('btn-leave-over').addEventListener('click', () => leaveRoom());

/* ------------------------------ REMATCH VOTING ------------------------------ */

function renderRematch(room){
  const players = room.players || {};
  const votes = room.rematchVotes || {};
  const uids = Object.keys(players);

  const list = $('rematch-list');
  list.innerHTML = '';
  uids.forEach(uid => {
    const p = players[uid];
    const voted = !!votes[uid];
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHtml(p.name)}${uid===myUid?' (คุณ)':''}</span><span>${voted ? '✅ โหวตแล้ว' : '⏳ รอโหวต'}</span>`;
    list.appendChild(li);
  });

  const votedCount = uids.filter(uid => votes[uid]).length;
  $('rematch-progress').textContent = `${votedCount} / ${uids.length} คนโหวตแล้ว`;
  $('btn-rematch').textContent = votes[myUid] ? '✅ ยกเลิกโหวต' : '🔄 โหวตเล่นอีกครั้ง';
}

$('btn-rematch').addEventListener('click', () => {
  if (!roomCode || !myUid || !roomCache) return;
  const already = !!(roomCache.rematchVotes && roomCache.rematchVotes[myUid]);
  db.ref(`rooms/${roomCode}/rematchVotes/${myUid}`).set(already ? null : true);
});

let rematchWatchAttached = false;
function hostWatchRematch(){
  if (rematchWatchAttached) return;
  rematchWatchAttached = true;
  db.ref(`rooms/${roomCode}/rematchVotes`).on('value', snap => {
    const room = roomCache;
    if (!room || room.status !== 'ended') return;
    const votes = snap.val() || {};
    const players = room.players || {};
    const uids = Object.keys(players);
    if (uids.length >= 2 && uids.every(uid => votes[uid])){
      restartGame(uids).catch(err => console.error(err));
    }
  });
}

async function restartGame(uids){
  const snap = await db.ref('rooms/' + roomCode).get();
  const room = snap.val();
  if (!room || room.status !== 'ended') return; // กันไม่ให้รันซ้ำ

  const lives = room.startingLives || 3;
  shuffle(uids);
  const { hands, drawPile, centerRank, total, setIndex, order, pos, setRanks } = dealNewRound(uids);

  const updates = {};
  updates[`rooms/${roomCode}/status`] = 'playing';
  updates[`rooms/${roomCode}/round`] = 1;
  updates[`rooms/${roomCode}/turnOrder`] = uids;
  updates[`rooms/${roomCode}/currentTurnIndex`] = 0;
  updates[`rooms/${roomCode}/centerRank`] = centerRank;
  updates[`rooms/${roomCode}/centerRankTotal`] = total;
  updates[`rooms/${roomCode}/cardSetIndex`] = setIndex;
  updates[`rooms/${roomCode}/cycleOrder`] = order;
  updates[`rooms/${roomCode}/cyclePos`] = pos;
  updates[`rooms/${roomCode}/pile`] = null;
  updates[`rooms/${roomCode}/secretPile`] = null;
  updates[`rooms/${roomCode}/challengeReveal`] = null;
  updates[`rooms/${roomCode}/pendingAction`] = null;
  updates[`rooms/${roomCode}/rematchVotes`] = null;
  updates[`rooms/${roomCode}/winnerUid`] = null;
  updates[`rooms/${roomCode}/drawPile`] = drawPile;
  updates[`rooms/${roomCode}/hasDrawnThisTurn`] = false;
  uids.forEach(uid => { updates[`rooms/${roomCode}/players/${uid}/lives`] = lives; updates[`rooms/${roomCode}/players/${uid}/alive`] = true; });
  updates[`rooms/${roomCode}/hands`] = hands;
  updates[`rooms/${roomCode}/log`] = { [Date.now()]: { text: `🔄 เริ่มเกมใหม่! ชุดไพ่รอบนี้: ${setRanks.map(r=>RANKS[r]).join(', ')} + 🃏 โจ๊กเกอร์ · แจกคนละ ${HAND_SIZE} ใบ เหลือ ${drawPile.length} ใบในกองจั่ว`, type:'info', ts: Date.now() } };

  await db.ref().update(updates);
}

function leaveRoom(){
  if (roomCode && myUid) db.ref(`rooms/${roomCode}/players/${myUid}`).remove();
  goHome();
}
function goHome(){
  if (roomListener) db.ref('rooms/' + roomCode).off('value', roomListener);
  if (handListener) db.ref(`rooms/${roomCode}/hands/${myUid}`).off('value', handListener);
  roomListener = handListener = null;
  pendingWatchAttached = false;
  rematchWatchAttached = false;
  roomCode = null; isHost = false; roomCache = null; handsCache = null; selectedIdx = [];
  showScreen('screen-home');
}

/* ------------------------------- DEALING ------------------------------- */

function dealHands(uids, activeRanks){
  const n = uids.length;
  const pool = [];
  activeRanks.forEach(rankIdx => { for (let k=0; k<n*4; k++) pool.push(rankIdx); }); // ชุดไพ่มีแค่ไม่กี่อันดับ เลยใส่สำเนาต่ออันดับให้เยอะขึ้น
  const jokerCount = Math.max(2, Math.ceil(n/2));
  for (let k=0; k<jokerCount; k++) pool.push(JOKER); // แถมโจ๊กเกอร์ เป็นไพ่อันดับไหนก็ได้
  shuffle(pool);
  const hands = {};
  let cursor = 0;
  uids.forEach(uid => { hands[uid] = pool.slice(cursor, cursor + HAND_SIZE); cursor += HAND_SIZE; });
  const drawPile = pool.slice(cursor); // ไพ่ที่เหลือทั้งหมดกลายเป็นกองจั่วกลางโต๊ะ
  return { hands, drawPile };
}

// หมุนไพ่ส่วนกลางไปทีละอันดับภายใน "ชุด" เดิม พอครบทุกอันดับในชุดแล้ว (ครบรอบ) ค่อยสลับไปชุดอื่นที่ตั้งไว้ล่วงหน้า
function advanceCycle(prevSetIndex, prevOrder, prevPos){
  let setIndex = prevSetIndex, order = prevOrder, pos = prevPos;
  const needNewSet = setIndex === undefined || order === undefined || pos === undefined || pos + 1 >= order.length;
  if (needNewSet){
    let nextIndex;
    do { nextIndex = Math.floor(Math.random() * CARD_SETS.length); }
    while (CARD_SETS.length > 1 && nextIndex === setIndex);
    setIndex = nextIndex;
    order = shuffle([...CARD_SETS[setIndex]]);
    pos = 0;
  } else {
    pos = pos + 1;
  }
  return { setIndex, order, pos, centerRank: order[pos] };
}

// นับว่าทั้ง "มือทุกคน + กองจั่ว" รวมกันมีไพ่ที่ถือว่า "ตรง" กับไพ่ส่วนกลางกี่ใบ (นับโจ๊กเกอร์รวมด้วย เพราะตรงเสมอ)
function computeCenterTotal(hands, drawPile, centerRank){
  let total = 0;
  Object.values(hands).forEach(h => { total += h.filter(v => isMatch(v, centerRank)).length; });
  total += (drawPile || []).filter(v => isMatch(v, centerRank)).length;
  return total;
}

// รวมทุกอย่างของการเริ่มรอบใหม่ไว้ที่เดียว: หมุนไปไพ่ชุด/อันดับถัดไป แล้วแจกไพ่จากชุดนั้น (+โจ๊กเกอร์) ให้ผู้เล่นที่เหลือ
function dealNewRound(uids, prevSetIndex, prevOrder, prevPos){
  const { setIndex, order, pos, centerRank } = advanceCycle(prevSetIndex, prevOrder, prevPos);
  const setRanks = CARD_SETS[setIndex];
  const { hands, drawPile } = dealHands(uids, setRanks);
  const total = computeCenterTotal(hands, drawPile, centerRank);
  return { hands, drawPile, centerRank, total, setIndex, order, pos, setRanks };
}

// หาว่าตาถัดไปควรเป็นใคร โดยข้าม "คนที่เพิ่งโดนยิง" ไปเลย ให้เริ่มที่คนถัดไปจากเขาแทน
function findNextStarter(oldOrder, aliveUids, loserUid){
  const n = oldOrder.length;
  const loserPos = oldOrder.indexOf(loserUid);
  for (let step = 1; step <= n; step++){
    const uid = oldOrder[(loserPos + step) % n];
    if (aliveUids.includes(uid)) return aliveUids.indexOf(uid);
  }
  return 0;
}

/* ------------------------------- GAME UI ------------------------------- */

function renderGame(room){
  $('hud-round').textContent = room.round || 1;

  const players = room.players || {};
  const order = room.turnOrder || Object.keys(players);
  const curUid = order[room.currentTurnIndex] || null;
  const myTurn = curUid === myUid && room.status === 'playing';

  // players rail
  const rail = $('game-players');
  rail.innerHTML = '';
  order.forEach(uid => {
    const p = players[uid]; if (!p) return;
    const li = document.createElement('li');
    li.className = (uid === curUid ? 'pm-turn ' : '') + (!p.alive ? 'pm-dead' : '');
    li.innerHTML = `<span>${escapeHtml(p.name)}${uid===myUid?' (คุณ)':''}</span><span class="pm-lives">${'❤️'.repeat(Math.max(p.lives,0))}</span>`;
    rail.appendChild(li);
  });

  // center card + pile
  $('center-card').textContent = room.centerRank !== undefined ? RANKS[room.centerRank] : '?';
  $('center-total').textContent = room.centerRankTotal !== undefined
    ? `รวมทั้งเกม (มือทุกคน + กองจั่ว) มีไพ่ที่นับว่าตรง ${room.centerRankTotal} ใบ (รวมโจ๊กเกอร์)`
    : '';
  const setRanks = room.cardSetIndex !== undefined ? CARD_SETS[room.cardSetIndex] : null;
  $('active-set-info').textContent = setRanks
    ? `ชุดไพ่รอบนี้: ${setRanks.map(r => RANKS[r]).join(', ')} + 🃏 โจ๊กเกอร์ (มือ/กองจั่วมีแค่ไพ่พวกนี้)`
    : '';
  const pile = room.pile;
  $('pile-info').textContent = pile ? `${pile.ownerName} เล่นไปแล้ว ${pile.count} ใบ (ปิดหน้า)` : 'ยังไม่มีใครเล่นไพ่ในรอบนี้';

  // draw pile
  const drawPile = room.drawPile || [];
  $('draw-remaining').textContent = drawPile.length;
  $('draw-info').textContent = drawPile.length > 0
    ? `เหลือไพ่ในกองจั่ว ${drawPile.length} ใบ`
    : 'กองจั่วหมดแล้ว';

  // status banner
  const curPlayer = players[curUid];
  $('status-banner').textContent = room.status === 'playing'
    ? (myTurn ? 'ตาของคุณ! เลือกไพ่ที่จะเล่น หรือกดโป้' : `รอ ${curPlayer ? curPlayer.name : '...'} ตัดสินใจ`)
    : (room.status === 'revealing' ? 'กำลังเปิดไพ่พิสูจน์...' : '');

  // reveal box
  if (room.status === 'revealing' && room.challengeReveal){
    renderReveal(room);
  } else {
    $('reveal-box').classList.add('hidden');
  }

  // log
  renderLog(room.log);

  // action panel
  const showActions = room.status === 'playing';
  $('action-panel').classList.toggle('hidden', !showActions);
  if (showActions){
    $('btn-liar').disabled = !myTurn || !pile;
    $('btn-draw').disabled = !myTurn || !!room.hasDrawnThisTurn || drawPile.length === 0;
    updatePlayButtonState();
  }

  renderMyHand();
}

function renderReveal(room){
  const box = $('reveal-box'); box.classList.remove('hidden');
  const ch = room.challengeReveal;
  const list = $('reveal-cards'); list.innerHTML = '';
  ch.ranks.forEach(r => {
    const div = document.createElement('div');
    const match = isMatch(r, room.centerRank);
    div.className = 'mini-card ' + (match ? 'match' : 'mismatch') + (r === JOKER ? ' wild' : '');
    div.textContent = cardLabel(r);
    list.appendChild(div);
  });
  $('reveal-result').textContent = ch.resultText || '';
}

function renderMyHand(){
  const el = $('my-hand');
  el.innerHTML = '';
  (handsCache || []).forEach((v, i) => {
    const c = document.createElement('div');
    c.className = 'hand-card' + (selectedIdx.includes(i) ? ' selected' : '') + (v === JOKER ? ' wild' : '');
    c.textContent = cardLabel(v);
    if (v === JOKER) c.title = 'โจ๊กเกอร์ — นับเป็นไพ่อันดับไหนก็ได้';
    c.addEventListener('click', () => toggleSelect(i));
    el.appendChild(c);
  });
}

function toggleSelect(i){
  const room = roomCache;
  const order = room.turnOrder || [];
  const curUid = order[room.currentTurnIndex];
  if (curUid !== myUid || room.status !== 'playing') return; // ไม่ใช่ตาเรา เลือกไม่ได้
  const pos = selectedIdx.indexOf(i);
  if (pos === -1) selectedIdx.push(i); else selectedIdx.splice(pos, 1);
  renderMyHand();
  updatePlayButtonState();
}

function updatePlayButtonState(){
  $('selected-count').textContent = selectedIdx.length;
  const room = roomCache;
  const order = room.turnOrder || [];
  const curUid = order[room.currentTurnIndex];
  const myTurn = curUid === myUid && room.status === 'playing';
  $('btn-play').disabled = !myTurn || selectedIdx.length === 0;
}

function renderLog(logObj){
  const list = $('game-log');
  list.innerHTML = '';
  const entries = Object.values(logObj || {}).sort((a,b) => a.ts - b.ts);
  entries.forEach(e => {
    const li = document.createElement('li');
    if (e.type === 'danger') li.className = 'log-danger';
    if (e.type === 'win') li.className = 'log-win';
    li.textContent = e.text;
    list.appendChild(li);
  });
}

/* ------------------------------ PLAYER ACTIONS ------------------------------ */

$('btn-play').addEventListener('click', () => {
  if (selectedIdx.length === 0) return;
  db.ref(`rooms/${roomCode}/pendingAction`).set({ type:'play', uid: myUid, indexes: [...selectedIdx].sort((a,b)=>a-b), ts: Date.now() });
  selectedIdx = [];
});

$('btn-liar').addEventListener('click', () => {
  db.ref(`rooms/${roomCode}/pendingAction`).set({ type:'liar', uid: myUid, ts: Date.now() });
});

$('btn-draw').addEventListener('click', () => {
  db.ref(`rooms/${roomCode}/pendingAction`).set({ type:'draw', uid: myUid, ts: Date.now() });
});

/* ------------------------------ HOST REFEREE LOGIC ------------------------------ */

function hostWatchPendingAction(){
  if (pendingWatchAttached) return;
  pendingWatchAttached = true;
  db.ref(`rooms/${roomCode}/pendingAction`).on('value', snap => {
    const action = snap.val();
    if (!action || !roomCache) return;
    processPendingAction(action).catch(err => console.error(err));
  });
}

function nextAliveIndex(order, fromIndex, players){
  const n = order.length;
  for (let step=1; step<=n; step++){
    const idx = (fromIndex + step) % n;
    if (players[order[idx]] && players[order[idx]].alive) return idx;
  }
  return fromIndex;
}

async function processPendingAction(action){
  const room = roomCache;
  if (room.status !== 'playing') return;
  const order = room.turnOrder || [];
  const curUid = order[room.currentTurnIndex];
  if (action.uid !== curUid){ db.ref(`rooms/${roomCode}/pendingAction`).remove(); return; }

  if (action.type === 'play'){
    const handSnap = await db.ref(`rooms/${roomCode}/hands/${action.uid}`).get();
    const hand = handSnap.val() || [];
    const idxSet = [...new Set(action.indexes)].filter(i => i >=0 && i < hand.length);
    if (idxSet.length === 0){ db.ref(`rooms/${roomCode}/pendingAction`).remove(); return; }

    const playedRanks = idxSet.map(i => hand[i]);
    const remainingHand = hand.filter((_, i) => !idxSet.includes(i));
    const p = room.players[action.uid];
    const nextIndex = nextAliveIndex(order, room.currentTurnIndex, room.players);

    const updates = {};
    updates[`rooms/${roomCode}/hands/${action.uid}`] = remainingHand;
    updates[`rooms/${roomCode}/secretPile`] = { ranks: playedRanks, ownerUid: action.uid, ownerName: p.name };
    updates[`rooms/${roomCode}/pile`] = { ownerUid: action.uid, ownerName: p.name, count: playedRanks.length };
    updates[`rooms/${roomCode}/currentTurnIndex`] = nextIndex;
    updates[`rooms/${roomCode}/pendingAction`] = null;
    updates[`rooms/${roomCode}/hasDrawnThisTurn`] = false; // ตาถัดไป จั่วได้ใหม่อีกครั้ง
    updates[`rooms/${roomCode}/log/${Date.now()}`] = { text: `${p.name} เล่นไพ่ไป ${playedRanks.length} ใบ (ปิดหน้า)`, type:'info', ts: Date.now() };
    await db.ref().update(updates);
  }

  if (action.type === 'draw'){
    const drawPile = room.drawPile || [];
    if (room.hasDrawnThisTurn || drawPile.length === 0){ db.ref(`rooms/${roomCode}/pendingAction`).remove(); return; }

    const handSnap = await db.ref(`rooms/${roomCode}/hands/${action.uid}`).get();
    const hand = handSnap.val() || [];
    const newDrawPile = [...drawPile];
    const drawnRank = newDrawPile.pop(); // จั่วจากด้านบนกอง
    const p = room.players[action.uid];

    const updates = {};
    updates[`rooms/${roomCode}/hands/${action.uid}`] = [...hand, drawnRank];
    updates[`rooms/${roomCode}/drawPile`] = newDrawPile;
    updates[`rooms/${roomCode}/hasDrawnThisTurn`] = true;
    updates[`rooms/${roomCode}/pendingAction`] = null;
    updates[`rooms/${roomCode}/log/${Date.now()}`] = { text: `${p.name} จั่วไพ่จากกองกลาง 1 ใบ (ปิดหน้า)`, type:'info', ts: Date.now() };
    await db.ref().update(updates);
  }

  if (action.type === 'liar'){
    const pile = room.pile;
    if (!pile){ db.ref(`rooms/${roomCode}/pendingAction`).remove(); return; }
    const secretSnap = await db.ref(`rooms/${roomCode}/secretPile`).get();
    const secret = secretSnap.val();
    const caller = room.players[action.uid];
    const centerRank = room.centerRank;
    const allMatch = secret.ranks.every(r => isMatch(r, centerRank));
    const loserUid = allMatch ? action.uid : secret.ownerUid;
    const loser = room.players[loserUid];
    const newLives = Math.max(loser.lives - 1, 0);
    const eliminated = newLives === 0;

    const resultText = allMatch
      ? `เปิดไพ่: ตรงไพ่ส่วนกลางจริงทุกใบ! ${caller.name} โป้พลาด เสียชีวิต 1 ดวง`
      : `เปิดไพ่: มีไพ่ไม่ตรง! ${secret.ownerName} โป้จริง เสียชีวิต 1 ดวง`;

    const updates = {};
    updates[`rooms/${roomCode}/status`] = 'revealing';
    updates[`rooms/${roomCode}/challengeReveal`] = { ranks: secret.ranks, ownerUid: secret.ownerUid, ownerName: secret.ownerName, callerUid: action.uid, callerName: caller.name, resultText };
    updates[`rooms/${roomCode}/players/${loserUid}/lives`] = newLives;
    updates[`rooms/${roomCode}/players/${loserUid}/alive`] = !eliminated;
    updates[`rooms/${roomCode}/pendingAction`] = null;
    updates[`rooms/${roomCode}/log/${Date.now()}`] = { text: `🔫 ${caller.name} กดโป้ใส่ ${secret.ownerName}! ${resultText}`, type:'danger', ts: Date.now() };
    if (eliminated){
      updates[`rooms/${roomCode}/log/${Date.now()+1}`] = { text: `💀 ${loser.name} หมดชีวิต ออกจากเกม!`, type:'danger', ts: Date.now()+1 };
    }
    await db.ref().update(updates);

    setTimeout(() => finishRound(loserUid, eliminated).catch(err => console.error(err)), REVEAL_PAUSE_MS);
  }
}

async function finishRound(loserUid, eliminated){
  const snap = await db.ref('rooms/' + roomCode).get();
  const room = snap.val();
  if (!room || room.status !== 'revealing') return;

  const order = room.turnOrder || [];
  const aliveUids = order.filter(uid => uid === loserUid ? !eliminated : (room.players[uid] && room.players[uid].alive));

  const updates = {};
  if (aliveUids.length <= 1){
    updates[`rooms/${roomCode}/status`] = 'ended';
    updates[`rooms/${roomCode}/winnerUid`] = aliveUids[0] || null;
    updates[`rooms/${roomCode}/log/${Date.now()}`] = { text: `🏆 ${aliveUids[0] ? room.players[aliveUids[0]].name : 'ไม่มีใคร'} คือผู้รอดชีวิตคนสุดท้าย!`, type:'win', ts: Date.now() };
  } else {
    const { hands, drawPile, centerRank, total, setIndex, order: cycleOrder, pos, setRanks } =
      dealNewRound(aliveUids, room.cardSetIndex, room.cycleOrder, room.cyclePos);
    const nextIdx = findNextStarter(order, aliveUids, loserUid);
    updates[`rooms/${roomCode}/status`] = 'playing';
    updates[`rooms/${roomCode}/round`] = (room.round || 1) + 1;
    updates[`rooms/${roomCode}/turnOrder`] = aliveUids;
    updates[`rooms/${roomCode}/currentTurnIndex`] = nextIdx;
    updates[`rooms/${roomCode}/centerRank`] = centerRank;
    updates[`rooms/${roomCode}/centerRankTotal`] = total;
    updates[`rooms/${roomCode}/cardSetIndex`] = setIndex;
    updates[`rooms/${roomCode}/cycleOrder`] = cycleOrder;
    updates[`rooms/${roomCode}/cyclePos`] = pos;
    updates[`rooms/${roomCode}/pile`] = null;
    updates[`rooms/${roomCode}/secretPile`] = null;
    updates[`rooms/${roomCode}/challengeReveal`] = null;
    updates[`rooms/${roomCode}/hands`] = hands;
    updates[`rooms/${roomCode}/drawPile`] = drawPile;
    updates[`rooms/${roomCode}/hasDrawnThisTurn`] = false;
    const isNewSet = setIndex !== room.cardSetIndex;
    if (isNewSet){
      updates[`rooms/${roomCode}/log/${Date.now()+1}`] = { text: `🔀 หมุนครบชุดเดิมแล้ว เปลี่ยนไปชุดไพ่ใหม่: ${setRanks.map(r=>RANKS[r]).join(', ')} + 🃏`, type:'info', ts: Date.now()+1 };
    }
  }
  await db.ref().update(updates);
}