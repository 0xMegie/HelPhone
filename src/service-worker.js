import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { CacheFirst, StaleWhileRevalidate } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import { createPartialResponse } from "workbox-range-requests";

cleanupOutdatedCaches();

const manifest = self.__WB_MANIFEST || [];
precacheAndRoute(manifest);

const CACHE_NAME = "helphone-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(() => {
      self.skipWaiting();
    }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME && cacheName !== "helphone-zk-assets-v1") {
            return caches.delete(cacheName);
          }
        }),
      );
    }).then(() => {
      self.clients.claim();
    })
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (
    request.method === "GET" &&
    url.origin === self.location.origin &&
    /\/zk-assets\/aegis\.chunk\d{4}$/.test(url.pathname)
  ) {
    event.respondWith((async () => {
      const cache = await caches.open("helphone-zk-assets-v1");
      const key = new Request(url.href, { method: "GET" });
      let full = await cache.match(key);
      if (!full) {
        full = await fetch(key);
        if (full.ok) await cache.put(key, full.clone());
      }
      if (!request.headers.has("range") || !full.ok) return full;
      try {
        return await createPartialResponse(request, full);
      } catch {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${full.headers.get("content-length") || 0}` } });
      }
    })());
    return;
  }

  if (url.pathname === "/") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const cache = caches.open(CACHE_NAME);
          cache.then((c) => c.put(request, response.clone()));
          return response;
        })
        .catch(() => {
          return caches.match(request).then((response) => {
            return response || caches.match("/");
          });
        }),
    );
    return;
  }

  if (request.method === "GET") {
    if (url.hostname.includes("mapbox.com")) {
      event.respondWith(
        caches.match(request).then((response) => {
          return (
            response ||
            fetch(request)
              .then((response) => {
                if (!response || response.status !== 200) {
                  return response;
                }
                const responseClone = response.clone();
                caches.open(CACHE_NAME).then((cache) => {
                  cache.put(request, responseClone);
                });
                return response;
              })
              .catch(() => {
                return caches.match(request);
              })
          );
        }),
      );
      return;
    }

    if (request.url.endsWith(".wasm") || request.url.endsWith(".json")) {
      event.respondWith(
        caches.match(request).then((response) => {
          return (
            response ||
            fetch(request).then((response) => {
              const responseClone = response.clone();
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(request, responseClone);
              });
              return response;
            })
          );
        }),
      );
      return;
    }
  }

  event.respondWith(
    fetch(request).catch(() => {
      return caches.match(request).then((response) => {
        return (
          response ||
          new Response(
            JSON.stringify({
              message: "Offline",
              description:
                "You are currently offline. Some features may not be available.",
            }),
            {
              status: 503,
              statusText: "Service Unavailable",
              headers: { "Content-Type": "application/json" },
            },
          )
        );
      });
    }),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data || {};

  // CRDT sync: forward the local state change to the backend sync endpoint.
  if (data.type === "CRDT_SYNC") {
    event.waitUntil(
      fetch("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data.payload),
      }),
    );
  }

  // Contract update events and CRDT/state sync (issue #516): reflect the
  // message to every other open window client so a single leader's poll or
  // SSE result reaches all tabs without each tab owning a subscription.
  if (data.type === "CONTRACT_EVENT" || data.type === "CRDT_SYNC" || data.type === "STATE_SYNC") {
    event.waitUntil(
      self.clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((clients) => {
          return Promise.all(
            clients.map((client) => {
              if (client === event.source) return Promise.resolve();
              return client.postMessage({ ...data, source: data.source || "service-worker" });
            }),
          );
        })
        .catch(() => {}),
    );
  }

  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
  // ISP-135/ISP-134: the SW can never hold a Serial port or NDEFReader, so
  // it only relays field intents (radio RX, NFC results, SOS) between
  // clients. TX always happens in a foreground page.
  if (event.data && event.data.type === "HELPHONE_RELAY") {
    event.waitUntil(
      self.clients
        .matchAll({ includeUncontrolled: true, type: "window" })
        .then((clientList) => {
          for (const client of clientList) {
            client.postMessage(event.data);
          }
        }),
    );
  }
});
