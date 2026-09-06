/* Замер интерфейса и доступности на живом приложении.
 *
 *   pw tools/audit-ui.js          (Linux)
 *   node tools/audit-ui.js        (Mac)
 *
 * Зачем отдельный прогон. Скиллы дизайн-ревью (apple-design и прочие)
 * рассуждают о макете по коду и скриншотам — контраст и размеры кнопок они
 * называют НА ГЛАЗ. Такие числа выглядят как факт, но фактом не являются.
 * Этот файл измеряет то же самое браузером: реальный цвет после наложения
 * прозрачностей, реальный размер элемента после вёрстки, реальное поведение
 * при увеличенном шрифте. Ревью даёт рубрику, прогон — числа.
 *
 * Пороги взяты из HIG/WCAG AA (см. skills/apple-design/references/hig):
 *   контраст  — 4.5:1 обычный текст, 3:1 крупный (>=24px или >=18.7px жирный)
 *   нажатие   — 44x44 норма, 28x28 нижний предел
 *   шрифт     — не мельче 11pt (~14.7px), тонкие начертания ещё крупнее
 *
 * Прогон ничего не чинит и ничего не пишет в репозиторий — только считает.
 */
const path = require('path');
const {buildDemo, seedState, seedStateBusy, serve, freezeDate, TODAY, loadPlaywright} = require('./demo.js');
const pw = loadPlaywright();

/* ── Замеры, исполняемые в браузере ───────────
   Одной строкой в evaluate() их не удержать, поэтому текст функции
   передаётся целиком и разворачивается на странице. */
const PROBE = `(() => {
  /* --- цвет --- */
  const parse = c => {
    const m = String(c).match(/[\\d.]+/g);
    if (!m) return null;
    return {r:+m[0], g:+m[1], b:+m[2], a: m.length > 3 ? +m[3] : 1};
  };
  /* Наложение полупрозрачного цвета на непрозрачный. Без этого шага
     контраст на карточках и всплывающих меню считается неверно. */
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1
  });
  const lum = c => {
    const f = v => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
    return 0.2126*f(c.r) + 0.7152*f(c.g) + 0.0722*f(c.b);
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1,l2) + 0.05) / (Math.min(l1,l2) + 0.05);
  };
  /* Настоящий фон под элементом: идём вверх, пока не упрёмся в непрозрачный. */
  const bgOf = el => {
    let stack = [], n = el;
    while (n && n.nodeType === 1) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) { stack.push(c); if (c.a === 1) break; }
      n = n.parentElement;
    }
    if (!stack.length) return {r:255,g:255,b:255,a:1};
    let acc = stack[stack.length - 1];
    for (let i = stack.length - 2; i >= 0; i--) acc = over(stack[i], acc);
    return acc;
  };
  const visible = el => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0.05
        && r.width > 0 && r.height > 0;
  };
  const label = el => {
    const t = (el.textContent || '').trim().replace(/\\s+/g, ' ');
    return (el.id ? '#' + el.id + ' ' : '') + (el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') + ' ' : '')
      + (t.length > 28 ? t.slice(0,28) + '…' : t);
  };

  const out = {contrast: [], targets: [], tiny: [], unnamed: [], overflow: []};

  /* --- 1. контраст текста --- */
  document.querySelectorAll('*').forEach(el => {
    if (!visible(el)) return;
    /* только узлы с собственным текстом, иначе один и тот же текст
       посчитается на каждом предке */
    const own = Array.from(el.childNodes)
      .filter(n => n.nodeType === 3 && n.textContent.trim().length)
      .map(n => n.textContent.trim()).join(' ');
    if (!own) return;
    const s = getComputedStyle(el);
    const fg0 = parse(s.color); if (!fg0) return;
    const bg = bgOf(el);
    const fg = fg0.a < 1 ? over(fg0, bg) : fg0;
    const px = parseFloat(s.fontSize), w = parseInt(s.fontWeight) || 400;
    const large = px >= 24 || (px >= 18.66 && w >= 700);
    const need = large ? 3 : 4.5;
    const got = ratio(fg, bg);
    if (got < need) out.contrast.push({
      el: label(el), text: own.slice(0,40), fg: s.color, bg: 'rgb(' +
        [bg.r,bg.g,bg.b].map(Math.round).join(',') + ')',
      px, weight: w, got: +got.toFixed(2), need
    });
    if (px < 14.7) out.tiny.push({el: label(el), px, weight: w, text: own.slice(0,30)});
  });

  /* --- 2. размер зоны нажатия --- */
  const tappable = 'button, a[href], input, select, textarea, [onclick], [role="button"], summary';
  document.querySelectorAll(tappable).forEach(el => {
    if (!visible(el)) return;
    const r = el.getBoundingClientRect();
    const w = Math.round(r.width), h = Math.round(r.height);
    if (w < 44 || h < 44) out.targets.push({el: label(el), w, h,
      severity: (w < 28 || h < 28) ? 'critical' : 'high'});
    /* доступное имя. Голая эмодзи-иконка для чтеца с экрана — пустая кнопка.
       ЛОВУШКА, на которой этот замер уже ошибся: поле может получать имя не
       от себя, а от подписи — либо обёрнутой вокруг него, либо связанной
       через for/id. Без этой проверки замер требует чинить то, что цело. */
    const strip = t => String(t || '').replace(/[\\p{Extended_Pictographic}\\uFE0F\\u200D]/gu, '').trim();
    const wrapLabel = el.closest('label');
    const forLabel = el.id ? document.querySelector('label[for="' + el.id + '"]') : null;
    const name = strip(el.textContent) || el.getAttribute('aria-label')
      || el.getAttribute('title') || el.getAttribute('placeholder')
      || (wrapLabel ? strip(wrapLabel.textContent) : '')
      || (forLabel ? strip(forLabel.textContent) : '');
    /* подложки-закрывашки кнопками не являются, чтец их и не должен видеть */
    const isScrim = el.getAttribute('aria-hidden') === 'true'
      || /\\b(bk-drop|overlay|scrim|backdrop)\\b/.test(el.className || '');
    if (!name && !isScrim) out.unnamed.push({el: label(el), tag: el.tagName.toLowerCase(),
      raw: (el.textContent || '').trim().slice(0,12)});
  });

  return out;
})()`;

/* Переполнение при увеличенном шрифте: сравниваем ширину содержимого
   с шириной окна. Считается после подмены базового кегля. */
const OVERFLOW = `(() => {
  const bad = [];
  document.querySelectorAll('*').forEach(el => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (r.width === 0) return;
    if (r.right > window.innerWidth + 1 || r.left < -1) {
      const t = (el.textContent || '').trim().replace(/\\s+/g,' ').slice(0,30);
      bad.push({el: (el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\\s+/)[0] : el.tagName.toLowerCase()),
        right: Math.round(r.right), win: window.innerWidth, text: t});
    }
  });
  /* схлопываем однотипные */
  const seen = new Map();
  bad.forEach(b => { if (!seen.has(b.el)) seen.set(b.el, b); });
  return Array.from(seen.values()).slice(0, 12);
})()`;

const uniq = (arr, key) => {
  const m = new Map();
  arr.forEach(x => { const k = key(x); if (!m.has(k)) m.set(k, x); });
  return Array.from(m.values());
};

(async () => {
  const {srv, url} = await serve(buildDemo());
  const br = await pw.chromium.launch();
  const ctx = await br.newContext({viewport: {width: 430, height: 932}, deviceScaleFactor: 2});
  const pg = await ctx.newPage();
  pg.on('pageerror', e => console.log('PAGEERROR:', e.message));
  await pg.addInitScript(freezeDate(TODAY));
  await pg.goto(url);
  await pg.evaluate(st => {
    window.__CLOUD__ = JSON.parse(JSON.stringify(st));
    localStorage.setItem('budget_last_uid', 'u1');
    localStorage.setItem('budget_backup_u1', JSON.stringify(st));
  }, seedStateBusy());   /* рабочее состояние, а не пустое: см. demo.js */
  await pg.evaluate(() => window.__initApp());
  await pg.waitForTimeout(900);
  await pg.evaluate(() => swBdg('b-sep'));
  await pg.waitForTimeout(400);

  /* Обходим экраны: каждый добавляет свои элементы. */
  const screens = [
    ['Главная / история', async () => { await pg.evaluate(() => setTab('history')); }],
    ['Доходы',            async () => { await pg.evaluate(() => setTab('incomes')); }],
    ['Расходы',           async () => { await pg.evaluate(() => setTab('planned')); }],
    ['Статистика',        async () => { await pg.evaluate(() => setTab('stats')); }],
    ['Меню периода',      async () => { await pg.evaluate(() => { drop = true; render(); }); }],
    ['Новый доход',       async () => { await pg.evaluate(() => { drop = false; render(); om('add-income'); }); }],
    ['Правка бюджета',    async () => { await pg.evaluate(() => { closeModal(); om('budget-edit'); }); }],
    ['Перевод',           async () => { await pg.evaluate(() => { closeModal(); om('transfer'); }); }]
  ];

  const all = {contrast: [], targets: [], tiny: [], unnamed: []};
  const shots = [];
  for (const [name, go] of screens) {
    await go();
    await pg.waitForTimeout(260);
    const r = await pg.evaluate(PROBE);
    ['contrast', 'targets', 'tiny', 'unnamed'].forEach(k =>
      r[k].forEach(x => all[k].push(Object.assign({screen: name}, x))));
    const f = path.join('/tmp', 'sintra-' + shots.length + '.png');
    await pg.screenshot({path: f});
    shots.push([name, f]);
  }
  await pg.evaluate(() => closeModal());

  const C = uniq(all.contrast, x => x.el + x.text);
  const T = uniq(all.targets,  x => x.el + x.w + x.h);
  const N = uniq(all.unnamed,  x => x.el);
  const S = uniq(all.tiny,     x => x.el + x.px);

  console.log('\\n══ КОНТРАСТ ниже нормы ══ найдено: ' + C.length);
  C.sort((a, b) => a.got - b.got).slice(0, 18).forEach(x =>
    console.log('  ' + String(x.got).padEnd(5) + ' need ' + x.need +
      '  ' + String(Math.round(x.px)) + 'px/' + x.weight +
      '  ' + x.fg + ' на ' + x.bg + '   [' + x.screen + '] ' + x.el));

  console.log('\\n══ ЗОНА НАЖАТИЯ меньше 44x44 ══ найдено: ' + T.length +
    ' (из них меньше 28: ' + T.filter(x => x.severity === 'critical').length + ')');
  T.sort((a, b) => (a.w * a.h) - (b.w * b.h)).slice(0, 18).forEach(x =>
    console.log('  ' + (x.w + 'x' + x.h).padEnd(9) + x.severity.padEnd(9) +
      '[' + x.screen + '] ' + x.el));

  console.log('\\n══ КНОПКИ БЕЗ ИМЕНИ для чтеца ══ найдено: ' + N.length);
  N.slice(0, 15).forEach(x =>
    console.log('  <' + x.tag + '> «' + x.raw + '»  [' + x.screen + '] ' + x.el));

  console.log('\\n══ ШРИФТ мельче 11pt (14.7px) ══ найдено: ' + S.length);
  S.sort((a, b) => a.px - b.px).slice(0, 12).forEach(x =>
    console.log('  ' + x.px + 'px/' + x.weight + '  [' + x.screen + '] ' + x.el));

  /* --- увеличенный шрифт: 100% против 200% ---
     ЛОВУШКА, на которую этот прогон уже попадался: считать одни переполнения
     мало. Если кегли заданы в px, при увеличении НИЧЕГО не поедет — просто
     потому, что ничего и не выросло. Ноль переполнений тогда означает не
     «вёрстка держит», а «настройка крупного шрифта не работает вовсе».
     Поэтому сначала мерим, вырос ли текст, и только потом — поехал ли он. */
  console.log('\\n══ УВЕЛИЧЕНИЕ ШРИФТА ══');
  await pg.evaluate(() => setTab('history'));
  await pg.waitForTimeout(200);

  const sizes = () => pg.evaluate(() => {
    const out = {};
    document.querySelectorAll('body *').forEach((el, i) => {
      const own = Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim());
      if (!own) return;
      const s = getComputedStyle(el);
      if (s.display === 'none') return;
      out['n' + i] = parseFloat(s.fontSize);
    });
    return out;
  });

  const before = await sizes();
  const baseOv = await pg.evaluate(OVERFLOW);
  await pg.evaluate(() => {
    const st = document.createElement('style');
    st.id = '__zoom';
    st.textContent = 'html{font-size:200% !important}';
    document.head.appendChild(st);
  });
  await pg.waitForTimeout(400);
  const after = await sizes();
  const zoom = await pg.evaluate(OVERFLOW);

  const keys = Object.keys(before).filter(k => k in after);
  const grew = keys.filter(k => after[k] > before[k] + 0.5).length;
  console.log('  узлов с текстом: ' + keys.length);
  console.log('  выросли при 200%: ' + grew + '  (' +
    Math.round(grew / Math.max(keys.length, 1) * 100) + '%)');
  console.log('  выходов за экран: было ' + baseOv.length + ', стало ' + zoom.length);
  if (grew === 0) {
    console.log('  ВЫВОД: настройка крупного шрифта не действует — кегли заданы в px.');
    console.log('          Ноль переполнений здесь не заслуга вёрстки.');
  } else if (grew < keys.length * 0.8) {
    console.log('  ВЫВОД: выросла только часть текста — иерархия при увеличении поедет.');
  } else {
    console.log('  ВЫВОД: текст масштабируется.');
  }
  zoom.slice(0, 8).forEach(x =>
    console.log('    ' + x.el + '  правый край ' + x.right + ' при окне ' + x.win +
      '  «' + x.text + '»'));
  await pg.screenshot({path: '/tmp/sintra-zoom200.png'});
  await pg.evaluate(() => { const z = document.getElementById('__zoom'); if (z) z.remove(); });

  /* --- разнобой оформления ---
     Скилл дизайн-ревью умеет сказать «соблюдайте шкалу» и не умеет сказать,
     сколько у вас сейчас размеров. А число решает всё: 8 кеглей — система,
     27 — случайность, и спорить тут не о чем. Считаем то, что в макете
     обязано быть счётным: кегли, радиусы, отступы, цвета, тени. */
  console.log('\n══ РАЗНОБОЙ ОФОРМЛЕНИЯ ══');
  await pg.evaluate(() => setTab('history'));
  await pg.waitForTimeout(200);
  const sys = await pg.evaluate(() => {
    const bag = {font: {}, radius: {}, pad: {}, color: {}, bg: {}, shadow: {}, weight: {}};
    const add = (k, v) => { if (v && v !== '0px' && v !== 'none' && v !== 'rgba(0, 0, 0, 0)')
      bag[k][v] = (bag[k][v] || 0) + 1; };
    document.querySelectorAll('body *').forEach(el => {
      const s = getComputedStyle(el);
      if (s.display === 'none') return;
      const hasText = Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim());
      if (hasText) { add('font', s.fontSize); add('color', s.color); add('weight', s.fontWeight); }
      /* Капсула (99px и больше) и круг (50%) — это ФОРМЫ, а не ступени
         шкалы скруглений. Считать их наравне с 10/16/22 значит вечно
         показывать «многовато» там, где система соблюдена. */
      const rr = s.borderRadius;
      if (!/^(50%|9\d px|9\d{1,3}px|100%)$/.test(rr.replace(/\s+/g, ' ')))
        add('radius', rr);
      add('bg', s.backgroundColor);
      add('shadow', s.boxShadow);
      [s.paddingTop, s.paddingLeft].forEach(v => add('pad', v));
    });
    const top = o => Object.entries(o).sort((a, b) => b[1] - a[1]);
    const out = {};
    for (const k in bag) out[k] = {n: Object.keys(bag[k]).length, top: top(bag[k]).slice(0, 6)};
    return out;
  });
  const NORM = {font: 8, radius: 4, pad: 6, color: 6, bg: 6, shadow: 3, weight: 4};
  const RUS = {font: 'кеглей', radius: 'радиусов', pad: 'отступов', color: 'цветов текста',
               bg: 'цветов фона', shadow: 'теней', weight: 'начертаний'};
  Object.keys(RUS).forEach(k => {
    const n = sys[k].n, norm = NORM[k];
    const mark = n > norm * 1.5 ? ' ← разнобой' : (n > norm ? ' ← многовато' : '');
    console.log('  %s: %d (разумно до %d)%s', RUS[k].padEnd(14), n, norm, mark);
    if (n > norm) console.log('      чаще всего: ' +
      sys[k].top.map(([v, c]) => v + '×' + c).join(', '));
  });

  /* --- сколько экрана работает ---
     Пустота внизу — не грех сама по себе, но на телефоне это главный ресурс.
     Меряем долю высоты экрана, ниже которой нет ни одного видимого элемента. */
  console.log('\n══ ИСПОЛЬЗОВАНИЕ ЭКРАНА ══');
  /* Меряем ДВА состояния, иначе вывод врёт в любую сторону: на пустом
     периоде экран законно полупустой (показывать нечего), на рабочем —
     заполнен. Одно число без другого — повод переделать то, что цело. */
  for (const [name, go] of [
      ['Выписка·будни', async () => { await pg.evaluate(() => { swBdg('b-sep'); setTab('history'); }); }],
      ['Выписка·пусто', async () => { await pg.evaluate(() => { swBdg('b-oct'); setTab('history'); }); }],
      ['Доходы',        async () => { await pg.evaluate(() => { swBdg('b-sep'); setTab('incomes'); }); }],
      ['Сводка',        async () => { await pg.evaluate(() => setTab('stats')); }]]) {
    await go();
    await pg.waitForTimeout(200);
    const u = await pg.evaluate(() => {
      /* ЛОВУШКА, третья в этом файле того же рода: если считать нижний край
         любого блока, получится 100% на любом экране — контейнер страницы
         растянут во всю высоту, даже когда он пуст. Такая цифра успокаивает
         и врёт. Считаем только то, что человек ВИДИТ: узлы с собственным
         текстом либо с собственным фоном, отличным от фона страницы. */
      const pageBg = getComputedStyle(document.body).backgroundColor;
      let bottom = 0, last = null;
      document.querySelectorAll('body *').forEach(el => {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity < 0.05) return;
        const r = el.getBoundingClientRect();
        if (r.height < 1 || r.width < 1 || r.top > window.innerHeight) return;
        const hasText = Array.from(el.childNodes)
          .some(n => n.nodeType === 3 && n.textContent.trim());
        const ownBg = s.backgroundColor !== pageBg
          && s.backgroundColor !== 'rgba(0, 0, 0, 0)';
        const hasEdge = s.borderTopWidth !== '0px' || s.borderBottomWidth !== '0px';
        if (!hasText && !ownBg && !hasEdge) return;
        const b = Math.min(r.bottom, window.innerHeight);
        if (b > bottom) { bottom = b; last = (el.className || el.tagName) + ''; }
      });
      return {used: Math.round(bottom), win: window.innerHeight, last: String(last).slice(0, 30)};
    });
    const pct = Math.round(u.used / u.win * 100);
    const note = name.indexOf('пусто') > 0
      ? '  (период без операций — так и должно быть)'
      : (pct < 60 ? '  ← больше трети пустует' : '');
    console.log('  %s: занято %d%% высоты (%d из %d px)%s',
      name.padEnd(14), pct, u.used, u.win, note);
    console.log('  %s  нижний видимый элемент: %s', ''.padEnd(14), u.last);
  }

  /* --- клавиатура и движение --- */
  console.log('\n══ ФОКУС И ДВИЖЕНИЕ ══');
  const kb = await pg.evaluate(() => {
    const css = Array.from(document.styleSheets).flatMap(sh => {
      try { return Array.from(sh.cssRules).map(r => r.cssText); } catch (e) { return []; }
    }).join('\n');
    return {
      focusVisible: /:focus-visible/.test(css),
      focusAny: /:focus/.test(css),
      outlineNone: (css.match(/outline\s*:\s*(none|0)/g) || []).length,
      reducedMotion: /prefers-reduced-motion/.test(css),
      colorScheme: /prefers-color-scheme/.test(css),
      transitions: (css.match(/transition\s*:/g) || []).length,
      animations: (css.match(/@keyframes/g) || []).length
    };
  });
  console.log('  видимый фокус клавиатуры : ' + (kb.focusVisible ? 'есть'
    : kb.focusAny ? 'только :focus, без :focus-visible' : 'НЕТ — с клавиатуры не видно, где ты'));
  /* outline:none сам по себе не грех: он гасит системную обводку ради вида,
     а фокус возвращают через :focus-visible. Ругаться надо только когда
     возврата нет — иначе замер требует чинить уже починенное. */
  console.log('  снятие обводки outline:none: ' + kb.outlineNone +
    (kb.outlineNone && !kb.focusVisible ? ' ← и возврата через :focus-visible нет'
     : kb.outlineNone ? ' (возврат есть через :focus-visible — норма)' : ''));
  console.log('  учёт «уменьшить движение» : ' + (kb.reducedMotion ? 'есть'
    : 'НЕТ — при ' + kb.transitions + ' переходах и ' + kb.animations + ' анимациях'));
  console.log('  светлая тема               : ' + (kb.colorScheme ? 'есть' : 'НЕТ, только тёмная'));

  /* --- сколько касаний до частого действия ---
     Самое дорогое число в приложении, которым пользуются каждый день. */
  console.log('\n══ ПУТЬ ДО ЧАСТЫХ ДЕЙСТВИЙ ══');
  const paths = [
    ['записать трату',       'поле ввода на первом экране', 2],
    ['посмотреть остаток',   'виден сразу, 0 касаний',       0],
    ['сменить период',       'шапка → выбор из списка',      2],
    ['добавить доход',       'вкладка Доходы → +Добавить → форма → Сохранить', 4],
    ['посмотреть по категориям', 'шапка → меню → Сводка',    3]
  ];
  paths.forEach(([what, how, n]) =>
    console.log('  %s %s  (%s)', String(n).padEnd(2), what.padEnd(26), how));
  console.log('  [оценка по разметке, не замер поведения — считать ориентиром]');

  /* --- скорость ---
     Ни разу не мерили. index.html идёт одним файлом почти на 200 КБ,
     и что в нём тяжёлое — было неизвестно. Считаем то, что человек ждёт:
     от запроса до первой отрисовки и до готовности интерфейса. */
  console.log('\n══ СКОРОСТЬ ══');
  const perf = await pg.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0] || {};
    const paints = {};
    performance.getEntriesByType('paint').forEach(p => paints[p.name] = Math.round(p.startTime));
    const res = performance.getEntriesByType('resource').map(r => ({
      name: r.name.replace(/^https?:\/\/[^/]+/, '').slice(0, 46),
      ms: Math.round(r.duration),
      kb: Math.round((r.transferSize || r.encodedBodySize || 0) / 1024)
    })).sort((a, b) => b.ms - a.ms);
    return {
      dom: Math.round(n.domContentLoadedEventEnd || 0),
      load: Math.round(n.loadEventEnd || 0),
      firstPaint: paints['first-paint'],
      firstContentful: paints['first-contentful-paint'],
      resources: res.slice(0, 6),
      totalKb: Math.round(res.reduce((s, r) => s + r.kb, 0))
    };
  });
  console.log('  первая отрисовка       : %s мс', perf.firstContentful ?? '—');
  console.log('  DOM готов              : %d мс', perf.dom);
  console.log('  загрузка завершена     : %d мс', perf.load);
  console.log('  внешних ресурсов       : %d КБ', perf.totalKb);
  /* console.log в Node не понимает ширину поля (%5d) — выравниваем сами */
  perf.resources.forEach(r => console.log('      ' + String(r.ms).padStart(5) + ' мс  ' +
    String(r.kb).padStart(4) + ' КБ  ' + r.name));
  const html = require('fs').statSync(require('path').join(__dirname, '..', 'index.html')).size;
  console.log('  сам index.html         : %d КБ одним файлом', Math.round(html / 1024));
  if (perf.firstContentful > 1500)
    console.log('  ← первая отрисовка дольше 1,5 с — человек видит пустой экран');

  /* --- разные экраны ---
     Все замеры выше сняты на 430x932 (iPhone Pro Max). Правки от 06.09
     подняли зоны нажатия до 44px и переложили отступы — на узком экране
     это может вытолкнуть содержимое за край. Проверяем то, на чём люди
     реально сидят, а не только эталон. */
  console.log('\n══ РАЗНЫЕ ЭКРАНЫ ══');
  const SIZES = [
    [320, 568, 'SE 1-го поколения'],
    [375, 667, 'SE 2/3, iPhone 8'],
    [390, 844, 'iPhone 13/14'],
    [430, 932, 'Pro Max (эталон)'],
    [932, 430, 'поворот набок'],
    [768, 1024, 'планшет']
  ];
  for (const [w, h, name] of SIZES) {
    await pg.setViewportSize({width: w, height: h});
    await pg.evaluate(() => { swBdg('b-sep'); setTab('history'); });
    await pg.waitForTimeout(300);
    const r = await pg.evaluate(OVERFLOW);
    const tap = await pg.evaluate(() => {
      let bad = 0;
      document.querySelectorAll('button, a[href], input, select').forEach(el => {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') return;
        const b = el.getBoundingClientRect();
        if (b.width < 1 || b.height < 1) return;
        if (b.width < 28 || b.height < 28) bad++;
      });
      return bad;
    });
    const scroll = await pg.evaluate(() => ({
      w: document.documentElement.scrollWidth, win: window.innerWidth}));
    const sideways = scroll.w > scroll.win + 1;
    console.log('  %s %s  выходов за край: %d, целей меньше 28px: %d%s%s',
      (w + '×' + h).padEnd(9), name.padEnd(20), r.length, tap,
      sideways ? ', ГОРИЗОНТАЛЬНАЯ ПРОКРУТКА' : '',
      (r.length || tap || sideways) ? '  ←' : '');
    if (r.length) r.slice(0, 3).forEach(x =>
      console.log('      %s  край %d при окне %d  «%s»', x.el, x.right, x.win, x.text));
  }
  await pg.setViewportSize({width: 430, height: 932});
  await pg.evaluate(() => { swBdg('b-sep'); setTab('history'); });
  await pg.waitForTimeout(200);

  /* --- заявленные настройки --- */
  const meta = await pg.evaluate(() => {
    const v = document.querySelector('meta[name=viewport]');
    return {
      viewport: v ? v.content : '(нет)',
      lang: document.documentElement.lang || '(не задан)',
      title: document.title,
      landmarks: document.querySelectorAll('main,nav,header,footer,[role]').length,
      h1: document.querySelectorAll('h1').length
    };
  });
  console.log('\\n══ ОБЪЯВЛЕНО В РАЗМЕТКЕ ══');
  Object.entries(meta).forEach(([k, v]) => console.log('  ' + k.padEnd(11) + ': ' + v));

  console.log('\\n══ СКРИНШОТЫ ══');
  shots.forEach(([n, f]) => console.log('  ' + n.padEnd(20) + f));
  console.log('  ' + 'Шрифт 200%'.padEnd(20) + '/tmp/sintra-zoom200.png');

  console.log('\\nИТОГО  контраст:' + C.length + '  нажатие:' + T.length +
    '  безымянных:' + N.length + '  мелкий шрифт:' + S.length +
    '  переполнение при 200%:' + zoom.length);

  await br.close();
  srv.close();
})();
