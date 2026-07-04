/* Бюджет — Service Worker v8
   Стратегии:
   - index.html / навигация: NETWORK-FIRST (всегда свежая версия после деплоя,
     кэш только как офлайн-фолбэк) — это чинит «нужно переустанавливать PWA»
   - Supabase API: не перехватываем вообще (живые данные)
   - Статика (шрифты, SDK): cache-first (не меняются) */
var CACHE = 'budget-v8';
var STATIC_ASSETS = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
  'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800;900&display=swap'
];

self.addEventListener('install', function(e){
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function(c){
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

self.addEventListener('fetch', function(e){
  var req = e.request;
  /* Не-GET (POST flushSave и пр.) — не перехватываем */
  if (req.method !== 'GET') return;
  var url = req.url;
  /* Supabase — всегда напрямую в сеть */
  if (url.indexOf('supabase.co') > -1) return;

  var isNav = req.mode === 'navigate' || url.indexOf('index.html') > -1 ||
              (url.indexOf(self.location.origin) === 0 && url.split('?')[0].slice(-1) === '/');

  if (isNav) {
    /* NETWORK-FIRST: свежий HTML при каждом заходе, кэш — офлайн-фолбэк */
    e.respondWith(
      fetch(req).then(function(resp){
        if (resp && resp.status === 200) {
          var clone = resp.clone();
          caches.open(CACHE).then(function(c){ c.put(req, clone); });
        }
        return resp;
      }).catch(function(){ return caches.match(req); })
    );
    return;
  }

  /* Статика — cache-first */
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
