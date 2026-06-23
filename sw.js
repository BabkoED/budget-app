/* Бюджет — Service Worker для офлайн-работы */
var CACHE = 'budget-v7';
var ASSETS = [
  './',
  './index.html',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
  'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800;900&display=swap'
];

self.addEventListener('install', function(e){
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(ASSETS).catch(function(){}); }));
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){return k!==CACHE;}).map(function(k){return caches.delete(k);}));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e){
  var url = e.request.url;
  /* Supabase API запросы — всегда сеть (живые данные), без кэша */
  if (url.indexOf('supabase.co/rest') > -1 || url.indexOf('supabase.co/auth') > -1) {
    return; /* пропускаем — браузер сам сходит в сеть */
  }
  /* Остальное — cache-first, чтобы оболочка открывалась офлайн */
  e.respondWith(
    caches.match(e.request).then(function(cached){
      return cached || fetch(e.request).then(function(resp){
        if (resp && resp.status === 200 && e.request.method === 'GET') {
          var clone = resp.clone();
          caches.open(CACHE).then(function(c){ c.put(e.request, clone); });
        }
        return resp;
      }).catch(function(){ return cached; });
    })
  );
});
