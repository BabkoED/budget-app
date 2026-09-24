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

  /* ── Доходы и категории внутри бюджета ──────
     Пока бюджет побеждал целым объектом, правка с одного устройства молча
     съедала правку с другого. Воспроизведено 20.09.2026 на живом mergeState:
     аванс, поднятый на телефоне до 60 000, возвращался к 50 000, потому что
     на ноутбуке в том же бюджете тронули лимит категории. */
  const full=(mod,avans,prod,extra)=>Object.assign({id:'b1',mod:mod,
    dateFrom:'2026-09-01',dateTo:'2026-09-30',
    incomes:[{id:'i1',name:'Зарплата',amount:120000,mod:1},
             {id:'i2',name:'Аванс',amount:avans.v,mod:avans.mod}],
    planned:[{id:'p1',name:'Продукты',amount:prod.v,mod:prod.mod}]},extra||{});
  /* облако — телефон (правил аванс раньше), местное — ноутбук (лимит позже) */
  let mb=fn({budgets:[full(T+100,{v:60000,mod:T+100},{v:30000,mod:1})],txs:[],rip:{},at:T},
            {budgets:[full(T+200,{v:50000,mod:1},{v:35000,mod:T+200})],txs:[],rip:{},at:T}).budgets[0];
  ok('mergeState: правка дохода с другого устройства не потерялась',
     mb.incomes.filter(i=>i.id==='i2')[0].amount===60000,mb.incomes);
  ok('mergeState: и своя правка категории осталась',
     mb.planned[0].amount===35000,mb.planned);
  ok('mergeState: порядок доходов не перетасовался',
     mb.incomes.map(i=>i.id).join()==='i1,i2',mb.incomes);
  /* Верхний уровень бюджета — по-прежнему целиком за свежей стороной:
     даты, котёл и ставки связаны между собой и поэлементно не смешиваются. */
  ok('mergeState: верхний уровень бюджета взят у свежей стороны',mb.mod===T+200,mb.mod);

  /* Удалённый доход не возвращается со второго устройства */
  mb=fn({budgets:[full(T+100,{v:50000,mod:T-9000},{v:30000,mod:1})],txs:[],rip:{},at:T},
        {budgets:[full(T+200,{v:50000,mod:T-9000},{v:30000,mod:1})],txs:[],
         rip:{'inc:i2':T-100},at:T}).budgets[0];
  ok('mergeState: удалённый доход не вернулся',
     mb.incomes.length===1&&mb.incomes[0].id==='i1',mb.incomes);
  /* но правка ПОЗЖЕ удаления сильнее: доход завели обратно осознанно */
  mb=fn({budgets:[full(T+100,{v:70000,mod:T-100},{v:30000,mod:1})],txs:[],rip:{},at:T},
        {budgets:[full(T+200,{v:50000,mod:T-9000},{v:30000,mod:1})],txs:[],
         rip:{'inc:i2':T-9000},at:T}).budgets[0];
  ok('mergeState: правка дохода позже удаления сохранилась',
     mb.incomes.length===2&&mb.incomes.filter(i=>i.id==='i2')[0].amount===70000,mb.incomes);

  /* Новая категория с одной стороны приезжает, а не пропадает */
  const withNew=full(T+100,{v:50000,mod:1},{v:30000,mod:1});
  withNew.planned=withNew.planned.concat([{id:'p2',name:'Связь',amount:900,mod:T+100}]);
  mb=fn({budgets:[withNew],txs:[],rip:{},at:T},
        {budgets:[full(T+200,{v:50000,mod:1},{v:30000,mod:1})],txs:[],rip:{},at:T}).budgets[0];
  ok('mergeState: новая категория со второго устройства приехала',
     mb.planned.length===2&&mb.planned[1].id==='p2',mb.planned);

  /* Равные метки: побеждает эта машина, а не облако. Иначе правка, не
     поднявшая mod, откатывается на ближайшем сохранении — молча. */
  mb=fn({budgets:[full(T+100,{v:50000,mod:5},{v:30000,mod:5})],txs:[],rip:{},at:T},
        {budgets:[full(T+100,{v:77000,mod:5},{v:30000,mod:5})],txs:[],rip:{},at:T}).budgets[0];
  ok('mergeState: при равных метках сильнее местная сторона',
     mb.incomes.filter(i=>i.id==='i2')[0].amount===77000,mb.incomes);

  /* Бюджет, который есть только на одной стороне, не теряет своих строк */
  mb=fn({budgets:[full(T+100,{v:50000,mod:1},{v:30000,mod:1})],txs:[],rip:{},at:T},
        {budgets:[],txs:[],rip:{},at:T}).budgets[0];
  ok('mergeState: односторонний бюджет цел',
     mb.incomes.length===2&&mb.planned.length===1,mb);
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

  /* ── 11. Правка в СЕРЕДИНЕ периода ───────────
     Своя страница с «сегодня» 10 сентября. На TODAY стенда (1-е число)
     recalcDaily уходит в ветку «период только начался» и считает норму
     обычной формулой — ветку правки середины периода там не проверить ничем.
     А сломалось 10.09.2026 именно в ней: крупное перераспределение загнало
     ставку в минус, accrued обрезал минус нулём, начисления за эти дни
     потерялись — «осталось −1 212 ₽, завтра +0 ₽» при 32 149 ₽ свободных
     на дневные. Лечилось только перезапуском (там сводит reconcileOnLoad). */
  console.log('\n11. Правка в середине периода');
  const pg2=await (await br.newContext({viewport:{width:430,height:932}})).newPage();
  pg2.on('pageerror',e=>{console.log('PAGEERROR(mid):',e.message);fails++;});
  await pg2.addInitScript(freezeDate('2026-09-10'));
  await pg2.goto(url);
  await pg2.evaluate(st=>{window.__CLOUD__=JSON.parse(JSON.stringify(st));
    localStorage.setItem('budget_last_uid','u1');
    localStorage.setItem('budget_backup_u1',JSON.stringify(st));},seedState());
  await pg2.evaluate(()=>window.__initApp());
  await pg2.waitForTimeout(900);
  r=await pg2.evaluate(()=>{
    var b=getAB();
    function inv(){                     /* тот же инвариант, что в блоке 4 */
      var res=0;
      for(var i=0;i<b.planned.length;i++){var q=calcCatRem(b,b.planned[i].id);if(q>0)res+=q;}
      return calcDayBal(b)+accrued(b,nextDay(today()),b.dateTo)+res-calcTotalBal(b);
    }
    /* воспроизводим состояние после крупного перераспределения */
    b.rates=[{from:b.dateFrom,v:rateOn(b,b.dateFrom)},{from:today(),v:-5000}];
    b.dailyBudget=0;
    var before={d:b.dailyBudget,bal:calcDayBal(b),inv:inv()};
    /* любая правка котла — перевод в категорию и обратно, как это делает doTr */
    b.planned[0].amount+=1000;recalcDaily(b);
    b.planned[0].amount-=1000;recalcDaily(b);
    var want=(potOf(b)-accrued(b,accrualStart(b),prevDay(today())))/getDays(today(),b.dateTo);
    return {before:before,d:b.dailyBudget,bal:calcDayBal(b),want:want,inv:inv()};
  });
  ok('залипшая в минусе норма сводится при первой правке, без перезапуска',
     r.before.d===0&&r.d>0&&Math.abs(r.d-r.want)<0.01,r);
  ok('и денежный инвариант в середине периода снова сходится',
     Math.abs(r.before.inv)>1&&Math.abs(r.inv)<0.01,r);
  r=await pg2.evaluate(()=>{
    var b=getAB(),cat=b.planned[0];
    var before=(document.querySelector('.hero-sub')||{}).textContent||'';
    S.txs.push({id:'t-cat-today',seq:98,date:today(),name:'Аренда',category:cat.name,
      categoryEmoji:cat.emoji,plannedCatId:cat.id,amount:9000,budgetId:b.id,mod:Date.now()});
    render();
    var sub=(document.querySelector('.hero-sub')||{}).textContent||'';
    var w=parseFloat(((document.querySelector('.hero-fill')||{style:{}}).style.width)||'0');
    S.txs=S.txs.filter(function(t){return t.id!=='t-cat-today';});render();
    return {before:before,sub:sub,w:w,bal:calcDayBal(b)};
  });
  ok('категорийная трата дня видна в подписи, а не тонет в нуле',/по категориям/.test(r.sub),r.sub);
  ok('но полоса от неё не обнулилась — она про дневной запас',r.w>0&&r.bal>0,r);
  ok('без категорийных трат лишней подписи нет',!/по категориям/.test(r.before),r.before);

  /* ── 12. Дата у дохода и детализация сводки ──
     Своя страница с чистым посевом: к этому месту блоки 7 и 11 уже создали
     лишний бюджет и подвинули ставки, а здесь нужен предсказуемый сентябрь.

     Главное, что проверяется: дата начисления НЕ трогает счёт. Котёл, норма
     и общий остаток обязаны остаться теми же до копейки — иначе это уже
     вариант B (норма до ближайшего прихода), на который не договаривались. */
  console.log('\n12. Дата у дохода и детализация сводки');
  const pg3=await (await br.newContext({viewport:{width:430,height:932}})).newPage();
  pg3.on('pageerror',e=>{console.log('PAGEERROR(inc):',e.message);fails++;});
  await pg3.addInitScript(freezeDate(TODAY));
  await pg3.goto(url);
  await pg3.evaluate(st=>{window.__CLOUD__=JSON.parse(JSON.stringify(st));
    localStorage.setItem('budget_last_uid','u1');
    localStorage.setItem('budget_backup_u1',JSON.stringify(st));},seedState());
  await pg3.evaluate(()=>window.__initApp());
  await pg3.waitForTimeout(900);

  r=await pg3.evaluate(()=>{var b=getAB();
    return{id:b.id,tot:calcTotalBal(b),cash:calcCashBal(b),pend:incPending(b).length};});
  ok('доход без даты считается уже поступившим',
     r.id==='b-sep'&&Math.abs(r.tot-r.cash)<0.01&&r.pend===0,r);

  r=await pg3.evaluate(()=>{
    var b=getAB(), before={pot:b.pot,daily:b.dailyBudget,tot:calcTotalBal(b)};
    b.incomes[0].date='2026-09-25';                      /* зарплата придёт 25-го */
    b.incomes.push({id:'i-now',name:'Кэшбэк',emoji:'💳',amount:30000,recur:false,date:''});
    recalcDaily(b);save();invalidateSpentCache();
    var pend=incPending(b), ps=0;
    for(var i=0;i<pend.length;i++)ps+=pend[i].amount;
    return{before:before,pot:b.pot,daily:b.dailyBudget,
           tot:calcTotalBal(b),cash:calcCashBal(b),ps:ps,pend:pend.length};});
  ok('на картах сейчас = только поступившее',Math.abs(r.cash-30000)<0.01,r);
  ok('разница между общим и наличным = сумма ожидаемого',
     Math.abs(r.tot-r.cash-r.ps)<0.01&&r.pend===1,r);
  ok('дата не сдвинула норму: она выросла ровно на новый доход',
     Math.abs(r.daily-(r.before.daily+30000/30))<0.01,r);
  ok('и общий остаток вырос ровно на него же',
     Math.abs(r.tot-(r.before.tot+30000))<0.01,r);
  await wait(SAVE);

  await pg3.evaluate(()=>setTab('incomes'));await wait(150);
  r=await pg3.evaluate(()=>({cash:(document.querySelector('.srow-cash')||{}).textContent||'',
    pend:(document.querySelector('.srow-pend')||{}).textContent||'',
    wait:document.querySelectorAll('.t-wait').length}));
  ok('на экране Доходы есть строка «На картах сейчас»',/На картах сейчас/.test(r.cash),r.cash);
  ok('и строка ожидаемого прихода с датой',/25 сент/.test(r.pend)&&/150\s?000/.test(r.pend.replace(/ /g,' ')),r.pend);
  ok('сам ожидаемый доход помечен в списке',r.wait===1,r);

  /* Прошедшая дата — это пришедшие деньги, а не вечное ожидание */
  r=await pg3.evaluate(()=>{var b=getAB();b.incomes[0].date='2026-08-28';
    invalidateSpentCache();render();
    var c=calcCashBal(b),p=incPending(b).length;
    b.incomes[0].date='2026-09-25';invalidateSpentCache();render();
    return{c:c,p:p,tot:calcTotalBal(b)};});
  ok('прошедшая дата считается поступившей',Math.abs(r.c-r.tot)<0.01&&r.p===0,r);

  /* Дата вне периода бессмысленна и не должна сохраняться */
  await pg3.evaluate(()=>om('add-income'));await wait(120);
  await pg3.evaluate(()=>{document.getElementById('mn').value='Премия';
    document.getElementById('ma').value='5000';
    document.getElementById('mdi').value='2026-11-05';saveInc();});
  await wait(200);
  r=await pg3.evaluate(()=>{var b=getAB(),i=b.incomes.filter(function(x){return x.name==='Премия';})[0];
    return{has:!!i,date:i?i.date:'?'};});
  ok('дата вне периода не сохранилась, доход остался',r.has&&r.date==='',r);
  await wait(SAVE);

  /* Правка после слияния. Обработчики держат бюджет с последней отрисовки,
     а слияние без перемен в отпечатке экран не перерисовывает. Пока слияние
     собирало бюджет в новый объект, доход, сохранённый после него, уходил
     в выброшенную копию и молча пропадал (24.09.2026). Два пути: вторая
     запись подряд, пока идёт отложенное сохранение, и возврат из другого
     приложения с открытым окном. */
  await pg3.evaluate(()=>{om('add-income');document.getElementById('mn').value='Подряд-1';
    document.getElementById('ma').value='1000';saveInc();om('add-income');});
  await wait(SAVE);
  await pg3.evaluate(()=>{document.getElementById('mn').value='Подряд-2';
    document.getElementById('ma').value='2000';saveInc();});
  await wait(SAVE);
  await pg3.evaluate(()=>om('add-income'));
  await pg3.evaluate(()=>pullAndMerge());await wait(150);
  await pg3.evaluate(()=>{document.getElementById('mn').value='После-возврата';
    document.getElementById('ma').value='3000';saveInc();});
  await wait(SAVE);
  r=await pg3.evaluate(()=>{var has=function(st,n){var b=st.budgets.filter(function(x){return x.id===getAB().id;})[0];
      return b.incomes.some(function(i){return i.name===n;});};
    return{loc:['Подряд-1','Подряд-2','После-возврата'].map(function(n){return has(S,n);}),
           cld:['Подряд-1','Подряд-2','После-возврата'].map(function(n){return has(window.__CLOUD__,n);}),
           same:S.budgets.indexOf(getAB())>-1};});
  ok('второй доход подряд не теряется',r.loc[1]&&r.cld[1],r);
  ok('доход после фонового слияния не теряется',r.loc[2]&&r.cld[2],r);

  /* Перенос числа месяца в новый период */
  r=await pg3.evaluate(()=>({same:shiftDOM('2026-09-25','2026-10-01','2026-10-31'),
    late:shiftDOM('2026-09-10','2026-10-15','2026-11-14'),
    none:shiftDOM('2026-01-31','2026-02-01','2026-02-28'),
    empty:shiftDOM('','2026-10-01','2026-10-31')}));
  ok('повторяющийся доход переносит число месяца',r.same==='2026-10-25',r);
  ok('если числа в этом месяце уже нет — берётся следующий',r.late==='2026-11-10',r);
  ok('несуществующее число даты не получает',r.none===''&&r.empty==='',r);
  /* Период длиннее двух месяцев: раньше перебирались ровно два, и число,
     попадающее в третий, теряло дату на ровном месте. */
  r=await pg3.evaluate(()=>({long:shiftDOM('2026-09-05','2026-10-10','2026-12-31'),
    year:shiftDOM('2026-09-05','2026-10-10','2027-06-30')}));
  ok('на длинном периоде число ищется до его конца',r.long==='2026-11-05'&&r.year==='2026-11-05',r);

  /* ── Границы периода двигают НЕ ТОЛЬКО через доход ──
     Проверка даты жила в saveInc, а границы меняются ещё в двух местах.
     Пока перечни разные, дата спокойно оставалась снаружи периода. */
  r=await pg3.evaluate(()=>{
    var b=getAB();
    b.incomes[0].date='2026-09-25';                    /* внутри 01.09–30.09 */
    var was=b.incomes[0].date;
    om('budget-edit');render();
    document.getElementById('be-from').value='2026-09-01';
    document.getElementById('be-to').value='2026-09-20';   /* сузили до 20-го */
    saveBdgDates();
    var after={date:b.incomes[0].date,to:b.dateTo,amount:b.incomes[0].amount,
               tot:calcTotalBal(b),cash:calcCashBal(b),pend:incPending(b).length};
    b.dateTo='2026-09-30';b.incomes[0].date='2026-09-25';recalcDaily(b);save();
    return{was:was,after:after};});
  ok('сужение периода гасит дату, оставшуюся снаружи',r.after.date==='',r);
  ok('и сам доход при этом не потерялся',r.after.amount===120000&&r.after.pend===0,r);
  ok('числа после сужения сходятся',Math.abs(r.after.tot-r.after.cash)<0.01,r);
  await wait(SAVE);

  /* Мастер: даты доходов считаются в initWD от первоначальных границ,
     а потом человек может подвинуть период — и перенесённая дата окажется
     за пределами бюджета, который ещё даже не создан. */
  r=await pg3.evaluate(()=>{
    /* мастер тянет доходы из ПОСЛЕДНЕГО по датам бюджета — это октябрь */
    var oct=S.budgets.filter(function(x){return x.id==='b-oct';})[0];
    oct.incomes[0].date='2026-10-25';oct.incomes[0].recur=true;save();
    newBdg();                                   /* мастер предложит ноябрь */
    var auto=wd.incomes[0].date;                /* ожидаем 25 ноября */
    wd.dateFrom='2026-11-01';wd.dateTo='2026-11-15';   /* человек сузил период */
    wd.incomes[0].amount=50000;
    wzCr();
    var nb=S.budgets.filter(function(x){return x.dateFrom==='2026-11-01';})[0]||{incomes:[]};
    return{auto:auto,made:(nb.incomes[0]||{}).date,to:nb.dateTo,
           amount:(nb.incomes[0]||{}).amount};});
  ok('мастер переносит дату повторяющегося дохода',r.auto==='2026-11-25',r);
  ok('но если период подвинули — дата не уезжает за его край',
     r.made===''&&r.to==='2026-11-15'&&r.amount===50000,r);
  await wait(SAVE);

  /* ── Две машины правят ОДИН бюджет ──────────
     Чистое слияние проверено в блоке 9. Здесь то же самое, но через живое
     приложение: правка уезжает в облако, местная правка идёт своим путём,
     и обе обязаны уцелеть — вместе со сведённым котлом. */
  await pg3.evaluate(()=>swBdg('b-sep'));await wait(SAVE);
  r=await pg3.evaluate(()=>{
    var b=getAB(), inc=b.incomes[0], future=Date.now()+5000;
    /* телефон поднял зарплату на 10 000 и уже записал это в облако */
    var c=window.__CLOUD__.budgets.filter(function(x){return x.id==='b-sep';})[0];
    var ci=c.incomes.filter(function(x){return x.id===inc.id;})[0];
    ci.amount=inc.amount+10000;ci.mod=future;c.mod=future;window.__CLOUD__.at=future;
    /* а здесь в это же время подняли лимит категории */
    b.planned[0].amount=25000;touch(b.planned[0]);recalcDaily(b);save();
    return{incWas:inc.amount,plnWas:b.planned[0].amount};});
  await wait(SAVE);
  await pg3.evaluate(()=>pullAndMerge());await wait(300);
  let m=await pg3.evaluate(()=>{
    var b=getAB(),res=0;
    for(var i=0;i<b.planned.length;i++){var q=calcCatRem(b,b.planned[i].id);if(q>0)res+=q;}
    return{inc:b.incomes[0].amount,pln:b.planned[0].amount,pot:b.pot,potOf:potOf(b),
           inv:calcDayBal(b)+accrued(b,nextDay(today()),b.dateTo)+res-calcTotalBal(b),
           order:b.incomes.map(function(x){return x.name;}).join()};});
  ok('чужая правка дохода доехала',m.inc===r.incWas+10000,{m,r});
  ok('и своя правка категории не затёрлась',m.pln===25000,m);
  ok('порядок доходов на экране не перетасовался',/^Зарплата сентября/.test(m.order),m.order);
  ok('котёл сведён с новыми суммами сразу после слияния',
     Math.abs(m.pot-m.potOf)<0.01,m);
  ok('и денежный инвариант после слияния сходится',Math.abs(m.inv)<0.01,m);
  await wait(SAVE);

  /* Каждая правка строки обязана поднимать её метку — иначе слияние вернёт
     прежнее значение. Проверяем ВСЕ пути правки, а не только модалку дохода:
     перенос остатка в дневные и гашение даты при сужении периода меняют
     строку в обход saveInc/savePln. */
  /* «Сегодня» на стенде заморожено, поэтому Date.now() всегда одинаков и
     touch не двигает метку вперёд. Ставим строке заведомо старую метку
     и смотрим, что правка её подняла. */
  r=await pg3.evaluate(()=>{
    var b=getAB(),out={};
    var p=b.planned[0];p.amount+=5000;p.mod=1;
    moveRemToDaily(p.id);                       /* остаток категории в дневные */
    out.moveRem=(b.planned[0].mod||0)>1;
    var inc=b.incomes[0];inc.date='2026-09-25';inc.mod=1;
    b.dateTo='2026-09-20';clampIncDates(b);     /* сузили период — дата гасится */
    out.clamp=inc.date===''&&(inc.mod||0)>1;
    b.dateTo='2026-09-30';recalcDaily(b);save();
    return out;});
  ok('перенос остатка в дневные поднимает метку категории',r.moveRem===true,r);
  ok('гашение даты поднимает метку дохода',r.clamp===true,r);
  await wait(SAVE);

  /* Слияние собирает поэлементно ЛЮБОЙ бюджет, а котёл достаётся победившей
     стороне — значит сводить надо не только текущий. Заранее созданный октябрь
     после правок с двух машин показывал котёл 120 000 при фактических 115 000,
     и расхождение жило до дня, когда октябрь станет текущим: откроешь
     приложение не первого числа — прожитые дни уже начислены по неверной
     ставке, а их не переписывают. Закрытый период при этом трогать нельзя. */
  r=await pg3.evaluate(async()=>{
    var oct=S.budgets.filter(function(x){return x.id==='b-oct';})[0];
    var aug=S.budgets.filter(function(x){return x.id==='b-aug';})[0];
    var augRates=JSON.stringify(aug.rates), augPot=aug.pot;
    aug.pot=(aug.pot||0)+777;               /* закрытый период намеренно кривой */
    var c=window.__CLOUD__.budgets.filter(function(x){return x.id==='b-oct';})[0];
    c.incomes[0].amount+=10000;c.incomes[0].mod=Date.now()+5000;
    c.mod=Date.now()+5000;c.pot=(c.pot||0)+10000;window.__CLOUD__.at=Date.now()+5000;
    oct.planned[0].amount+=5000;touch(oct.planned[0]);recalcDaily(oct);save();
    await new Promise(function(r){setTimeout(r,50);});
    await pullAndMerge();
    var m=S.budgets.filter(function(x){return x.id==='b-oct';})[0];
    var a2=S.budgets.filter(function(x){return x.id==='b-aug';})[0];
    var out={cur:(getCurrentBudget()||{}).id,pot:m.pot,potOf:potOf(m),
             augSame:JSON.stringify(a2.rates)===augRates,augPot:a2.pot};
    a2.pot=augPot;
    return out;});
  ok('октябрь ещё не текущий — проверяем именно не текущий бюджет',r.cur==='b-sep',r);
  ok('котёл будущего бюджета сведён после слияния',Math.abs(r.pot-r.potOf)<0.01,r);
  ok('закрытый период при этом не переписан',r.augSame===true&&r.augPot===r.augPot,r);
  await wait(SAVE);

  console.log('   детализация сводки');
  await pg3.evaluate(()=>{
    var mk=(id,seq,d,n,a)=>({id:id,seq:seq,date:d,name:n,category:'Продукты',
      categoryEmoji:'🛒',plannedCatId:null,amount:a,budgetId:'b-aug',mod:1});
    S.txs.push(mk('s1',1,'2026-08-20','Пятёрочка',1200));
    S.txs.push(mk('s2',2,'2026-08-21','Магнит',800));
    invalidateSpentCache();setTab('stats');render();});
  await wait(150);
  r=await pg3.evaluate(()=>({n:document.querySelectorAll('.sd-row').length,
    i:_statArr.findIndex(function(x){return x.name==='Продукты';}),
    sum:(_statArr.filter(function(x){return x.name==='Продукты';})[0]||{}).sum}));
  ok('до нажатия деталей на экране нет',r.n===0,r);
  ok('категория «Продукты» собрана из двух трат',r.sum===2000&&r.i>-1,r);
  await pg3.evaluate(i=>togStat(i),r.i);await wait(150);
  let d=await pg3.evaluate(()=>({
    rows:Array.from(document.querySelectorAll('.sd-row')).map(e=>e.textContent),
    sum:Array.from(document.querySelectorAll('.sd-am'))
          .reduce((s,e)=>s+ +e.textContent.replace(/\D/g,''),0),
    open:statOpen}));
  ok('раскрылись именно её траты, обе',d.rows.length===2&&d.open==='Продукты',d.rows);
  ok('сумма раскрытых трат сходится с суммой строки',d.sum===2000,d);
  ok('свежая трата сверху',/21 авг/.test(d.rows[0]),d.rows);
  await pg3.evaluate(i=>togStat(i),r.i);await wait(120);
  ok('повторное нажатие закрывает',
     await pg3.evaluate(()=>document.querySelectorAll('.sd-row').length)===0);
  await pg3.evaluate(i=>{togStat(i);setRange('cur');},r.i);await wait(150);
  ok('смена интервала снимает раскрытие',
     await pg3.evaluate(()=>statOpen)===''&&
     await pg3.evaluate(()=>document.querySelectorAll('.sd-row').length)===0);

  const shot=path.join(os.tmpdir(),'budget-check.png');
  await pg.evaluate(()=>{drop=true;render();});await wait(150);
  await pg.screenshot({path:shot});
  console.log('\nскриншот меню периода:',shot);
  await br.close();srv.close();
  console.log(fails?('ПРОВАЛЕНО проверок: '+fails):'ВСЁ ПРОШЛО');
  process.exit(fails?1:0);
})();
