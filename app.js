/* ==========================================================================
   Liar's Cards — Ship of Deceit
   Vanilla JS + Firebase Realtime Database (no build step, GitHub Pages ready)
   ========================================================================== */

const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const HAND_SIZE = 5;
const MAX_PLAYERS = 10;

const db = firebase.database();
const auth = firebase.auth();

let myUid = null;
let myName = '';
let roomCode = null;
let isHost = false;
let roomCache = null;
let handsCache = null;
let roomListener = null;
let handListener = null;

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

/* ------------------------------- auth boot ------------------------------- */

auth.onAuthStateChanged(user => {
  if (user){
    myUid = user.uid;
  } else {
    auth.signInAnonymously().catch(err => {
      toast('เชื่อมต่อ Firebase ไม่สำเร็จ: ' + err.message);
      console.error(err);
    });
  }
});

/* ============================== HOME SCREEN ============================== */

$('btn-create').addEventListener('click', async () => {
  myName = $('input-name').value.trim();
  if (!myName){ $('home-error').textContent = 'กรุณาใส่ชื่อกัปตันก่อนนะ'; return; }
  if (!myUid) await waitForAuth();

  const code = randCode();
  const roomRef = db.ref('rooms/' + code);
  const now = Date.now();

  try {
    await roomRef.set({
      hostUid: myUid,
      status: 'lobby',
      startingLives: 3,
      round: 0,
      createdAt: now
    });
    await db.ref(`rooms/${code}/players/${myUid}`).set({
      name: myName, lives: 3, alive: true, connected: true, joinedAt: now
    });
    db.ref(`rooms/${code}/players/${myUid}/connected`).onDisconnect().set(false);
    enterRoom(code, true);
  } catch (err){
    $('home-error').textContent = 'สร้างเรือไม่สำเร็จ: ' + err.message;
    console.error(err);
  }
});

$('btn-join').addEventListener('click', async () => {
  myName = $('input-name').value.trim();
  const code = $('input-code').value.trim().toUpperCase();
  if (!myName){ $('home-error').textContent = 'กรุณาใส่ชื่อกัปตันก่อนนะ'; return; }
  if (!code){ $('home-error').textContent = 'กรุณาใส่รหัสเรือ'; return; }
  if (!myUid) await waitForAuth();

  const snap = await db.ref('rooms/' + code).get();
  if (!snap.exists()){ $('home-error').textContent = 'ไม่พบเรือรหัสนี้'; return; }
  const room = snap.val();
  if (room.status !== 'lobby'){ $('home-error').textContent = 'เรือลำนี้ออกเดินทางไปแล้ว'; return; }

  const playersSnap = await db.ref(`rooms/${code}/players`).get();
  const players = playersSnap.val() || {};
  if (Object.keys(players).length >= MAX_PLAYERS){
    $('home-error').textContent = 'เรือเต็มแล้ว (สูงสุด 10 คน)'; return;
  }

  await db.ref(`rooms/${code}/players/${myUid}`).set({
    name: myName, lives: room.startingLives || 3, alive: true, connected: true, joinedAt: Date.now()
  });
  db.ref(`rooms/${code}/players/${myUid}/connected`).onDisconnect().set(false);
  enterRoom(code, room.hostUid === myUid);
});

function waitForAuth(){
  return new Promise(resolve => {
    const unsub = auth.onAuthStateChanged(u => { if (u){ unsub(); resolve(); } });
  });
}

/* ================================ ROOM ================================ */

function enterRoom(code, host){
  roomCode = code;
  isHost = host;
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
  handListener = snap => {
    handsCache = snap.val() || [];
    renderMyHand();
  };
  db.ref(`rooms/${roomCode}/hands/${myUid}`).on('value', handListener);
}

function onRoomUpdate(room){
  if (room.status === 'lobby'){
    renderLobby(room);
  } else if (room.status === 'playing' || room.status === 'revealing'){
    if (!handListener) attachHandListener();
    showScreen('screen-game');
    renderGame(room);
    if (room.status === 'revealing') handleRevealing(room);
    else $('challenge-reveal').classList.add('hidden');
    if (isHost) hostWatchPendingAction(room);
  } else if (room.status === 'ended'){
    showScreen('screen-over');
    const winner = room.players ? room.players[room.winnerUid] : null;
    $('over-text').innerHTML = winner
      ? `👑 ผู้รอดชีวิตคนสุดท้าย: <strong style="color:var(--brass-bright)">${escapeHtml(winner.name)}</strong>`
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
    li.innerHTML = `<span><span class="pm-name">${escapeHtml(p.name)}</span>${uid===room.hostUid?'<span class="pm-host-tag">HOST</span>':''}</span>
                     <span class="muted">${p.connected===false?'ออฟไลน์':'พร้อม'}</span>`;
    list.appendChild(li);
  });

  const count = Object.keys(players).length;
  $('btn-start').disabled = !(isHost && count >= 2);
  $('btn-start').textContent = isHost ? 'เริ่มออกเรือ' : 'เริ่มออกเรือ (ต้องมี ≥ 2 คน)';
  $('lives-setting').style.display = isHost ? 'block' : 'none';
  $('input-lives').value = room.startingLives || 3;
  $('lobby-wait').style.display = isHost ? 'none' : 'block';
}

$('btn-copy-code').addEventListener('click', () => {
  navigator.clipboard.writeText(roomCode).then(() => toast('คัดลอกรหัสเรือแล้ว'));
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
  const { hands, totalCards } = dealHands(uids);

  const updates = {};
  updates[`rooms/${roomCode}/status`] = 'playing';
  updates[`rooms/${roomCode}/round`] = 1;
  updates[`rooms/${roomCode}/turnOrder`] = uids;
  updates[`rooms/${roomCode}/currentTurnIndex`] = 0;
  updates[`rooms/${roomCode}/currentBid`] = null;
  updates[`rooms/${roomCode}/pendingAction`] = null;
  updates[`rooms/${roomCode}/challenge`] = null;
  updates[`rooms/${roomCode}/totalCardsInPlay`] = totalCards;
  uids.forEach(uid => { updates[`rooms/${roomCode}/players/${uid}/lives`] = lives; updates[`rooms/${roomCode}/players/${uid}/alive`] = true; });
  updates[`rooms/${roomCode}/hands`] = hands;
  updates[`rooms/${roomCode}/log`] = { [Date.now()]: { text: `⚓ เรือออกเดินทาง! แจกไพ่คนละ ${HAND_SIZE} ใบ`, type: 'info', ts: Date.now() } };

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
  roomCode = null; isHost = false; roomCache = null; handsCache = null;
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
  uids.forEach(uid => {
    hands[uid] = pool.slice(cursor, cursor + HAND_SIZE);
    cursor += HAND_SIZE;
  });
  return { hands, totalCards: n * HAND_SIZE };
}

/* ------------------------------- GAME UI ------------------------------- */

function renderGame(room){
  $('hud-round').textContent = room.round || 1;
  $('hud-total-cards').textContent = room.totalCardsInPlay || 0;

  // players rail
  const players = room.players || {};
  const order = room.turnOrder || Object.keys(players);
  const curUid = order[room.currentTurnIndex] || null;
  const rail = $('game-players');
  rail.innerHTML = '';
  order.forEach(uid => {
    const p = players[uid]; if (!p) return;
    const li = document.createElement('li');
    li.className = (uid === curUid ? 'pm-turn ' : '') + (!p.alive ? 'pm-dead' : '');
    li.innerHTML = `<span class="pm-name">${escapeHtml(p.name)}${uid===myUid?' (คุณ)':''}</span><span class="pm-lives">${'♥'.repeat(Math.max(p.lives,0))}</span>`;
    rail.appendChild(li);
  });

  // bid stage
  const bid = room.currentBid;
  $('current-bid').textContent = bid ? `${bid.count} × ${RANKS[bid.rank]}` : 'ยังไม่มีใครกล่าวอ้าง';
  const curPlayer = players[curUid];
  const myTurn = curUid === myUid && room.status === 'playing';
  $('turn-indicator').textContent = room.status === 'playing'
    ? (myTurn ? 'ตาของคุณ!' : `รอ ${curPlayer ? curPlayer.name : '...'} ตัดสินใจ`)
    : '';

  // log
  renderLog(room.log);

  // action panel
  $('action-panel').style.display = room.status === 'playing' ? 'flex' : 'none';
  if (room.status === 'playing'){
    populateBidControls(bid, room.totalCardsInPlay || 50);
    $('btn-bid').disabled = !myTurn;
    $('btn-liar').disabled = !myTurn || !bid;
  }

  renderMyHand();
}

function populateBidControls(currentBid, maxCount){
  const rankSel = $('bid-rank'), countSel = $('bid-count');
  if (rankSel.dataset.built !== '1'){
    RANKS.forEach((r,i) => { const o = document.createElement('option'); o.value=i; o.textContent=r; rankSel.appendChild(o); });
    rankSel.dataset.built = '1';
  }
  countSel.innerHTML = '';
  for (let c=1; c<=maxCount; c++){ const o=document.createElement('option'); o.value=c; o.textContent=c; countSel.appendChild(o); }

  if (currentBid){
    // default to the minimum legal raise
    let rank = currentBid.rank, count = currentBid.count;
    if (rank < RANKS.length - 1) rank += 1; else count += 1;
    rankSel.value = rank; countSel.value = count;
  } else {
    rankSel.value = 0; countSel.value = 1;
  }
}

function renderMyHand(){
  const el = $('my-hand');
  el.innerHTML = '';
  (handsCache || []).forEach(rankIdx => {
    const c = document.createElement('div');
    c.className = 'card';
    c.textContent = RANKS[rankIdx];
    el.appendChild(c);
  });
}

function renderLog(logObj){
  const list = $('game-log');
  list.innerHTML = '';
  const entries = Object.values(logObj || {}).sort((a,b) => a.ts - b.ts);
  entries.forEach(e => {
    const li = document.createElement('li');
    if (e.type === 'liar') li.className = 'log-liar';
    if (e.type === 'win') li.className = 'log-win';
    li.textContent = e.text;
    list.appendChild(li);
  });
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

/* ------------------------------ PLAYER ACTIONS ------------------------------ */

$('btn-bid').addEventListener('click', () => {
  const rank = parseInt($('bid-rank').value, 10);
  const count = parseInt($('bid-count').value, 10);
  const cur = roomCache.currentBid;
  if (cur){
    const legal = (count > cur.count) || (count === cur.count && rank > cur.rank);
    if (!legal){ toast('ต้องกล่าวอ้างให้สูงกว่าเดิม (จำนวนมากกว่า หรือจำนวนเท่ากันแต่อันดับสูงกว่า)'); return; }
  }
  db.ref(`rooms/${roomCode}/pendingAction`).set({ type:'bid', uid: myUid, rank, count, ts: Date.now() });
});

$('btn-liar').addEventListener('click', () => {
  db.ref(`rooms/${roomCode}/pendingAction`).set({ type:'liar', uid: myUid, ts: Date.now() });
});

/* ------------------------------ HOST REFEREE LOGIC ------------------------------ */

let pendingWatchAttached = false;
function hostWatchPendingAction(room){
  if (pendingWatchAttached) return;
  pendingWatchAttached = true;
  db.ref(`rooms/${roomCode}/pendingAction`).on('value', snap => {
    const action = snap.val();
    if (!action || !roomCache) return;
    processPendingAction(action).catch(err => console.error(err));
  });
}

async function processPendingAction(action){
  const room = roomCache;
  if (room.status !== 'playing') return;
  const order = room.turnOrder || [];
  const curUid = order[room.currentTurnIndex];
  if (action.uid !== curUid) { db.ref(`rooms/${roomCode}/pendingAction`).remove(); return; }

  if (action.type === 'bid'){
    const nextIndex = nextAliveIndex(order, room.currentTurnIndex, room.players);
    const p = room.players[action.uid];
    const updates = {};
    updates[`rooms/${roomCode}/currentBid`] = { rank: action.rank, count: action.count, byUid: action.uid, byName: p.name };
    updates[`rooms/${roomCode}/currentTurnIndex`] = nextIndex;
    updates[`rooms/${roomCode}/pendingAction`] = null;
    updates[`rooms/${roomCode}/log/${Date.now()}`] = { text: `${p.name} กล่าวอ้าง: ${action.count} × ${RANKS[action.rank]}`, type:'info', ts: Date.now() };
    await db.ref().update(updates);
  }

  if (action.type === 'liar'){
    const bid = room.currentBid;
    if (!bid){ db.ref(`rooms/${roomCode}/pendingAction`).remove(); return; }
    const caller = room.players[action.uid];
    const updates = {};
    updates[`rooms/${roomCode}/status`] = 'revealing';
    updates[`rooms/${roomCode}/challenge`] = { active:true, callerUid: action.uid, callerName: caller.name, bidderUid: bid.byUid, bidderName: bid.byName, rank: bid.rank, count: bid.count };
    updates[`rooms/${roomCode}/reveals`] = null;
    updates[`rooms/${roomCode}/pendingAction`] = null;
    updates[`rooms/${roomCode}/log/${Date.now()}`] = { text: `🏴‍☠️ ${caller.name} ตะโกน "โป้!" ใส่คำกล่าวอ้าง ${bid.count} × ${RANKS[bid.rank]}`, type:'liar', ts: Date.now() };
    await db.ref().update(updates);
  }
}

function nextAliveIndex(order, fromIndex, players){
  const n = order.length;
  for (let step=1; step<=n; step++){
    const idx = (fromIndex + step) % n;
    if (players[order[idx]] && players[order[idx]].alive) return idx;
  }
  return fromIndex;
}

/* ------------------------------ REVEAL / CHALLENGE ------------------------------ */

let revealSubmittedFor = null;
function handleRevealing(room){
  $('challenge-reveal').classList.remove('hidden');
  const ch = room.challenge;
  if (!ch) return;

  const revealKey = room.round + ':' + ch.callerUid + ':' + ch.bidderUid;
  const alive = (room.turnOrder || []).filter(uid => room.players[uid] && room.players[uid].alive);

  // every alive player self-reports how many of the claimed rank they hold
  if (revealSubmittedFor !== revealKey && handsCache){
    const myCount = handsCache.filter(r => r === ch.rank).length;
    db.ref(`rooms/${roomCode}/reveals/${myUid}`).set(myCount);
    revealSubmittedFor = revealKey;
  }

  db.ref(`rooms/${roomCode}/reveals`).on('value', snap => {
    const reveals = snap.val() || {};
    renderRevealProgress(reveals, alive, room);
    if (isHost && Object.keys(reveals).length >= alive.length){
      resolveChallenge(room, reveals).catch(err => console.error(err));
    }
  });
}

function renderRevealProgress(reveals, alive, room){
  const list = $('reveal-list');
  list.innerHTML = '';
  alive.forEach(uid => {
    const p = room.players[uid];
    const chip = document.createElement('div');
    chip.className = 'reveal-chip';
    chip.textContent = `${p.name}: ${uid in reveals ? reveals[uid] : '...'}`;
    list.appendChild(chip);
  });
  const total = Object.values(reveals).reduce((a,b) => a+b, 0);
  const ch = room.challenge;
  $('reveal-result').textContent = Object.keys(reveals).length < alive.length
    ? `กำลังรวบรวมไพ่... (พบแล้ว ${total} ใบ / อ้าง ${ch.count} ใบ)`
    : '';
}

async function resolveChallenge(room, reveals){
  const ch = room.challenge;
  if (!ch || room._resolving) return;
  const total = Object.values(reveals).reduce((a,b) => a+b, 0);
  const bidHeld = total >= ch.count;
  // if the claim holds true, the challenger was wrong and loses a life; otherwise the bidder was bluffing and loses a life
  const loserUid = bidHeld ? ch.callerUid : ch.bidderUid;
  const loser = room.players[loserUid];
  const newLives = Math.max(loser.lives - 1, 0);
  const eliminated = newLives === 0;

  const updates = {};
  updates[`rooms/${roomCode}/players/${loserUid}/lives`] = newLives;
  updates[`rooms/${roomCode}/players/${loserUid}/alive`] = !eliminated;
  updates[`rooms/${roomCode}/log/${Date.now()}`] = {
    text: bidHeld
      ? `เปิดไพ่: พบ ${total} ใบ ≥ ${ch.count} → คำกล่าวอ้างเป็นจริง! ${ch.callerName} เสียชีวิต 1 ดวง`
      : `เปิดไพ่: พบเพียง ${total} ใบ < ${ch.count} → ${ch.bidderName} โป้จริง! เสียชีวิต 1 ดวง`,
    type: eliminated ? 'liar' : 'info', ts: Date.now()
  };
  if (eliminated){
    updates[`rooms/${roomCode}/log/${Date.now()+1}`] = { text: `🌊 ${loser.name} เดินไม้กระดานตกเรือไป!`, type:'liar', ts: Date.now()+1 };
  }

  // recompute alive roster
  const aliveUids = (room.turnOrder || []).filter(uid => uid === loserUid ? !eliminated : (room.players[uid] && room.players[uid].alive));

  if (aliveUids.length <= 1){
    updates[`rooms/${roomCode}/status`] = 'ended';
    updates[`rooms/${roomCode}/winnerUid`] = aliveUids[0] || null;
    updates[`rooms/${roomCode}/log/${Date.now()+2}`] = { text: `🏆 ${aliveUids[0] ? room.players[aliveUids[0]].name : 'ไม่มีใคร'} คือผู้รอดชีวิตคนสุดท้าย!`, type:'win', ts: Date.now()+2 };
  } else {
    const { hands, totalCards } = dealHands(aliveUids);
    let nextIdx = aliveUids.indexOf(loserUid);
    if (nextIdx === -1) nextIdx = 0;
    updates[`rooms/${roomCode}/status`] = 'playing';
    updates[`rooms/${roomCode}/round`] = (room.round || 1) + 1;
    updates[`rooms/${roomCode}/turnOrder`] = aliveUids;
    updates[`rooms/${roomCode}/currentTurnIndex`] = nextIdx;
    updates[`rooms/${roomCode}/currentBid`] = null;
    updates[`rooms/${roomCode}/challenge`] = null;
    updates[`rooms/${roomCode}/reveals`] = null;
    updates[`rooms/${roomCode}/totalCardsInPlay`] = totalCards;
    updates[`rooms/${roomCode}/hands`] = hands;
  }

  roomCache._resolving = true;
  await db.ref().update(updates);
  db.ref(`rooms/${roomCode}/reveals`).off('value');
}