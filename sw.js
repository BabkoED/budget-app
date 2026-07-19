/* Бюджет — Service Worker v9
   Стратегии:
   - index.html / навигация: TIMEOUT-RACE — сеть против таймера 2.5с.
     Хороший интернет → грузим свежую версию (как раньше).
     Плохой/медленный интернет (лифт, метро) → через 2.5с мгновенно
     отдаём последнюю сохранённую версию из кэша, а сеть продолжает
     грузиться в фоне и обновляет кэш к следующему разу.
     Открытие сайта без интернета вообще — тоже отдаём кэш сразу.
   - Supabase API: не перехватываем вообще (живые данные)
   - Статика (шрифты, SDK): cache-first (не меняются) */
var CACHE = 'budget-v9';
var STATIC_ASSETS = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
  'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800;900&display=swap'
];
var NAV_TIMEOUT_MS = 2500;

self.addEventListener('install', function(e){
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function(c){
    /* Кэшируем и сам app-shell при первой установке — чтобы кэш был
       доступен даже если человек ни разу не открывал сайт при плохой сети */
    return c.addAll(STATIC_ASSETS).catch(function(){});
  }));
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){return k!==CACHE;}).map(function(k){return caches.delete(k);}));
    }).then(function(){ return self.clients.claim(); })
  );
});

function timeoutPromise(ms){
  return new Promise(function(resolve){ setTimeout(function(){ resolve(null); }, ms); });
}

self.addEventListener('fetch', function(e){
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = req.url;
  if (url.indexOf('supabase.co') > -1) return;

  var isNav = req.mode === 'navigate' || url.indexOf('index.html') > -1 ||
              (url.indexOf(self.location.origin) === 0 && url.split('?')[0].slice(-1) === '/');

  if (isNav) {
    e.respondWith(
      (async function(){
        var cache = await caches.open(CACHE);
        var cached = await cache.match(req);

        /* Сетевой запрос запускаем сразу; параллельно готовим таймер.
           Что бы ни ответило первым — то и покажем. Сеть в любом случае
           докачается и обновит кэш, даже если победил таймер. */
        var netPromise = fetch(req).then(function(resp){
          if (resp && resp.status === 200) {
            cache.put(req, resp.clone());
          }
          return resp;
        }).catch(function(){ return null; });

        if (!cached) {
          /* Кэша ещё нет (первый запуск) — ждём сеть без таймера,
             показать всё равно больше нечего */
          var first = await netPromise;
          return first || new Response('Нет соединения и нет сохранённой версии', {status: 503});
        }

        var race = await Promise.race([netPromise, timeoutPromise(NAV_TIMEOUT_MS)]);
        if (race) return race;               /* сеть успела до таймера */
        return cached;                        /* таймер сработал первым — отдаём кэш мгновенно */
      })()
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(function(cached){
      return cached || fetch(req).then(function(resp){
        if (resp && resp.status === 200) {
          var clone = resp.clone();
          caches.open(CACHE).then(function(c){ c.put(req, clone); });
        }
        return resp;
      }).catch(function(){ return cached; });
    })
  );
});
