'use strict';

// ===========================================================================
// 共享逻辑（手机1/主机 与 手机2/参与机 都可用）
// 题目生成、题型常量、答案判定 —— 全部在前端完成，不再依赖后端
// ===========================================================================

const ALL_TYPES = ['add', 'sub', 'add3', 'sub3', 'cmp'];   // 加法 / 减法 / 连加 / 连减 / 加减法大小比较
const TYPE_NAME = { add: '加法', sub: '减法', add3: '连加', sub3: '连减', cmp: '加减法大小比较' };
const BANK_SIZE = 400;
const SEED = 20261016;

// 固定种子的伪随机数生成器（保证题目序列稳定）
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeQuestion(type, maxNum, ri, rnd) {
  const top = Math.max(10, maxNum);
  switch (type) {
    case 'add': {
      const a = ri(1, top - 1);
      const b = ri(1, top - a);
      return { type, text: `${a} + ${b}`, answer: a + b };
    }
    case 'sub': {
      const a = ri(2, top);
      const b = ri(1, a);
      return { type, text: `${a} - ${b}`, answer: a - b };
    }
    case 'add3': {
      const a = ri(1, top - 2);
      const b = ri(1, top - a - 1);
      const c = ri(1, top - a - b);
      return { type, text: `${a} + ${b} + ${c}`, answer: a + b + c };
    }
    case 'sub3': {
      const a = ri(3, top);
      const b = ri(1, a - 2);
      const c = ri(1, a - b);
      return { type, text: `${a} - ${b} - ${c}`, answer: a - b - c };
    }
    default: { // cmp 加减法比较大小
      const mk = () => {
        if (rnd() < 0.5) {
          const a = ri(1, top - 1);
          const b = ri(1, top - a);
          return { s: `${a} + ${b}`, v: a + b };
        }
        const a = ri(2, top);
        const b = ri(1, a);
        return { s: `${a} - ${b}`, v: a - b };
      };
      const L = mk();
      let R;
      if (rnd() < 0.25 && L.v >= 2) {
        const x = ri(1, L.v - 1);          // 制造相等的情况
        R = { s: `${x} + ${L.v - x}`, v: L.v };
      } else {
        R = mk();
      }
      const answer = L.v > R.v ? '>' : L.v < R.v ? '<' : '=';
      return { type: 'cmp', left: L.s, right: R.s, answer };
    }
  }
}

// 生成题目序列（在手机1上生成）
function buildQuestions(maxNum, count, seed, types) {
  const rnd = mulberry32(seed);
  const ri = (min, max) => (max <= min ? min : min + Math.floor(rnd() * (max - min + 1)));
  const pool = types && types.length ? types : ALL_TYPES;
  const out = [];
  let last = '';
  for (let i = 0; i < count; i++) {
    let type = pool[ri(0, pool.length - 1)];
    if (type === last && rnd() < 0.6) type = pool[ri(0, pool.length - 1)]; // 避免连续重复同一题型
    last = type;
    out.push(makeQuestion(type, maxNum, ri, rnd));
  }
  return out;
}

// 答题判定（手机1作为裁判）
function checkAnswer(q, value) {
  if (q.type === 'cmp') return String(value) === q.answer;
  return value !== '' && Number(value) === q.answer;
}

// 去掉答案的题面（发给手机2）
function publicQuestion(q, index) {
  if (!q) return null;
  return { index, type: q.type, text: q.text || '', left: q.left || '', right: q.right || '' };
}

// 准确率
function accuracyOf(correct, wrong) {
  const total = correct + wrong;
  return total ? correct / total : 0;
}

// 导出到全局
window.MathGame = { ALL_TYPES, TYPE_NAME, BANK_SIZE, SEED, buildQuestions, checkAnswer, publicQuestion, accuracyOf, mulberry32 };
