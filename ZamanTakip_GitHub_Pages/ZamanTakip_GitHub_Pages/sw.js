'use strict';

const CACHE_NAME = 'zaman-takip-v4-github';
const APP_SHELL = [
    './',
    './index.html',
    './style.css?v=3',
    './app.js?v=3',
    './manifest.json',
    './icon-192.png',
    './icon-512.png',
    './icon-maskable-512.png',
    './apple-touch-icon.png',
    './alarm.wav'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // Sayfa geçişleri: önce ağ, başarısız olursa önbellekteki uygulama kabuğu.
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
                    return response;
                })
                .catch(() => caches.match('./index.html'))
        );
        return;
    }

    // Uygulamanın kendi statik dosyaları: önbellekten hızlı aç, arka planda güncelle.
    if (url.origin === self.location.origin) {
        event.respondWith(
            caches.match(request, { ignoreSearch: true }).then((cached) => {
                const networkFetch = fetch(request).then((response) => {
                    if (response && response.ok) {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                    }
                    return response;
                }).catch(() => cached);

                return cached || networkFetch;
            })
        );
        return;
    }

    // Yalnızca uygulama kütüphanelerini çalışma zamanında önbelleğe al.
    const cacheableCdn = url.hostname === 'www.gstatic.com' || url.hostname === 'cdn.jsdelivr.net';
    if (cacheableCdn) {
        event.respondWith(
            caches.match(request).then((cached) => {
                if (cached) return cached;
                return fetch(request).then((response) => {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                    return response;
                });
            })
        );
    }
});
