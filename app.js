// =========================================================================
// Habit Tracker — logique de l'application
//
// Principe général : localStorage est la SEULE source de vérité, et elle ne
// contient quasiment rien (juste les dates où chaque habitude a été faite).
// Tout le reste (série, gels, statut par jour) est RECALCULÉ à chaque fois
// par des fonctions pures, à partir de ces dates. Voir CLAUDE.md pour les
// règles métier complètes (périmètre, règles des séries/gels).
// =========================================================================


// --- Modèle de données ---------------------------------------------------

// Clé unique utilisée dans localStorage pour stocker tout l'état de l'app.
const STORAGE_KEY = 'habitTrackerData';

// Liste des 3 habitudes suivies. `id` = identifiant technique stable (utilisé
// comme clé dans les données et ne doit jamais changer une fois des données
// enregistrées), `label` = texte affiché à l'utilisateur.
const HABITS = [
  { id: 'coherence', label: 'Cohérence cardiaque' },
  { id: 'etirements', label: 'Étirements + gainage' },
  { id: 'lecture', label: 'Lecture' },
];

// Construit la structure de données par défaut (première utilisation de
// l'app, ou localStorage vide/effacé). Chaque habitude démarre avec un
// historique vide.
function emptyData() {
  const habits = {};
  for (const h of HABITS) habits[h.id] = { doneDates: [] };
  return { habits, lastExportDate: null };
}

// Lit l'état complet depuis localStorage. Si rien n'existe encore, renvoie
// une structure vide plutôt que null/undefined, pour que le reste du code
// n'ait jamais à vérifier "est-ce que les données existent ?".
function loadData() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return emptyData();
  return JSON.parse(raw);
}

// Écrit l'état complet dans localStorage (écrase tout ce qui existait).
function saveData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}


// --- Dates (texte "AAAA-MM-JJ", heure locale) -----------------------------
//
// Convention fixée dans CLAUDE.md : toutes les dates manipulées par l'app
// sont des chaînes "AAAA-MM-JJ" en heure LOCALE (pas UTC, pas de timestamp).
// Ça évite les décalages de fuseau horaire et rend les dates triables et
// comparables directement comme des chaînes (ex: '2026-10-06' < '2026-10-07').

// Convertit un objet Date JS en chaîne "AAAA-MM-JJ", en heure locale.
function dateToStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Renvoie la date du jour (heure locale de l'appareil) au format "AAAA-MM-JJ".
function todayStr() {
  return dateToStr(new Date());
}

// Ajoute (ou soustrait, si n est négatif) n jours à une date "AAAA-MM-JJ"
// et renvoie le résultat au même format. Utilisé pour avancer jour par jour
// dans les boucles de calcul, sans jamais manipuler de timestamps.
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return dateToStr(dt);
}

// Nombre de jours entre deux dates "AAAA-MM-JJ" (toStr - fromStr). Utilisé
// pour savoir depuis combien de jours le dernier export a été fait (voir
// le rappel hebdomadaire plus bas).
function daysBetween(fromStr, toStr) {
  const [y1, m1, d1] = fromStr.split('-').map(Number);
  const [y2, m2, d2] = toStr.split('-').map(Number);
  const from = new Date(y1, m1 - 1, d1);
  const to = new Date(y2, m2 - 1, d2);
  return Math.round((to - from) / (1000 * 60 * 60 * 24));
}


// --- Logique des séries et des gels (fonction pure) -----------------------
//
// Règles métier (voir CLAUDE.md, section 3) :
// - 1 gel gagné tous les 7 jours de série consécutifs, stock max 3
// - un jour manqué consomme un gel si possible : la série continue,
//   le jour gelé ne s'ajoute pas au compteur
// - sans gel, un jour manqué casse la série
// - deux jours manqués consécutifs cassent la série, même avec des gels ;
//   le gel consommé pour le premier jour manqué est perdu (pas remboursé)
//
// computeHabitState() est une fonction PURE : mêmes entrées -> même sortie,
// aucun effet de bord (pas de lecture/écriture de localStorage ici). Ça la
// rend facile à tester à la main dans la console du navigateur, et facile à
// faire évoluer sans risquer de casser le stockage.
//
// Paramètres :
//   doneDates : tableau de chaînes "AAAA-MM-JJ" où l'habitude a été faite
//   today     : chaîne "AAAA-MM-JJ" représentant "aujourd'hui"
//
// Retour : { streak, freezes, statusByDate }
//   streak        : longueur de la série en cours (nombre de jours)
//   freezes       : nombre de gels actuellement en stock (0 à 3)
//   statusByDate  : objet { "AAAA-MM-JJ": 'done' | 'frozen' | 'missed' }
//                   un jour sans entrée = avant le début du suivi (jamais
//                   évalué, ni fait ni manqué)
function computeHabitState(doneDates, today) {
  const doneSet = new Set(doneDates);

  // Aucune donnée encore : rien à calculer.
  if (doneSet.size === 0) {
    return { streak: 0, freezes: 0, statusByDate: {} };
  }

  // On part du premier jour où l'habitude a été faite, et on avance jour par
  // jour jusqu'à aujourd'hui en appliquant les règles, dans l'ordre
  // chronologique (indispensable car l'état d'un jour dépend des jours
  // précédents : on ne peut pas calculer un jour isolément).
  const sorted = [...doneSet].sort();
  let cursor = sorted[0];
  let streak = 0;
  let freezes = 0;
  // prevWasMiss : le jour précédent était-il un échec (gelé ou non) ?
  // Sert à détecter "deux jours manqués consécutifs" (règle qui casse la
  // série même s'il reste des gels).
  let prevWasMiss = false;
  const statusByDate = {};

  while (cursor <= today) {
    if (doneSet.has(cursor)) {
      // Jour fait : la série avance, et on gagne un gel tous les 7 jours
      // (si le stock n'est pas déjà au maximum de 3).
      streak += 1;
      if (streak % 7 === 0 && freezes < 3) freezes += 1;
      statusByDate[cursor] = 'done';
      prevWasMiss = false;
    } else if (!prevWasMiss && freezes > 0) {
      // Jour manqué, mais le jour précédent était OK et il reste un gel :
      // on consomme automatiquement le gel, la série continue sans avancer
      // (ce jour ne compte pas dans le compteur de série).
      freezes -= 1;
      statusByDate[cursor] = 'frozen';
      prevWasMiss = true;
    } else {
      // Soit pas de gel disponible, soit le jour précédent était déjà un
      // échec (deux jours manqués consécutifs) : la série est cassée.
      // Si un gel avait été consommé la veille, il reste perdu (on ne le
      // rend pas ici — c'est volontaire, voir CLAUDE.md).
      streak = 0;
      statusByDate[cursor] = 'missed';
      prevWasMiss = true;
    }
    cursor = addDays(cursor, 1);
  }

  return { streak, freezes, statusByDate };
}


// --- Actions ---------------------------------------------------------------

// Coche ou décoche "aujourd'hui" pour une habitude donnée (bascule l'état).
// Lit l'état, modifie le tableau de dates, réécrit immédiatement dans
// localStorage, puis renvoie le nouvel état calculé (pratique pour tester
// cette fonction seule dans la console, indépendamment du rendu).
function toggleDoneToday(habitId) {
  const data = loadData();
  const today = todayStr();
  const dates = data.habits[habitId].doneDates;
  const idx = dates.indexOf(today);
  if (idx >= 0) dates.splice(idx, 1); // déjà cochée -> on décoche
  else dates.push(today); // pas encore cochée -> on coche
  saveData(data);
  return computeHabitState(dates, today);
}


// --- Rendu : vue du jour courant --------------------------------------------
//
// Cette section lit l'état (via loadData) et génère le HTML correspondant.
// Elle ne contient aucune règle métier : tout le calcul vient de
// computeHabitState(). Ici on se contente d'afficher le résultat.

// Transforme un nombre de gels en une petite suite d'icônes 🧊 (ou un tiret
// si le stock est à 0), pour un affichage compact et visuel.
function freezeIcons(freezes) {
  return '🧊'.repeat(freezes) || '—';
}

// Formate une date "AAAA-MM-JJ" en texte lisible en français, ex :
// "Lundi 6 octobre 2026". Utilisé comme titre de la zone du jour, à la
// place du mot fixe "Aujourd'hui" (plus utile : on voit directement quel
// jour est affiché).
function formatDateHeading(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const formatted = date.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  // toLocaleDateString renvoie "lundi 6 octobre 2026" (sans majuscule) :
  // on met la première lettre en majuscule pour un titre propre.
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

// Reconstruit entièrement la zone du jour courant (titre = date du jour,
// puis une carte par habitude avec case à cocher + série + gels). Appelée
// au chargement de la page et chaque fois qu'une case est cochée/décochée.
function renderToday() {
  const data = loadData();
  const today = todayStr();

  document.getElementById('today-heading').textContent = formatDateHeading(today);

  const container = document.getElementById('today-habits');
  container.innerHTML = ''; // on repart de zéro à chaque rendu (pas de diff)

  for (const habit of HABITS) {
    const dates = data.habits[habit.id].doneDates;
    const state = computeHabitState(dates, today);
    const isDoneToday = dates.includes(today);

    const card = document.createElement('div');
    card.className = 'habit-card';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = isDoneToday;
    // Au clic : on bascule l'état en mémoire/localStorage, puis on relance
    // un rendu complet (today + historique), car cocher "aujourd'hui"
    // change aussi la dernière case de la grille des 30 jours.
    checkbox.addEventListener('change', () => {
      toggleDoneToday(habit.id);
      renderAll();
    });

    const info = document.createElement('div');
    info.className = 'habit-info';
    info.innerHTML = `
      <div class="habit-label">${habit.label}</div>
      <div class="habit-stats">Série : ${state.streak} jour(s) · Gels : ${freezeIcons(state.freezes)}</div>
    `;

    card.appendChild(checkbox);
    card.appendChild(info);
    container.appendChild(card);
  }
}


// --- Rendu : vue des 30 derniers jours --------------------------------------

// Renvoie la liste des 30 derniers jours (dont aujourd'hui), en ordre
// chronologique croissant (du plus ancien au plus récent), au format
// "AAAA-MM-JJ". Utilisé pour construire la grille d'historique.
function last30Days(today) {
  const days = [];
  let cursor = addDays(today, -29); // -29 pour inclure aujourd'hui = 30 jours
  for (let i = 0; i < 30; i++) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

// Reconstruit entièrement la zone "30 derniers jours" : une grille de 30
// cases par habitude, colorée selon le statut de chaque jour (fait / gelé /
// manqué / pas encore suivi).
function renderHistory() {
  const data = loadData();
  const today = todayStr();
  const days = last30Days(today);
  const container = document.getElementById('history');
  container.innerHTML = '';

  for (const habit of HABITS) {
    const dates = data.habits[habit.id].doneDates;
    const state = computeHabitState(dates, today);

    const section = document.createElement('div');
    section.className = 'history-habit';

    const title = document.createElement('div');
    title.className = 'history-title';
    title.textContent = habit.label;
    section.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'history-grid';

    for (const day of days) {
      // 'empty' = jour antérieur à la première coche de cette habitude :
      // ce n'est pas un échec, l'habitude n'était simplement pas encore
      // suivie. On le distingue visuellement de 'missed' (voir style.css).
      const status = state.statusByDate[day] || 'empty';
      const cell = document.createElement('div');
      cell.className = `history-cell history-${status}`;
      cell.title = day; // info-bulle au survol : la date exacte
      grid.appendChild(cell);
    }

    section.appendChild(grid);
    container.appendChild(section);
  }
}


// --- Rappel d'export hebdomadaire ---------------------------------------
//
// L'app n'a pas de backend : les données ne vivent que dans ce navigateur,
// sur cet appareil. Si l'utilisateur change de téléphone, réinstalle le
// navigateur, ou efface ses données de site, tout est perdu sans export
// régulier. Ce bandeau rappelle juste d'exporter, il ne bloque rien.

// Vrai si aucun export n'a jamais été fait, ou si le dernier export date
// de 7 jours ou plus.
function shouldShowExportReminder(data, today) {
  if (!data.lastExportDate) return true;
  return daysBetween(data.lastExportDate, today) >= 7;
}

// Affiche ou cache le bandeau de rappel selon l'état des exports.
function renderExportReminder() {
  const data = loadData();
  const today = todayStr();
  const banner = document.getElementById('export-reminder');

  if (!shouldShowExportReminder(data, today)) {
    banner.hidden = true;
    return;
  }

  banner.hidden = false;
  banner.textContent = data.lastExportDate
    ? `Dernier export il y a ${daysBetween(data.lastExportDate, today)} jours — pense à exporter tes données.`
    : "Tu n'as encore jamais exporté tes données — pense à le faire.";
}


// --- Export JSON / CSV ------------------------------------------------
//
// Deux formats d'export, tous les deux déclenchés par un clic sur un bouton :
// - JSON : sauvegarde brute et complète (exactement ce qui est dans
//   localStorage). Sert à restaurer les données plus tard (ex: nouveau
//   téléphone) — c'est le format "backup".
// - CSV : une ligne par jour, une colonne par habitude, avec le statut
//   ('done' / 'frozen' / 'missed' / 'empty'). Pensé pour être lisible par un
//   humain ou ouvert dans un tableur — ce n'est pas utilisé pour restaurer.
//
// Les deux exports mettent à jour `lastExportDate` : c'est ce qui permet au
// rappel hebdomadaire (voir plus bas) de savoir depuis quand aucun export
// n'a été fait.

// Déclenche le téléchargement d'un fichier texte dans le navigateur, sans
// dépendre d'un serveur : on crée un Blob en mémoire, une URL temporaire
// vers ce Blob, et un lien <a download> invisible sur lequel on clique par
// code. C'est la façon standard de faire un export de fichier côté client.
function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url); // libère la mémoire associée au Blob
}

// Construit le contenu CSV complet : une ligne par jour (du premier jour
// suivi, toutes habitudes confondues, jusqu'à aujourd'hui), une colonne par
// habitude. Fonction séparée de exportCsv() pour rester testable seule
// dans la console, sans déclencher de téléchargement.
function buildCsv(data) {
  const today = todayStr();

  // On calcule l'état de chaque habitude une seule fois, et on repère la
  // date la plus ancienne suivie (toutes habitudes confondues) pour savoir
  // où démarrer les lignes du CSV.
  const states = {};
  let minDate = null;
  for (const habit of HABITS) {
    const dates = data.habits[habit.id].doneDates;
    states[habit.id] = computeHabitState(dates, today);
    for (const d of dates) {
      if (!minDate || d < minDate) minDate = d;
    }
  }

  // Aucune donnée du tout dans l'app : on exporte juste l'en-tête.
  if (!minDate) minDate = today;

  const header = ['date', ...HABITS.map((h) => h.id)];
  const rows = [header];

  let cursor = minDate;
  while (cursor <= today) {
    const row = [cursor];
    for (const habit of HABITS) {
      // 'empty' = jour antérieur au début du suivi de CETTE habitude
      // précise (les 3 habitudes peuvent avoir démarré à des dates
      // différentes).
      row.push(states[habit.id].statusByDate[cursor] || 'empty');
    }
    rows.push(row);
    cursor = addDays(cursor, 1);
  }

  return rows.map((r) => r.join(',')).join('\n');
}

// Exporte toutes les données brutes en JSON (backup complet), puis
// enregistre la date de cet export dans localStorage.
function exportJson() {
  const data = loadData();
  data.lastExportDate = todayStr();
  saveData(data);

  const filename = `habit-tracker-${todayStr()}.json`;
  downloadFile(filename, JSON.stringify(data, null, 2), 'application/json');

  renderAll(); // le bandeau de rappel (étape 7) doit disparaître si visible
}

// Exporte les données en CSV lisible, puis enregistre la date de cet export.
function exportCsv() {
  const data = loadData();
  data.lastExportDate = todayStr();
  saveData(data);

  const filename = `habit-tracker-${todayStr()}.csv`;
  downloadFile(filename, buildCsv(data), 'text/csv');

  renderAll();
}


// --- Point d'entrée ----------------------------------------------------

// Relance les deux rendus (jour courant + historique). Point d'entrée unique
// utilisé au chargement de la page et après chaque action qui modifie les
// données, pour garantir que l'écran reste toujours synchronisé avec
// localStorage.
function renderAll() {
  renderExportReminder();
  renderToday();
  renderHistory();
}

// Branche les boutons d'export une seule fois au démarrage (pas besoin de
// les reconstruire à chaque rendu, contrairement aux cases à cocher qui
// dépendent des données).
function initExportButtons() {
  document.getElementById('export-json-btn').addEventListener('click', exportJson);
  document.getElementById('export-csv-btn').addEventListener('click', exportCsv);
}

// Premier affichage, une fois le HTML de la page chargé.
document.addEventListener('DOMContentLoaded', () => {
  renderAll();
  initExportButtons();
});


// --- PWA : enregistrement du service worker ---------------------------
//
// Le service worker (service-worker.js) met en cache les fichiers de l'app
// pour qu'elle fonctionne hors-ligne. On ne l'enregistre que si le
// navigateur le supporte (vérif `in navigator`, par prudence et par
// compatibilité), et seulement après le chargement complet de la page pour
// ne pas retarder le premier affichage.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js');
  });
}
