'use strict';

(function () {
  const { TYPE_NAME } = window.MathGame;
  const $ = (id) => document.getElementById(id);

  // ---------------- 状态 ----------------
  const state = {
    phase: 'wait',     // wait | playing | finished | error
    mode: 'timed',
    durationSec: 60,
    targetCount: 10,
    maxNum: 20,
    types: [],
    endAt: 0,
    question: null,       // 当前题目（仅题面）
    me: { index: 0, correct: 0, wrong: 0 },
    opp: { correct: 0, wrong: 0 },
    result: null,
  };

  let peer = null;
  let conn = null;
  let typed = '';
  let lock = false;
  let showing = false;
  let renderedIndex = -1;
  let tickTimer = null;
  let nextQuestion = null;   // host 随反馈一起发来的下一题
  let resyncTimer = null;     // 等待超时时主动请求同步
  let startAckSent = false;

  const room = new URLSearchParams(location.search).get('room');
  if (!room) {
    document.body.dataset.view = 'error';
    $('errSub').textContent = '缺少房间号，请用主机页面的二维码扫码加入';
    return;
  }

  // ---------------- 连接主机 ----------------
  function init() {
    $('waitSub').textContent = '正在连接主机，请稍候…';
    peer = new Peer();

    peer.on('open', () => {
      $('waitSub').textContent = '正在加入房间…';
      doConnect();
    });

    peer.on('error', (err) => {
      console.error('Peer 错误:', err);
      if (err.type === 'peer-unavailable') {
        $('errSub').textContent = '找不到房间，请确认主机二维码是否有效';
        document.body.dataset.view = 'error';
      } else {
        $('connbar').classList.add('on');
        $('connbar').textContent = '连接错误：' + err.type + '，正在重试…';
        setTimeout(init, 2000);
      }
    });
  }

  function doConnect() {
    try { conn = peer.connect(room, { reliable: true }); } catch (e) { return; }
    conn.on('open', () => {
      $('connbar').classList.remove('on');
      $('connbar').textContent = '';
      $('waitSub').textContent = '已加入！等待主机开始比赛…';
      $('waitDots').textContent = '🎮';
      startAckSent = false;
      send({ type: 'ready' });
      // 如果等了 4 秒还没收到 start，主动请求同步
      scheduleResync(4000);
    });
    conn.on('data', onHostData);
    conn.on('close', () => {
      if (state.phase !== 'finished') {
        $('connbar').classList.add('on');
        $('connbar').textContent = '与主机断开，正在重连…';
        setTimeout(doConnect, 1500);
      }
    });
    conn.on('error', (e) => {
      console.error('连接错误', e);
      setTimeout(doConnect, 1500);
    });
  }

  function scheduleResync(delay) {
    if (resyncTimer) clearTimeout(resyncTimer);
    resyncTimer = setTimeout(() => {
      resyncTimer = null;
      if (state.phase === 'wait') {
        send({ type: 'resync' });
        scheduleResync(3000);   // 继续轮询直到收到 start
      }
    }, delay);
  }

  function send(msg) { if (conn && conn.open) conn.send(msg); }

  function onHostData(data) {
    if (!data || !data.type) return;
    switch (data.type) {
      case 'welcome':
        break;
      case 'ping':
        send({ type: 'pong' });
        break;
      case 'start':
        // 收到 start 立即回 ack，让主机停止重试
        if (!startAckSent) { send({ type: 'startAck' }); startAckSent = true; }
        // 已经在答题中，说明是重试包，只回 ack 不重置
        if (state.phase === 'playing') return;
        if (resyncTimer) { clearTimeout(resyncTimer); resyncTimer = null; }
        state.phase = 'playing';
        state.mode = data.config.mode;
        state.durationSec = data.config.durationSec;
        state.targetCount = data.config.targetCount;
        state.maxNum = data.config.maxNum;
        state.types = data.config.types;
        state.me = { index: data.question.index, correct: 0, wrong: 0 };
        state.opp = { correct: 0, wrong: 0 };
        // 优先用主机下发的结束时间，保证两端倒计时同步
        state.endAt = data.endAt || (Date.now() + state.durationSec * 1000);
        state.question = data.question;
        typed = ''; lock = false; showing = false; renderedIndex = -1;
        $('kwrap').innerHTML = state.types.map((t) => '<span>' + TYPE_NAME[t] + '</span>').join('');
        document.body.dataset.view = 'playing';
        startClock();
        renderPlay();
        break;
      case 'feedback':
        state.me.correct = data.correct;
        state.me.wrong = data.wrong;
        nextQuestion = data.nextQuestion;
        showFlash(data.ok, data.answer);
        updateMyUI();
        break;
      case 'oppProgress':
        state.opp.correct = data.correct;
        state.opp.wrong = data.wrong;
        if (state.phase === 'playing') updateOppUI();
        break;
      case 'finished':
        state.phase = 'finished';
        state.result = data.result;
        clearClock();
        if (showing) {
          $('btnNext').textContent = '查看结果 ▶';
          setTimeout(dismissFlash, 3000);
        } else {
          renderResult();
        }
        break;
      case 'reset':
        state.phase = 'wait';
        state.result = null;
        typed = ''; lock = false; showing = false;
        startAckSent = false;
        document.body.dataset.view = 'wait';
        $('waitSub').textContent = '主机已重置，等待开始下一局…';
        $('waitDots').textContent = '⏳';
        scheduleResync(4000);
        break;
    }
  }

  // ---------------- 题目 / 答题 ----------------
  function submitAnswer(value) {
    if (lock || state.phase !== 'playing' || !state.question) return;
    lock = true;
    $('pad').querySelectorAll('button').forEach((b) => b.disabled = true);
    $('cmpKeys').querySelectorAll('button').forEach((b) => b.disabled = true);
    if (state.question.type === 'cmp') { $('slotCmp').textContent = opLabel(value); $('slotCmp').classList.add('filled'); }
    else { $('slot').textContent = value; $('slot').classList.add('filled'); }
    send({ type: 'answer', index: state.question.index, value });
  }

  function opLabel(op) { return op === '>' ? '＞' : op === '<' ? '＜' : '＝'; }

  // ---------------- 渲染 ----------------
  function flower(cls, big) {
    const size = big ? 'flower-big ' : '';
    return '<svg class="fl ' + size + cls + '" viewBox="0 0 24 24"><g fill="currentColor">' +
      '<ellipse cx="12" cy="5.6" rx="3.2" ry="4.4"/>' +
      '<ellipse cx="12" cy="5.6" rx="3.2" ry="4.4" transform="rotate(72 12 12)"/>' +
      '<ellipse cx="12" cy="5.6" rx="3.2" ry="4.4" transform="rotate(144 12 12)"/>' +
      '<ellipse cx="12" cy="5.6" rx="3.2" ry="4.4" transform="rotate(216 12 12)"/>' +
      '<ellipse cx="12" cy="5.6" rx="3.2" ry="4.4" transform="rotate(288 12 12)"/>' +
      '</g><circle cx="12" cy="12" r="2.8"/></svg>';
  }

  function renderPlay() {
    const q = state.question;
    if (!q) return;
    $('who').textContent = '我（选手2）';
    updateMyUI();
    updateOppUI();
    $('pclock').classList.toggle('hide', state.mode !== 'timed');

    const isCmp = q.type === 'cmp';
    $('expr').hidden = isCmp;
    $('cmpWrap').hidden = !isCmp;
    $('pad').style.display = isCmp ? 'none' : 'grid';

    if (q.index === renderedIndex) return;
    renderedIndex = q.index;
    typed = '';
    $('pad').querySelectorAll('button').forEach((b) => b.disabled = false);
    $('cmpKeys').querySelectorAll('button').forEach((b) => b.disabled = false);

    if (isCmp) {
      $('cmpL').textContent = q.left;
      $('cmpR').textContent = q.right;
      $('slotCmp').textContent = '?';
      $('slotCmp').classList.remove('filled');
    } else {
      $('exprText').textContent = q.text;
      $('slot').textContent = '?';
      $('slot').classList.remove('filled');
    }
  }

  function updateMyUI() {
    $('midInfo').textContent = state.mode === 'target'
      ? '已答对 ' + state.me.correct + ' / ' + state.targetCount + ' 题'
      : '已答对 ' + state.me.correct + ' 题';
    $('mini').innerHTML = '<span class="g">' + flower('red') + ' 小红花 × ' + state.me.correct + '</span>' +
      '<span class="g">' + flower('yellow') + ' 小黄花 × ' + state.me.wrong + '</span>';
  }

  function updateOppUI() {
    const opp = state.opp;
    $('oppStat').textContent = opp.correct + ' 对 / ' + opp.wrong + ' 错';
    const pct = state.mode === 'target'
      ? Math.min(100, (opp.correct / state.targetCount) * 100)
      : Math.min(100, opp.correct * 5);
    $('oppBarInner').style.width = pct + '%';
  }

  function renderResult() {
    document.body.dataset.view = 'result';
    const r = state.result;
    if (!r) return;
    const me = r.me, opp = r.opp;
    const isWin = r.mode === 'target' ? r.winner === 'B' : (opp.accuracy < me.accuracy || r.tie);
    $('verdict').textContent = isWin ? '你真棒！' : '继续加油！';
    $('verdict').classList.toggle('cheer', !isWin);

    $('rstat').innerHTML = '答对 <b>' + me.correct + '</b> 题　答错 <b>' + me.wrong + '</b> 题' +
      (r.mode === 'timed' ? '<br>准确率 <b>' + Math.round(me.accuracy * 100) + '%</b>' : '');

    let box = '<div class="row"><span>我（选手2）</span><b>' + (isWin ? '你真棒！' : '继续加油！') + '</b></div>' +
      '<div class="row"><span>选手1（主机）</span><b>' + (!isWin ? '你真棒！' : '继续加油！') + '</b></div>' +
      '<div class="row"><span>选手2 答题</span><b>' + me.correct + ' 对 / ' + me.wrong + ' 错</b></div>' +
      '<div class="row"><span>选手1 答题</span><b>' + opp.correct + ' 对 / ' + opp.wrong + ' 错</b></div>';
    if (r.mode === 'timed') {
      box += '<div class="row"><span>选手2 准确率</span><b>' + Math.round(me.accuracy * 100) + '%</b></div>' +
        '<div class="row"><span>选手1 准确率</span><b>' + Math.round(opp.accuracy * 100) + '%</b></div>';
    }
    $('resBox').innerHTML = box;
  }

  // ---------------- 倒计时 ----------------
  function startClock() {
    if (state.mode !== 'timed') return;
    tickClock();
    tickTimer = setInterval(tickClock, 100);
  }
  function clearClock() { if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } }
  function tickClock() {
    const ms = Math.max(0, state.endAt - Date.now());
    const sec = Math.ceil(ms / 1000);
    const el = $('pclock');
    el.textContent = String(sec).padStart(2, '0');
    el.classList.toggle('warn', sec <= 10);
  }

  // ---------------- 反馈浮层 ----------------
  function showFlash(ok, answer) {
    showing = true;
    const f = $('flash');
    f.classList.add('on');
    f.classList.toggle('good', ok);
    f.classList.toggle('bad', !ok);
    $('flashIcon').innerHTML = flower(ok ? 'red' : 'yellow', true);
    $('flashMsg').textContent = ok ? '答对啦！' : '答错了';
    $('flashAns').textContent = ok ? '+1 小红花' : '正确答案是 ' + answer;
    $('btnNext').textContent = '下一题 ▶';
  }

  function dismissFlash() {
    if (!showing) return;
    $('flash').classList.remove('on', 'good', 'bad');
    showing = false;
    lock = false;
    if (state.phase === 'finished') {
      renderResult();
    } else if (nextQuestion) {
      state.question = nextQuestion;
      nextQuestion = null;
      renderPlay();
    } else if (state.question) {
      renderPlay();
    }
  }

  // ---------------- 交互 ----------------
  $('btnNext').addEventListener('click', (e) => { e.stopPropagation(); dismissFlash(); });
  $('pad').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || lock) return;
    const k = b.dataset.k;
    if (k === 'del') typed = typed.slice(0, -1);
    else if (k === 'ok') { if (typed) submitAnswer(typed); return; }
    else if (typed.length < 4) typed = (typed === '0' ? '' : typed) + k;
    $('slot').textContent = typed === '' ? '?' : typed;
    $('slot').classList.toggle('filled', typed !== '');
  });
  $('cmpKeys').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || lock) return;
    submitAnswer(b.dataset.op);
  });
  document.addEventListener('keydown', (e) => {
    if (showing && (e.key === 'Enter' || e.key === ' ')) { dismissFlash(); return; }
    if (document.body.dataset.view !== 'playing' || lock) return;
    if (/^[0-9]$/.test(e.key)) {
      if (!state.question || state.question.type === 'cmp') return;
      if (typed.length < 4) typed = (typed === '0' ? '' : typed) + e.key;
      $('slot').textContent = typed === '' ? '?' : typed;
      $('slot').classList.toggle('filled', typed !== '');
    } else if (e.key === 'Backspace') {
      typed = typed.slice(0, -1);
      $('slot').textContent = typed === '' ? '?' : typed;
      $('slot').classList.toggle('filled', typed !== '');
    } else if (e.key === 'Enter') {
      if (typed) submitAnswer(typed);
    } else if (['>', '<', '='].includes(e.key) && state.question && state.question.type === 'cmp') {
      submitAnswer(e.key);
    }
  });

  // 显示本局题型标签
  $('kwrap').innerHTML = state.types.length
    ? state.types.map((t) => '<span>' + TYPE_NAME[t] + '</span>').join('')
    : '<span>等待主机设置题型…</span>';

  init();
})();
