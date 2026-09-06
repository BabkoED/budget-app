/* Общая часть прогонов: демо-копия приложения, посев состояния, сервер.
 *
 * Вынесено из tools/check.js 06.09.2026, когда появился второй прогон
 * (tools/audit-ui.js). Смысл выноса один: оба прогона обязаны поднимать
 * ОДНО И ТО ЖЕ приложение. Если у аудита будет своя копия сборки, он рано
 * или поздно начнёт мерить не то, что проверяет стенд, и расхождение
 * никто не заметит.
 *
 * Здесь нет ни одной проверки — только подъём. Проверки живут в check.js
 * (поведение и деньги) и audit-ui.js (интерфейс и доступность).
 */
const fs = require('fs'), http = require('http'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');

/* Playwright ищется по нескольким путям: на Linux — обёртка ~/.local/bin/pw,
   на Mac — глобальная установка. */
function loadPlaywright() {
  for (const p of [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core',
       path.join(os.homedir(), '.npm/_npx/705bc6b22212b352/node_modules/playwright')]) {
    if (!p) continue;
    try { return require(p); } catch (e) {}
  }
  console.error('Нет playwright. Поставь его или задай PLAYWRIGHT_MODULE.');
  process.exit(2);
}

/* ── Поддельный Supabase ─────────────────────
   ВАЖНО: мок обязан ОТВЕЧАТЬ, а не отклоняться быстро, и обязан уметь
   ЗАВИСАТЬ — на быстро падающем моке не воспроизводится ни вечная загрузка,
   ни откат выбора периода. См. CLAUDE.md. */
const FAKE = `<script>
window.__CLOUD__=null; window.__UPSERTS__=0; window.__HANG__=false;
function __cp(o){return JSON.parse(JSON.stringify(o));}
function __net(v){ if(window.__HANG__) return new Promise(function(){});  /* висит, не падает */
  return Promise.resolve(v); }
window.supabase={createClient:function(){return {
  auth:{
    getSession:function(){return __net({data:{session:{user:{id:'u1',email:'anton@example.com'}}}});},
    onAuthStateChange:function(){return {data:{subscription:{unsubscribe:function(){}}}};},
    signOut:function(){return Promise.resolve({error:null});}
  },
  from:function(){
    return {
      select:function(){ return {eq:function(){ return {maybeSingle:function(){
        return __net({data: window.__CLOUD__?{state:__cp(window.__CLOUD__)}:null, error:null});
      }};}};},
      upsert:function(row){window.__CLOUD__=__cp(row.state);window.__UPSERTS__++;return __net({error:null});}
    };
  },
  channel:function(){var o={on:function(){return o;},subscribe:function(){return o;}};return o;},
  removeChannel:function(){}
};}};
</script>`;

function buildDemo() {
  let s = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const cdn = '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>';
  if (s.indexOf(cdn) < 0) throw new Error('не нашёл подключение Supabase — поправь tools/demo.js');
  s = s.replace(cdn, FAKE);
  s = s.replace(/if \('serviceWorker' in navigator\) \{[\s\S]*?\n\}\n/, '');   /* воркер в демо не нужен */
  if (s.indexOf('initApp();') < 0) throw new Error('не нашёл вызов initApp()');
  s = s.replace('initApp();', 'window.__initApp=initApp;');                    /* старт из теста */
  return s;
}

/* Состояние: август прошёл, сентябрь идёт, октябрь создан заранее.
   Даты жёсткие — чтобы проверки не зависели от дня прогона, «сегодня»
   подменяется в браузере (см. freezeDate). */
const TODAY = '2026-09-01';

function seedState() {
  const mk = (id, from, to, name, amount, created) => {
    const days = Math.round((new Date(to) - new Date(from)) / 864e5) + 1, pot = amount - 20000;
    return {id, dateFrom: from, dateTo: to, createdAt: created, showDates: false,
      incomes: [{id: id + '-i', name, emoji: '💰', amount, recur: true, mod: 1}],
      planned: [{id: id + '-p', name: 'Аренда', emoji: '🏠', amount: 20000, recur: true, mod: 1}],
      dailyBudget: pot / days, rates: [{from, v: pot / days}], pot, potV: 2, mod: 1};
  };
  return {budgets: [mk('b-aug', '2026-08-01', '2026-08-31', 'Зарплата августа', 100000, '2026-08-01'),
                    mk('b-sep', '2026-09-01', '2026-09-30', 'Зарплата сентября', 120000, '2026-08-28'),
                    mk('b-oct', '2026-10-01', '2026-10-31', 'Зарплата октября', 130000, '2026-08-29')],
          txs: [{id: 't1', seq: 1, date: '2026-08-05', name: 'Кофе', category: '', categoryEmoji: '',
                 plannedCatId: null, amount: 300, budgetId: 'b-aug', mod: 1}],
          activeBudgetId: 'b-aug', rip: {}, at: 1756000000000};
}

/* Статический сервер без внешних зависимостей: отдаёт демо-копию на любой путь. */
async function serve(html) {
  const srv = http.createServer((q, r) => {
    r.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    r.end(html);
  });
  await new Promise(res => srv.listen(0, '127.0.0.1', res));
  return {srv, url: 'http://127.0.0.1:' + srv.address().port + '/'};
}

/* «Сегодня» фиксируем, иначе проверки живут ровно один день. */
const freezeDate = day => `(function(){var F=new Date('${day}T09:00:00'),D=Date;
  function P(){ if(!arguments.length) return new D(F.getTime()); return new D(...arguments); }
  P.prototype=D.prototype; P.now=function(){return F.getTime();}; P.parse=D.parse; P.UTC=D.UTC;
  window.Date=P;})()`;

module.exports = {ROOT, loadPlaywright, buildDemo, seedState, serve, freezeDate, TODAY};
