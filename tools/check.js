/* Прогон приложения в браузере одной командой.
 *
 *   pw tools/check.js          (Linux-машина, обёртка ~/.local/bin/pw)
 *   node tools/check.js        (Mac, playwright установлен глобально)
 *
 * Зачем файл в репозитории: приложение требует входа в Supabase, поэтому
 * проверять его можно только на демо-копии с подменённым клиентом. Раньше
 * эта копия собиралась заново каждой сессией — час работы на то, что должно
 * занимать минуту, и каждый раз с новыми допущениями.
 *
 * Что здесь есть:
 *   1) проверки поведения и денег в браузере;
 *   2) отдельно, в чистом node, — проверки mergeState, чтобы ошибка в тесте
 *      интерфейса не подтверждала сама себя.
 *
 * Подъём приложения (демо-копия, посев, сервер) переехал в tools/demo.js —
 * его делит с этим файлом прогон tools/audit-ui.js. Оба обязаны поднимать
 * одно и то же приложение, иначе замер разойдётся с проверкой незаметно.
 *
 * ВАЖНО: мок Supabase обязан ОТВЕЧАТЬ, а не отклоняться быстро, и обязан
 * уметь ЗАВИСАТЬ — на быстро падающем моке не воспроизводится ни вечная
 * загрузка, ни откат выбора периода. См. CLAUDE.md.
 */
const fs=require('fs'), path=require('path'), os=require('os');
const demo=require('./demo.js');
const {ROOT, buildDemo, seedState, serve, freezeDate, TODAY}=demo;
const pw=demo.loadPlaywright();

/* ── 2. Проверки mergeState в чистом node ───── */
function checkMerge(ok){
  const src=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
  const cut=n=>{const i=src.indexOf('function '+n+'(');if(i<0)throw new Error('нет '+n);
    let d=0;for(let k=src.indexOf('{',i);k<src.length;k++){
      if(src[k]==='{')d++;else if(src[k]==='}'){d--;if(!d)return src.slice(i,k+1);}}};
  const sandbox={S:{rip:{}},RIP_TTL:180*864e5};
  const fn=new Function('S','RIP_TTL',cut('nowMs')+'\n'+cut('mergeState')+'\nreturn mergeState;')(sandbox.S,sandbox.RIP_TTL);
  const T=Date.now(), bdg=(id,mod)=>({id,mod,dateFrom:'2026-09-01',dateTo:'2026-09-30',incomes:[],planned:[]});
  /* Выбор периода — местный при любом соотношении at: это не данные, а то,
     что человек смотрит на ЭТОМ устройстве. A — облако, B — эта машина. */
  for(const [ca,la] of [[T,T],[T+9999,T],[T,T+9999]])
    ok('mergeState: выбор периода местный (at '+(ca-T)+'/'+(la-T)+')',
       fn({budgets:[bdg('a',1)],txs:[],activeBudgetId:'aug',at:ca},
          {budgets:[bdg('a',1)],txs:[],activeBudgetId:'sep',at:la}).activeBudgetId==='sep');
  ok('mergeState: пустой местный выбор берётся из облака',
     fn({activeBudgetId:'aug',at:T},{activeBudgetId:null,at:T}).activeBudgetId==='aug');
  let m=fn({budgets:[bdg('x',100)],txs:[{id:'t1',mod:5}],at:T},
           {budgets:[bdg('x',200)],txs:[{id:'t2',mod:7}],at:T});
  ok('mergeState: победила свежая правка бюджета',m.budgets.length===1&&m.budgets[0].mod===200,m.budgets);
  ok('mergeState: траты с двух устройств сложились',m.txs.length===2,m.txs);
  ok('mergeState: удалённая трата не вернулась',
     fn({budgets:[],txs:[{id:'t1',mod:T-9000}],rip:{'tx:t1':T-100},at:T},
        {budgets:[],txs:[{id:'t1',mod:T-9000}],rip:{},at:T}).txs.length===0);
  ok('mergeState: правка позже удаления сохранилась',
     fn({budgets:[],txs:[{id:'t1',mod:T-100}],rip:{'tx:t1':T-9000},at:T},
        {budgets:[],txs:[{id:'t1',mod:T-100}],rip:{},at:T}).txs.length===1);
  const st={budgets:[bdg('a',1)],txs:[{id:'t',mod:2}],activeBudgetId:'a',rip:{},at:T};
  ok('mergeState: слияние с собой ничего не меняет',
     fn(st,st).activeBudgetId==='a'&&fn(st,st).txs.length===1);
}

/* ── Склонение: чистый node, без браузера ────
   Логика русского склонения жила в двух почти одинаковых функциях, третий
   случай (траты при удалении категории) заставил бы написать её в третий
   раз. Свели в plural(); проверка держит все три формы, включая 11-14,
   где «11 операций», а не «11 операция». */
function checkPlural(ok){
  const src=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
  const cut=n=>{const i=src.indexOf('function '+n+'(');if(i<0)throw new Error('нет '+n);
    let d=0;for(let k=src.indexOf('{',i);k<src.length;k++){
      if(src[k]==='{')d++;else if(src[k]==='}'){d--;if(!d)return src.slice(i,k+1);}}};
  const f=new Function(cut('plural')+'\n'+cut('plurOps')+'\n'+cut('plurDays')+
    '\nreturn {plural,plurOps,plurDays};')();
  const cases=[
    ['операций',{1:'операция',2:'операции',5:'операций',11:'операций',21:'операция',111:'операций'},f.plurOps],
    ['дней',    {1:'день',2:'дня',5:'дней',11:'дней',21:'день',25:'дней'},               f.plurDays],
  ];
  for(const [what,exp,fn] of cases){
    const bad=Object.entries(exp).filter(([n,v])=>fn(+n)!==v);
    ok('склонение: '+what, bad.length===0, bad);
  }
  const tr={1:'трата',2:'траты',5:'трат',11:'трат',21:'трата'};
  ok('склонение: траты при удалении категории',
     Object.entries(tr).every(([n,v])=>f.plural(+n,'трата','траты','трат')===v), tr);
}

/* ── 3. Проверки в браузере ─────────────────── */
(async()=>{
  let fails=0;
  const ok=(n,c,g)=>{console.log((c?'  ПРОШЛО ':'  УПАЛО  ')+n+(c?'':'  → '+JSON.stringify(g)));if(!c)fails++;};
  const {srv,url}=await serve(buildDemo());

  const br=await pw.chromium.launch();
  const pg=await (await br.newContext({viewport:{width:430,height:932}})).newPage();
  pg.on('pageerror',e=>{console.log('PAGEERROR:',e.message);fails++;});
  await pg.addInitScript(freezeDate(TODAY));
  await pg.goto(url);
  await pg.evaluate(st=>{window.__CLOUD__=JSON.parse(JSON.stringify(st));
    localStorage.setItem('budget_last_uid','u1');
    localStorage.setItem('budget_backup_u1',JSON.stringify(st));},seedState());
  await pg.evaluate(()=>window.__initApp());
  await pg.waitForTimeout(900);
  const wait=ms=>pg.waitForTimeout(ms);
  const SAVE=1600;   /* debounce 600 + чтение облака + слияние */

  console.log('\n1. Старт после смены месяца');
  let r=await pg.evaluate(()=>({t:today(),a:S.activeBudgetId,shown:(getAB()||{}).id}));
  ok('«сегодня» зафиксировано на '+TODAY,r.t===TODAY,r);
  ok('открылся текущий период, а не прошлый август',r.a==='b-sep'&&r.shown==='b-sep',r);
  await pg.evaluate(()=>swBdg('b-aug'));await wait(SAVE);
  ok('руками уйти в прошлый период можно, и это держится',
     await pg.evaluate(()=>S.activeBudgetId)==='b-aug');

  console.log('\n2. Выбор периода держится, вкладки берут его данные');
  await pg.evaluate(()=>swBdg('b-sep'));await wait(SAVE);
  r=await pg.evaluate(()=>({a:S.activeBudgetId,c:window.__CLOUD__.activeBudgetId}));
  ok('после сохранения активен сентябрь',r.a==='b-sep',r);
  ok('в облако уехал сентябрь',r.c==='b-sep',r);
  const names=()=>pg.evaluate(()=>Array.from(document.querySelectorAll('.tbl tbody .t-tx')).map(e=>e.textContent.trim()));
  await pg.evaluate(()=>setTab('incomes'));await wait(150);
  ok('вкладка Доходы — сентябрьская',JSON.stringify(await names())==='["Зарплата сентября"]',await names());
  await pg.evaluate(()=>setTab('planned'));await wait(150);
  ok('вкладка Расходы отрисовалась',(await names()).length===1,await names());
  await pg.evaluate(()=>setTab('history'));await wait(100);

  console.log('\n3. Архив — только прошедшее');
  await pg.evaluate(()=>{drop=true;render();});await wait(120);
  let menu=await pg.evaluate(()=>Array.from(document.querySelectorAll('.drop-acts > button')).map(b=>b.textContent.trim()));
  console.log('   меню:',JSON.stringify(menu));
  const iS=menu.findIndex(x=>x.includes('Сводка')), iO=menu.findIndex(x=>x.includes('1 окт.')),
        iA=menu.findIndex(x=>x.includes('Архив'));
  ok('октябрь отдельной строкой между Сводкой и Архивом',iS<iO&&iO<iA&&iO>-1,{iS,iO,iA});
  ok('он помечен «будущий»',menu[iO].includes('будущий'),menu[iO]);
  ok('в архиве только прошедшее (счётчик 1)',menu[iA].includes('1'),menu[iA]);
  await pg.evaluate(()=>togArch());await wait(120);
  let arch=await pg.evaluate(()=>Array.from(document.querySelectorAll('.drop .drop-item')).map(b=>b.textContent.trim()));
  ok('внутри архива август и выгрузка',JSON.stringify(arch)==='["Экспортировать в CSV","1 авг. — 31 авг."]',arch);

  console.log('\n4. Деньги');
  r=await pg.evaluate(()=>{var b=getAB(),res=0;
    for(var i=0;i<b.planned.length;i++){var q=calcCatRem(b,b.planned[i].id);if(q>0)res+=q;}
    return{bal:calcDayBal(b),fut:accrued(b,nextDay(today()),b.dateTo),tot:calcTotalBal(b),res:res};});
  /* Инвариант из CLAUDE.md в точной форме: начисления раздают КОТЁЛ, а он
     меньше общего остатка ровно на нерастраченные лимиты — они зарезервированы. */
  ok('сегодня + ещё начислят + резерв категорий = общий остаток',Math.abs(r.bal+r.fut+r.res-r.tot)<0.01,r);
  r=await pg.evaluate(()=>{var b=getAB(),d0=b.dailyBudget,bal0=calcDayBal(b);
    b.incomes[0].amount+=40000;recalcDaily(b);save();
    b.incomes[0].amount-=40000;recalcDaily(b);save();
    return{d0,d1:b.dailyBudget,bal0,bal1:calcDayBal(b)};});
  ok('норма обратима: правка и откат возвращают её',Math.abs(r.d0-r.d1)<0.01,r);
  ok('дневной остаток тоже вернулся',Math.abs(r.bal0-r.bal1)<0.01,r);
  await wait(SAVE);
  await pg.evaluate(()=>{document.getElementById('qa-inp').value='450 обед';qaVal='450 обед';doQA();});
  await wait(200);
  r=await pg.evaluate(()=>{var t=S.txs[S.txs.length-1];return{b:t.budgetId,a:t.amount};});
  ok('трата ушла в выбранный период',r.b==='b-sep'&&r.a===450,r);
  await wait(SAVE);

  console.log('\n5. Вид не начавшегося периода');
  await pg.evaluate(()=>swBdg('b-oct'));await wait(250);
  r=await pg.evaluate(()=>({hdr:(document.querySelector('.balbtn')||{}).textContent,
    bar:(document.querySelector('.cur-bar')||{}).textContent,
    hero:(document.querySelector('.hero-top')||{}).textContent,
    big:(document.querySelector('.hero-big')||{}).textContent}));
  console.log('   ',JSON.stringify(r));
  ok('в шапке период, а не «0 ₽ / день»',r.hdr.includes('окт'),r.hdr);
  ok('полоса говорит «будущий», а не «прошлый»',r.bar.includes('будущий'),r.bar);
  ok('карточка называет дату старта',r.hero.includes('начнётся через 30'),r.hero);
  ok('крупно — вся сумма бюджета',r.big.replace(/\D/g,'')==='130000',r.big);
  await wait(SAVE);

  console.log('\n6. Второе устройство');
  await pg.evaluate(()=>{var c=window.__CLOUD__;
    c.txs.push({id:'t-phone',seq:2,date:'2026-09-01',name:'С телефона',category:'',
                plannedCatId:null,amount:500,budgetId:'b-sep',mod:Date.now()});
    c.activeBudgetId='b-aug';        /* там смотрели август */
    c.at=Date.now()+5000;});        /* и записали позже нас */
  await pg.evaluate(()=>pullAndMerge());await wait(200);
  r=await pg.evaluate(()=>({a:S.activeBudgetId,tx:S.txs.some(t=>t.id==='t-phone')}));
  ok('чужая трата пришла',r.tx===true,r);
  ok('но выбор периода остался наш',r.a==='b-oct',r);

  console.log('\n7. Мастер нового бюджета');
  await pg.evaluate(()=>newBdg());await wait(150);
  r=await pg.evaluate(()=>({from:wd.dateFrom,to:wd.dateTo,inc:wd.incomes.map(i=>i.name+':'+i.amount)}));
  ok('предложен месяц после последнего бюджета',r.from==='2026-11-01'&&r.to==='2026-11-30',r);
  ok('регулярный доход перенесён с суммой',r.inc.length===1&&r.inc[0].includes('130000'),r.inc);
  await pg.evaluate(()=>{wd.incomes[0].amount=140000;wzN(0);});await wait(120);
  await pg.evaluate(()=>wzN(1));await wait(120);
  await pg.evaluate(()=>wzCr());await wait(250);
  r=await pg.evaluate(()=>{var b=getAB();return{n:S.budgets.length,from:b.dateFrom,pot:b.pot,daily:b.dailyBudget};});
  ok('бюджет создан и открыт',r.n===4&&r.from==='2026-11-01',r);
  ok('норма = котёл / 30 дней',Math.abs(r.daily-r.pot/30)<0.01,r);
  await wait(SAVE);

  console.log('\n8. Все вкладки и модалки без ошибок');
  for(const t of ['history','incomes','planned','stats']){
    await pg.evaluate(x=>setTab(x),t);await wait(80);
    ok('вкладка '+t,await pg.evaluate(()=>document.querySelectorAll('.pg *').length)>5);
  }
  await pg.evaluate(()=>setTab('history'));
  for(const m of ['add-income','add-planned','budget-edit','transfer']){
    await pg.evaluate(x=>om(x),m);await wait(90);
    ok('модалка '+m,await pg.evaluate(()=>!!document.querySelector('.overlay,.modal,.sheet')));
    await pg.evaluate(()=>closeModal());await wait(60);
  }

  console.log('\n9. Слияние отдельно от интерфейса');
  checkMerge(ok);

  console.log('\n10. Склонение числительных');
  checkPlural(ok);

  const shot=path.join(os.tmpdir(),'budget-check.png');
  await pg.evaluate(()=>{drop=true;render();});await wait(150);
  await pg.screenshot({path:shot});
  console.log('\nскриншот меню периода:',shot);
  await br.close();srv.close();
  console.log(fails?('ПРОВАЛЕНО проверок: '+fails):'ВСЁ ПРОШЛО');
  process.exit(fails?1:0);
})();
