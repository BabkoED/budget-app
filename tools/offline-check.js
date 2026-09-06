/* Проверка офлайна с НАСТОЯЩИМ service worker.
 *
 *   pw tools/offline-check.js
 *
 * Зачем отдельный прогон. tools/check.js вырезает service worker из демо-копии
 * намеренно: он мешает проверять поведение приложения. Из-за этого сам воркер
 * не проверялся НИКОГДА, хотя версию кэша поднимали при каждом выпуске, а в
 * августе именно здесь был баг — холодный старт без сети висел на вечной
 * загрузке. Регрессию туда никто бы не увидел.
 *
 * Здесь всё наоборот: воркер оставлен как есть, подменён только Supabase
 * (иначе прогон полезет в настоящую базу). Проверяется то, ради чего воркер
 * и существует:
 *   1) регистрируется ли он вообще и берёт ли страницу под контроль;
 *   2) переживает ли приложение полное отсутствие сети (авиарежим);
 *   3) не виснет ли холодный старт без сети — тот самый августовский баг;
 *   4) отдаёт ли кэш страницу быстрее таймаута, когда сеть медленная;
 *   5) совпадает ли версия кэша с объявленной в sw.js.
 *
 * Сеть режется на уровне браузера (route.abort), а не мока: мок бы солгал,
 * потому что через него воркер не проходит.
 */
const fs = require('fs'), http = require('http'), path = require('path');
const {ROOT, seedStateBusy, loadPlaywright} = require('./demo.js');
const pw = loadPlaywright();

let fails = 0;
const ok = (name, cond, got) => {
  console.log((cond ? '  ПРОШЛО ' : '  УПАЛО  ') + name +
    (cond ? '' : '  → ' + JSON.stringify(got)));
  if (!cond) fails++;
};

/* Демо-копия для этого прогона: воркер ОСТАЁТСЯ, меняется только Supabase. */
const FAKE = `<script>
window.__CLOUD__=null;
function __cp(o){return JSON.parse(JSON.stringify(o));}
window.supabase={createClient:function(){return {
  auth:{
    getSession:function(){return Promise.resolve({data:{session:{user:{id:'u1',email:'a@b.c'}}}});},
    onAuthStateChange:function(){return {data:{subscription:{unsubscribe:function(){}}}};},
    signOut:function(){return Promise.resolve({error:null});}
  },
  from:function(){return {
    select:function(){return {eq:function(){return {maybeSingle:function(){
      return Promise.resolve({data: window.__CLOUD__?{state:__cp(window.__CLOUD__)}:null, error:null});
    }};}};},
    upsert:function(row){window.__CLOUD__=__cp(row.state);return Promise.resolve({error:null});}
  };},
  channel:function(){var o={on:function(){return o;},subscribe:function(){return o;}};return o;},
  removeChannel:function(){}
};}};
</script>`;

function buildWithWorker() {
  let s = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const cdn = '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>';
  if (s.indexOf(cdn) < 0) throw new Error('не нашёл подключение Supabase');
  return s.replace(cdn, FAKE);       /* воркер НЕ трогаем — в этом весь смысл */
}

(async () => {
  const html = buildWithWorker();
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const manifest = fs.existsSync(path.join(ROOT, 'manifest.json'))
    ? fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8') : '{}';

  /* Свой сервер: воркеру нужен один источник и корректные типы. */
  const srv = http.createServer((q, r) => {
    const u = q.url.split('?')[0];
    if (u === '/sw.js') {
      r.writeHead(200, {'Content-Type': 'application/javascript; charset=utf-8'});
      return r.end(sw);
    }
    if (u === '/manifest.json') {
      r.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
      return r.end(manifest);
    }
    if (u.endsWith('.png')) { r.writeHead(200, {'Content-Type': 'image/png'}); return r.end(''); }
    r.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    r.end(html);
  });
  await new Promise(res => srv.listen(0, '127.0.0.1', res));
  const url = 'http://127.0.0.1:' + srv.address().port + '/';

  const br = await pw.chromium.launch();
  const ctx = await br.newContext({viewport: {width: 430, height: 932}});
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('pageerror', e => errors.push(e.message));

  console.log('\n1. Регистрация service worker');
  await pg.goto(url, {waitUntil: 'load'});
  /* Внешние ресурсы (шрифты, CDN) в этой среде недоступны — воркер обязан
     пережить их провал, иначе install падает и кэша не будет вообще. */
  const reg = await pg.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return {support: false};
    try {
      const r = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      return {support: true, scope: r.scope, active: !!r.active};
    } catch (e) { return {support: true, error: String(e)}; }
  });
  ok('воркер поддерживается и регистрируется', reg.support && !reg.error, reg);
  ok('воркер стал активным', !!reg.active, reg);

  const version = (sw.match(/CACHE\s*=\s*'([^']+)'/) || [])[1];
  console.log('   версия кэша в sw.js: ' + version);

  /* Даём воркеру положить страницу в кэш и взять управление. */
  await pg.reload({waitUntil: 'load'});
  await pg.waitForTimeout(1200);
  const controlled = await pg.evaluate(() => !!navigator.serviceWorker.controller);
  ok('страница под управлением воркера', controlled, {controlled});

  const cached = await pg.evaluate(async () => {
    const names = await caches.keys();
    const out = {};
    for (const n of names) {
      const c = await caches.open(n);
      out[n] = (await c.keys()).map(r => r.url);
    }
    return out;
  });
  const keys = Object.keys(cached);
  console.log('   кэши: ' + JSON.stringify(keys));
  ok('кэш назван так же, как в sw.js', keys.includes(version), {keys, version});
  const shell = (cached[version] || []).some(u => u === url || u.endsWith('/'));
  ok('в кэше лежит сама страница (app-shell)', shell, cached[version]);

  console.log('\n2. Авиарежим: сети нет совсем');
  await ctx.setOffline(true);
  const t0 = Date.now();
  let navFailed = null;
  try {
    await pg.goto(url, {waitUntil: 'load', timeout: 15000});
  } catch (e) { navFailed = String(e).split('\n')[0]; }
  const dt = Date.now() - t0;
  ok('страница открылась без сети', !navFailed, navFailed);
  console.log('   заняло ' + dt + ' мс');
  ok('открылась быстрее 6 секунд (а не «вечная загрузка»)', dt < 6000, {dt});

  const body = await pg.evaluate(() => document.body.innerText.slice(0, 200));
  ok('на странице есть содержимое, а не пустой экран', body.trim().length > 10, body);

  console.log('\n3. Холодный старт без сети — августовский баг');
  /* Самый жёсткий случай: свежая вкладка, сети нет с самого начала. */
  const pg2 = await ctx.newPage();
  const errors2 = [];
  pg2.on('pageerror', e => errors2.push(e.message));
  const t1 = Date.now();
  let coldFail = null;
  try {
    await pg2.goto(url, {waitUntil: 'domcontentloaded', timeout: 15000});
  } catch (e) { coldFail = String(e).split('\n')[0]; }
  const dt1 = Date.now() - t1;
  ok('холодный старт без сети не упал', !coldFail, coldFail);
  console.log('   заняло ' + dt1 + ' мс');

  await pg2.waitForTimeout(3000);
  const stuck = await pg2.evaluate(() => {
    const t = document.body.innerText;
    const spinner = document.querySelector('.loader,.spinner,#loading');
    return {
      text: t.slice(0, 120).replace(/\s+/g, ' '),
      hasSpinner: !!spinner && getComputedStyle(spinner).display !== 'none',
      nodes: document.querySelectorAll('.pg *').length
    };
  });
  console.log('   на экране: «' + stuck.text + '»');
  ok('не висит на загрузке — интерфейс отрисован', stuck.nodes > 5 || !stuck.hasSpinner, stuck);
  ok('ошибок в консоли нет', errors2.length === 0, errors2);

  console.log('\n3б. Офлайн С ДАННЫМИ — то, ради чего офлайн вообще нужен');
  /* Предыдущая проверка запускалась на пустом localStorage и показывала
     «Нет бюджета». Формально не упало — но человеку в метро нужен не пустой
     экран, а его деньги. Сеем местную копию и смотрим, доедет ли она. */
  await ctx.setOffline(false);
  const pg4 = await ctx.newPage();
  await pg4.goto(url, {waitUntil: 'load'});
  await pg4.evaluate(st => {
    localStorage.setItem('budget_last_uid', 'u1');
    localStorage.setItem('budget_backup_u1', JSON.stringify(st));
  }, seedStateBusy());
  await pg4.waitForTimeout(600);
  await ctx.setOffline(true);
  const t3 = Date.now();
  let dataFail = null;
  try {
    await pg4.reload({waitUntil: 'domcontentloaded', timeout: 15000});
  } catch (e) { dataFail = String(e).split('\n')[0]; }
  await pg4.waitForTimeout(2500);
  const shown = await pg4.evaluate(() => {
    /* Ищем операции ПО СОДЕРЖАНИЮ, а не по классу: разметка выписки и
       разметка вкладок разная, и проверка по селектору одной из них падала
       на целом приложении. Имена берём те, что посеяли. */
    const t = document.body.innerText.replace(/\s+/g, ' ');
    const names = ['Самокат', 'Пятёрочка', 'Коммуналка', 'Тройка', 'Аптека'];
    return {
      text: t.slice(0, 140),
      hasMoney: /\d[\d\s]*₽/.test(t),
      empty: /Нет бюджета|Создай бюджет/.test(t),
      found: names.filter(n => t.indexOf(n) >= 0)
    };
  });
  console.log('   заняло ' + (Date.now() - t3) + ' мс, на экране: «' + shown.text + '»');
  ok('офлайн открылся с местной копией', !dataFail, dataFail);
  ok('видны деньги, а не пустой экран', shown.hasMoney && !shown.empty, shown);
  ok('посеянные операции видны в списке', shown.found.length >= 3, shown);
  await ctx.setOffline(false);

  console.log('\n4. Медленная сеть: кэш должен успеть раньше таймаута');
  await ctx.setOffline(false);
  /* Держим навигационный запрос дольше таймаута воркера (2.5 с). */
  await ctx.route('**/', async route => {
    await new Promise(r => setTimeout(r, 8000));
    route.continue();
  });
  const pg3 = await ctx.newPage();
  const t2 = Date.now();
  let slowFail = null;
  try {
    await pg3.goto(url, {waitUntil: 'domcontentloaded', timeout: 15000});
  } catch (e) { slowFail = String(e).split('\n')[0]; }
  const dt2 = Date.now() - t2;
  console.log('   заняло ' + dt2 + ' мс при сети, отвечающей за 8000 мс');
  ok('кэш опередил медленную сеть (быстрее 6 с)', !slowFail && dt2 < 6000, {dt2, slowFail});
  await ctx.unroute('**/');

  console.log('\n5. Обновление версии');
  const bumped = /budget-v(\d+)/.exec(version);
  ok('версия кэша пронумерована', !!bumped, version);
  const inHeader = /Service Worker v(\d+)/.exec(sw);
  ok('версия в шапке sw.js совпадает с CACHE',
     inHeader && bumped && inHeader[1] === bumped[1], {header: inHeader && inHeader[1], cache: bumped && bumped[1]});

  await br.close();
  srv.close();
  console.log(fails ? ('\nПРОВАЛЕНО проверок: ' + fails) : '\nВСЁ ПРОШЛО');
  process.exit(fails ? 1 : 0);
})();
