// Service Worker for Bus Tracker offline functionality
// Update this version number with each deployment to force cache refresh
const VERSION = '2026-06-23-1755';
const CACHE_NAME = `bus-tracker-${VERSION}`;
const API_CACHE_NAME = `bus-tracker-api-${VERSION}`;

// Static assets to cache
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/src/main.tsx',
  '/src/index.css',
  '/src/App.css',
];

// API endpoints to cache
const API_PATTERNS = [
  /\/opendata\/vehicles$/,
  /\/opendata\/stops$/,
  /\/opendata\/agency$/,
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
  console.log(`Service Worker installing version ${VERSION}...`);
  
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Caching static assets');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => {
        // Skip waiting to activate immediately - forces update
        console.log('Service Worker installed, skipping waiting...');
        return self.skipWaiting();
      })
      .catch((error) => {
        console.error('Failed to cache static assets:', error);
      })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log(`Service Worker activating version ${VERSION}...`);
  
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        // Delete ALL old caches to force fresh content
        const deletePromises = cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME && cacheName !== API_CACHE_NAME) {
            console.log('Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        });
        return Promise.all(deletePromises);
      })
      .then(() => {
        // Take control of all clients immediately - forces refresh
        console.log('Service Worker activated, claiming clients...');
        return self.clients.claim();
      })
      .then(() => {
        // Notify all clients about the update
        return self.clients.matchAll().then(clients => {
          clients.forEach(client => {
            client.postMessage({
              type: 'SW_UPDATED',
              version: VERSION
            });
          });
        });
      })
  );
});

// Fetch event - implement caching strategy
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Handle API requests with network-first strategy
  if (isApiRequest(url)) {
    event.respondWith(handleApiRequest(request));
    return;
  }

  // Handle static assets with cache-first strategy
  if (request.method === 'GET') {
    event.respondWith(handleStaticRequest(request));
    return;
  }
});

// Check if request is to API
function isApiRequest(url) {
  // In development, don't intercept proxy requests - let Vite handle them
  if (url.pathname.startsWith('/api/tranzy/')) {
    return false;
  }
  
  return url.hostname === 'api.tranzy.ai' || 
         API_PATTERNS.some(pattern => pattern.test(url.pathname));
}

// Check if we're in development mode
function isDevelopment() {
  return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}

// Handle API requests with network-first, cache fallback
async function handleApiRequest(request) {
  const cache = await caches.open(API_CACHE_NAME);
  
  try {
    // Try network first
    const networkResponse = await fetch(request);
    
    if (networkResponse.ok) {
      // Cache successful responses
      const responseClone = networkResponse.clone();
      
      // Add timestamp to cached response
      const responseWithTimestamp = new Response(responseClone.body, {
        status: responseClone.status,
        statusText: responseClone.statusText,
        headers: {
          ...Object.fromEntries(responseClone.headers.entries()),
          'sw-cached-at': new Date().toISOString(),
        },
      });
      
      cache.put(request, responseWithTimestamp);
      console.log('Cached API response:', request.url);
    }
    
    return networkResponse;
  } catch (error) {
    console.log('Network failed, trying cache for:', request.url);
    
    // Network failed, try cache
    const cachedResponse = await cache.match(request);
    
    if (cachedResponse) {
      // Add header to indicate this is cached data
      const cachedAt = cachedResponse.headers.get('sw-cached-at');
      const responseWithCacheInfo = new Response(cachedResponse.body, {
        status: cachedResponse.status,
        statusText: cachedResponse.statusText,
        headers: {
          ...Object.fromEntries(cachedResponse.headers.entries()),
          'sw-from-cache': 'true',
          'sw-cached-at': cachedAt || new Date().toISOString(),
        },
      });
      
      console.log('Serving from cache:', request.url);
      return responseWithCacheInfo;
    }
    
    // No cache available, return network error
    console.log('No cache available for:', request.url);
    throw error;
  }
}

// Handle static assets with cache-first strategy
async function handleStaticRequest(request) {
  // In development, use network-first to avoid cache issues
  if (isDevelopment()) {
    try {
      return await fetch(request);
    } catch (error) {
      // Fallback to cache in development if network fails
      const cache = await caches.open(CACHE_NAME);
      const cachedResponse = await cache.match(request);
      if (cachedResponse) {
        return cachedResponse;
      }
      throw error;
    }
  }

  // Production: use cache-first strategy
  const cache = await caches.open(CACHE_NAME);
  
  // Try cache first
  const cachedResponse = await cache.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }
  
  // Cache miss, try network
  try {
    const networkResponse = await fetch(request);
    
    if (networkResponse.ok) {
      // Cache the response
      cache.put(request, networkResponse.clone());
    }
    
    return networkResponse;
  } catch (error) {
    console.log('Failed to fetch static asset:', request.url);
    throw error;
  }
}

// Message handling for cache management
self.addEventListener('message', (event) => {
  const { type, payload } = event.data;
  
  switch (type) {
    case 'SKIP_WAITING':
      // Force service worker to activate immediately
      self.skipWaiting();
      break;
      
    case 'CLEAR_CACHE':
      handleClearCache(payload?.cacheType)
        .then(() => {
          event.ports[0]?.postMessage({ success: true });
        })
        .catch((error) => {
          event.ports[0]?.postMessage({ success: false, error: error.message });
        });
      break;
      
    case 'GET_CACHE_INFO':
      getCacheInfo()
        .then((info) => {
          event.ports[0]?.postMessage({ success: true, data: info });
        })
        .catch((error) => {
          event.ports[0]?.postMessage({ success: false, error: error.message });
        });
      break;
      
    case 'GET_VERSION':
      event.ports[0]?.postMessage({ 
        success: true, 
        version: VERSION 
      });
      break;
      
    default:
      console.log('Unknown message type:', type);
  }
});

// Clear cache helper
async function handleClearCache(cacheType) {
  if (cacheType === 'api' || !cacheType) {
    await caches.delete(API_CACHE_NAME);
    console.log('API cache cleared');
  }
  
  if (cacheType === 'static' || !cacheType) {
    await caches.delete(CACHE_NAME);
    console.log('Static cache cleared');
  }
}

// Get cache information
async function getCacheInfo() {
  const cacheNames = await caches.keys();
  const info = {};
  
  for (const cacheName of cacheNames) {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    info[cacheName] = {
      size: keys.length,
      urls: keys.map(req => req.url),
    };
  }
  
  return info;
}