/* ==========================================================================
   ไพ่โป้ (Liar's Cards) — เล่นไพ่ให้ตรงไพ่ส่วนกลาง หรือกล้าโป้เพื่อน
   Vanilla JS + Firebase Realtime Database
   ========================================================================== */

const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const HAND_SIZE = 5;
const MAX_PLAYERS = 10;
const REVEAL_PAUSE_MS = 3800;

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

  const { hands } = dealHands(uids);
  const updates = {};
  updates[`rooms/${roomCode}/status`] = 'playing';
  updates[`rooms/${roomCode}/round`] = 1;
  updates[`rooms/${roomCode}/turnOrder`] = uids;
  updates[`rooms/${roomCode}/currentTurnIndex`] = 0;
  updates[`rooms/${roomCode}/centerRank`] = Math.floor(Math.random() * RANKS.length);
  updates[`rooms/${roomCode}/pile`] = null;
  updates[`rooms/${roomCode}/secretPile`] = null;
  updates[`rooms/${roomCode}/challengeReveal`] = null;
  updates[`rooms/${roomCode}/pendingAction`] = null;
  uids.forEach(uid => { updates[`rooms/${roomCode}/players/${uid}/lives`] = lives; updates[`rooms/${roomCode}/players/${uid}/alive`] = true; });
  updates[`rooms/${roomCode}/hands`] = hands;
  updates[`rooms/${roomCode}/log`] = { [Date.now()]: { text: `🎮 เกมเริ่ม! แจกไพ่คนละ ${HAND_SIZE} ใบ`, type:'info', ts: Date.now() } };

  await db.ref().update(updates);
});

$('btn-leave-lobby').addEventListener('click', () => leaveRoom());
$('btn-leave-game').addEventListener('click', () => leaveRoom());
$('btn-play-again').addEventListener('click', () => goHome());

function leaveRoom(){
  if (roomCode && myUid) db.ref(`rooms/${roomCode}/players/${myUid}`).remove();
  goHome();
}
function goHome(){
  if (roomListener) db.ref('rooms/' + roomCode).off('value', roomListener);
  if (handListener) db.ref(`rooms/${roomCode}/hands/${myUid}`).off('value', handListener);
  roomListener = handListener = null;
  pendingWatchAttached = false;
  roomCode = null; isHost = false; roomCache = null; handsCache = null; selectedIdx = [];
  showScreen('screen-home');
}

/* ------------------------------- DEALING ------------------------------- */

function dealHands(uids){
  const n = uids.length;
  const pool = [];
  RANKS.forEach((r, i) => { for (let k=0; k<n*2; k++) pool.push(i); });
  shuffle(pool);
  const hands = {};
  let cursor = 0;
  uids.forEach(uid => { hands[uid] = pool.slice(cursor, cursor + HAND_SIZE); cursor += HAND_SIZE; });
  return { hands };
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
  const pile = room.pile;
  $('pile-info').textContent = pile ? `${pile.ownerName} เล่นไปแล้ว ${pile.count} ใบ (ปิดหน้า)` : 'ยังไม่มีใครเล่นไพ่ในรอบนี้';

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
    const match = r === room.centerRank;
    div.className = 'mini-card ' + (match ? 'match' : 'mismatch');
    div.textContent = RANKS[r];
    list.appendChild(div);
  });
  $('reveal-result').textContent = ch.resultText || '';
}

function renderMyHand(){
  const el = $('my-hand');
  el.innerHTML = '';
  (handsCache || []).forEach((rankIdx, i) => {
    const c = document.createElement('div');
    c.className = 'hand-card' + (selectedIdx.includes(i) ? ' selected' : '');
    c.textContent = RANKS[rankIdx];
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
    updates[`rooms/${roomCode}/log/${Date.now()}`] = { text: `${p.name} เล่นไพ่ไป ${playedRanks.length} ใบ (ปิดหน้า)`, type:'info', ts: Date.now() };
    await db.ref().update(updates);
  }

  if (action.type === 'liar'){
    const pile = room.pile;
    if (!pile){ db.ref(`rooms/${roomCode}/pendingAction`).remove(); return; }
    const secretSnap = await db.ref(`rooms/${roomCode}/secretPile`).get();
    const secret = secretSnap.val();
    const caller = room.players[action.uid];
    const centerRank = room.centerRank;
    const allMatch = secret.ranks.every(r => r === centerRank);
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
    const { hands } = dealHands(aliveUids);
    let nextIdx = aliveUids.indexOf(loserUid);
    if (nextIdx === -1) nextIdx = 0;
    updates[`rooms/${roomCode}/status`] = 'playing';
    updates[`rooms/${roomCode}/round`] = (room.round || 1) + 1;
    updates[`rooms/${roomCode}/turnOrder`] = aliveUids;
    updates[`rooms/${roomCode}/currentTurnIndex`] = nextIdx;
    updates[`rooms/${roomCode}/centerRank`] = Math.floor(Math.random() * RANKS.length);
    updates[`rooms/${roomCode}/pile`] = null;
    updates[`rooms/${roomCode}/secretPile`] = null;
    updates[`rooms/${roomCode}/challengeReveal`] = null;
    updates[`rooms/${roomCode}/hands`] = hands;
  }
  await db.ref().update(updates);
}