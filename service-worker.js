// =========================================================================
// Habit Tracker — service worker
//
// Rôle : mettre en cache les fichiers de l'app (HTML/CSS/JS/icônes) pour
// qu'elle continue de fonctionner hors-ligne, une fois ouverte au moins une
// fois avec une connexion. Aucune donnée utilisateur ne transite ici :
// localStorage est géré entièrement par app.js, ce fichier ne s'occupe que
// des fichiers statiques de l'app elle-même.
// =========================================================================

// Nom du cache, versionné manuellement. Change ce numéro (v2, v3, ...)
// à chaque fois que tu modifies un fichier listé dans APP_SHELL ci-dessous,
// sinon les utilisateurs resteront bloqués sur l'ancienne version en cache.
const CACHE_NAME = 'habit-tracker-v9';

// Tous les fichiers nécessaires au fonctionnement complet de l'app hors-ligne.
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// À l'installation du service worker : on télécharge et met en cache tous
// les fichiers de l'app d'un coup. skipWaiting() force la nouvelle version
// à prendre la main tout de suite, sans attendre que tous les onglets
// ouverts soient fermés.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// À l'activation : on supprime les anciens caches (versions précédentes de
// l'app), pour ne pas accumuler des fichiers obsolètes au fil des mises à
// jour. clients.claim() fait prendre le contrôle des pages déjà ouvertes
// sans attendre un rechargement manuel.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

// Stratégie "cache d'abord, réseau en secours" : sert les fichiers depuis
// le cache quand ils y sont déjà (rapide, fonctionne hors-ligne), sinon va
// les chercher sur le réseau. Suffisant ici car l'app est entièrement
// statique et ne dépend d'aucune donnée dynamique côté serveur (tout est
// dans localStorage, géré par app.js).
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
