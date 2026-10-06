// =========================================================================
// Habit Tracker — logique de l'application
//
// Principe général : localStorage est la SEULE source de vérité. Elle
// contient la liste des habitudes (id, label, dates où elles ont été
// faites) et rien d'autre. Tout le reste (série, gels, statut par jour)
// est RECALCULÉ à chaque fois par des fonctions pures, à partir de ces
// dates. Voir CLAUDE.md pour les règles métier complètes (périmètre,
// règles des séries/gels).
// =========================================================================


// --- Modèle de données ---------------------------------------------------

// Clé unique utilisée dans localStorage pour stocker tout l'état de l'app.
const STORAGE_KEY = 'habitTrackerData';

// Habitudes de départ, utilisées uniquement pour créer les données la toute
// première fois (ou migrer un ancien format, voir loadData). Une fois l'app
// utilisée, la vraie liste des habitudes vit dans localStorage (data.habits)
// et peut être modifiée par l'utilisateur (ajout, réordonnancement) : ces
// constantes ne sont plus jamais relues après la première utilisation.
const DEFAULT_HABITS = [
  { id: 'coherence', label: 'Cohérence cardiaque' },
  { id: 'etirements', label: 'Étirements + gainage' },
  { id: 'lecture', label: 'Lecture' },
];

// Construit la structure de données par défaut (première utilisation de
// l'app, ou localStorage vide/effacé).
function emptyData() {
  const habits = DEFAULT_HABITS.map((h) => ({ id: h.id, label: h.label, doneDates: [], archived: false }));
  return { habits, lastExportDate: null };
}

// Génère un identifiant technique unique pour une nouvelle habitude.
// Basé sur l'horodatage : largement suffisant pour un usage personnel (pas
// de création simultanée depuis deux appareils différents).
function generateHabitId() {
  return `habit-${Date.now()}`;
}

// Lit l'état complet depuis localStorage. Si rien n'existe encore, renvoie
// une structure vide. Gère aussi la migration depuis l'ancien format (où
// data.habits était un objet {id: {doneDates}} à la place d'un tableau
// ordonné) : indispensable pour ne pas perdre les données déjà enregistrées
// quand ce changement de modèle a été introduit.
function loadData() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return emptyData();

  const data = JSON.parse(raw);

  // Ancien format : data.habits est un objet, pas un tableau. On migre vers
  // le nouveau format (tableau ordonné, avec label stocké sur chaque
  // habitude) en réutilisant les libellés connus de DEFAULT_HABITS, puis on
  // sauvegarde immédiatement pour ne migrer qu'une seule fois.
  if (data.habits && !Array.isArray(data.habits)) {
    const migrated = DEFAULT_HABITS
      .filter((h) => data.habits[h.id])
      .map((h) => ({ id: h.id, label: h.label, doneDates: data.habits[h.id].doneDates, archived: false }));
    data.habits = migrated;
    saveData(data);
  }

  // Habitudes créées avant l'ajout du retrait/archivage : pas encore de
  // champ `archived`. On le complète à `false` (visible) par défaut, pour
  // que toute la logique puisse supposer que ce champ existe toujours.
  let needsSave = false;
  for (const habit of data.habits) {
    if (habit.archived === undefined) {
      habit.archived = false;
      needsSave = true;
    }
  }
  if (needsSave) saveData(data);

  return data;
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
// faire évoluer sans risquer de casser le stockage. Elle ne connaît même
// pas la notion d'"habitude" : elle prend juste des dates en entrée, ce qui
// la rend valable pour n'importe quelle habitude, y compris celles créées
// dynamiquement par l'utilisateur.
//
// Paramètres :
//   doneDates : tableau de chaînes "AAAA-MM-JJ" où l'habitude a été faite
//   today     : chaîne "AAAA-MM-JJ" représentant "aujourd'hui"
//
// Retour : { streak, bestStreak, freezes, statusByDate }
//   streak        : longueur de la série en cours (nombre de jours)
//   bestStreak    : la plus longue série jamais atteinte (record), pour se
//                   challenger dans le futur ; un jour gelé ne compte pas
//                   dans le compteur, donc ne fait pas progresser le record
//                   non plus (cohérent avec `streak`)
//   freezes       : nombre de gels actuellement en stock (0 à 3)
//   statusByDate  : objet { "AAAA-MM-JJ": 'done' | 'frozen' | 'missed' }
//                   un jour sans entrée = avant le début du suivi (jamais
//                   évalué, ni fait ni manqué)
function computeHabitState(doneDates, today) {
  const doneSet = new Set(doneDates);

  // Aucune donnée encore : rien à calculer.
  if (doneSet.size === 0) {
    return { streak: 0, bestStreak: 0, freezes: 0, statusByDate: {} };
  }

  // On part du premier jour où l'habitude a été faite, et on avance jour par
  // jour jusqu'à aujourd'hui en appliquant les règles, dans l'ordre
  // chronologique (indispensable car l'état d'un jour dépend des jours
  // précédents : on ne peut pas calculer un jour isolément).
  const sorted = [...doneSet].sort();
  let cursor = sorted[0];
  let streak = 0;
  let bestStreak = 0;
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
      if (streak > bestStreak) bestStreak = streak;
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

  return { streak, bestStreak, freezes, statusByDate };
}


// --- Actions sur les habitudes ---------------------------------------------

// Coche ou décoche "aujourd'hui" pour une habitude donnée (bascule l'état).
// Lit l'état, modifie le tableau de dates, réécrit immédiatement dans
// localStorage, puis renvoie le nouvel état calculé (pratique pour tester
// cette fonction seule dans la console, indépendamment du rendu).
function toggleDoneToday(habitId) {
  const data = loadData();
  const today = todayStr();
  const habit = data.habits.find((h) => h.id === habitId);
  const idx = habit.doneDates.indexOf(today);
  if (idx >= 0) habit.doneDates.splice(idx, 1); // déjà cochée -> on décoche
  else habit.doneDates.push(today); // pas encore cochée -> on coche
  saveData(data);
  return computeHabitState(habit.doneDates, today);
}

// Ajoute une nouvelle habitude à la fin de la liste, avec un historique
// vide. Le nom est fourni tel quel (espaces superflus retirés) ; appelant
// responsable de vérifier qu'il n'est pas vide (voir promptNewHabit).
function addHabit(label) {
  const data = loadData();
  data.habits.push({ id: generateHabitId(), label: label.trim(), doneDates: [], archived: false });
  saveData(data);
}

// Retire une habitude de l'affichage SANS supprimer ses données : on la
// marque juste "archivée". Elle disparaît de l'app, mais son historique
// complet reste dans data.habits, donc dans les exports JSON/CSV (voir
// buildCsv, qui n'exclut jamais les habitudes archivées). Pas de bouton de
// restauration pour l'instant : revenir en arrière demande d'éditer
// localStorage à la main (voir CLAUDE.md, hors périmètre pour l'instant).
function archiveHabit(habitId) {
  const data = loadData();
  const habit = data.habits.find((h) => h.id === habitId);
  if (habit) habit.archived = true;
  saveData(data);
}

// Déplace une habitude juste avant une autre dans la liste (réordonnancement
// par glisser-déposer). On identifie les habitudes par leur id plutôt que
// par position, car la liste affichée à l'écran (habitudes non archivées)
// ne contient pas forcément tous les éléments de data.habits : raisonner en
// index purs mélangerait les deux. beforeHabitId = null signifie "déposée
// en toute fin de liste".
function reorderHabit(habitId, beforeHabitId) {
  const data = loadData();
  const fromIndex = data.habits.findIndex((h) => h.id === habitId);
  if (fromIndex === -1) return;
  const [moved] = data.habits.splice(fromIndex, 1);

  if (beforeHabitId === null) {
    data.habits.push(moved);
  } else {
    const toIndex = data.habits.findIndex((h) => h.id === beforeHabitId);
    data.habits.splice(toIndex === -1 ? data.habits.length : toIndex, 0, moved);
  }
  saveData(data);
}


// --- Rendu : liste des habitudes --------------------------------------------
//
// Chaque habitude affiche UNE SEULE carte compacte regroupant : la case à
// cocher du jour + série/gels, et juste en dessous une bande fine des 30
// derniers jours. Avant, ces deux informations étaient dans deux sections
// séparées (répétant le nom de chaque habitude deux fois) ; les fusionner
// réduit nettement la hauteur totale, pour que plusieurs habitudes tiennent
// sur un même écran de téléphone.
//
// Cette section lit l'état (via loadData) et génère le HTML correspondant.
// Elle ne contient aucune règle métier : tout le calcul vient de
// computeHabitState(). Ici on se contente d'afficher le résultat.

// Transforme un nombre de gels en une petite suite d'icônes 🧊 (ou un tiret
// si le stock est à 0), pour un affichage compact et visuel.
function freezeIcons(freezes) {
  return '🧊'.repeat(freezes) || '—';
}

// Nombre de jours affichés dans la bande d'historique de chaque carte
// (voir CLAUDE.md, section 2). Affichée sur 2 lignes pleine largeur de 30
// cases chacune (voir .history-grid dans style.css).
const HISTORY_DAYS = 60;

// Renvoie la liste des HISTORY_DAYS derniers jours (dont aujourd'hui), en
// ordre chronologique croissant (du plus ancien au plus récent), au format
// "AAAA-MM-JJ". Utilisé pour construire la bande d'historique de chaque carte.
function lastHistoryDays(today) {
  const days = [];
  let cursor = addDays(today, -(HISTORY_DAYS - 1)); // inclut aujourd'hui
  for (let i = 0; i < HISTORY_DAYS; i++) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

// Reconstruit entièrement la liste des habitudes (une carte par habitude
// NON archivée). Appelée au chargement de la page et chaque fois que les
// données changent (coche, ajout, retrait, réordonnancement).
function renderHabitList() {
  const data = loadData();
  const today = todayStr();
  const days = lastHistoryDays(today);
  const container = document.getElementById('habit-list');
  container.innerHTML = ''; // on repart de zéro à chaque rendu (pas de diff)

  const visibleHabits = data.habits.filter((h) => !h.archived);

  visibleHabits.forEach((habit) => {
    const state = computeHabitState(habit.doneDates, today);
    const isDoneToday = habit.doneDates.includes(today);

    const card = document.createElement('div');
    card.className = 'habit-card';
    // Identifiant retenu sur l'élément DOM : utilisé par le glisser-déposer
    // pour retrouver "quelle habitude ai-je déplacée" sans dépendre d'un
    // index de position (voir reorderHabit).
    card.dataset.habitId = habit.id;

    // --- Ligne du haut : poignée, case à cocher, infos, bouton retirer ---
    const top = document.createElement('div');
    top.className = 'habit-card-top';

    // Poignée de glisser-déposer : seule zone qui déclenche un
    // réordonnancement, pour ne pas gêner les clics sur la case ou le
    // texte. Voir la section "Glisser-déposer" plus bas pour la mécanique.
    const handle = document.createElement('div');
    handle.className = 'drag-handle';
    handle.textContent = '⠿';
    handle.addEventListener('pointerdown', (event) => startDrag(event, card, container));

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = isDoneToday;
    // Au clic : on bascule l'état en mémoire/localStorage, puis on relance
    // un rendu complet, car cocher "aujourd'hui" change aussi la dernière
    // case de la bande d'historique (voir HISTORY_DAYS).
    checkbox.addEventListener('change', () => {
      toggleDoneToday(habit.id);
      renderAll();
    });

    // 🏆 affiché seulement quand la série en cours égale le record : repère
    // visuel immédiat "tu es sur ton meilleur score actuel".
    const recordBadge = state.bestStreak > 0 && state.streak === state.bestStreak ? ' 🏆' : '';

    const info = document.createElement('div');
    info.className = 'habit-info';
    info.innerHTML = `
      <div class="habit-label">${habit.label}</div>
      <div class="habit-stats">Série : ${state.streak} j · Record : ${state.bestStreak} j${recordBadge} · ${freezeIcons(state.freezes)}</div>
    `;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-habit-btn';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Retirer cette habitude';
    // Demande confirmation : retirer une habitude la fait disparaître de
    // l'app sans bouton de retour en arrière dans l'UI pour l'instant (son
    // historique reste dans les exports, voir archiveHabit).
    removeBtn.addEventListener('click', () => {
      const ok = window.confirm(
        `Retirer "${habit.label}" ? Elle disparaîtra de l'app, mais restera dans tes exports JSON/CSV.`
      );
      if (ok) {
        archiveHabit(habit.id);
        renderAll();
      }
    });

    top.appendChild(handle);
    top.appendChild(checkbox);
    top.appendChild(info);
    top.appendChild(removeBtn);

    // --- Bande du bas : historique sur HISTORY_DAYS jours ---
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

    card.appendChild(top);
    card.appendChild(grid);
    container.appendChild(card);
  });

  // Bouton d'ajout, toujours en dernière position de la liste.
  const addButton = document.createElement('button');
  addButton.className = 'add-habit-btn';
  addButton.textContent = '+ Ajouter une habitude';
  addButton.addEventListener('click', promptNewHabit);
  container.appendChild(addButton);
}

// Demande le nom de la nouvelle habitude via une simple boîte de dialogue
// native (window.prompt) : pas de formulaire personnalisé à construire,
// fonctionne nativement au clavier sur mobile. Si l'utilisateur annule ou
// laisse vide, on ne crée rien.
function promptNewHabit() {
  const label = window.prompt('Nom de la nouvelle habitude :');
  if (!label || !label.trim()) return;
  addHabit(label);
  renderAll();
}


// --- Glisser-déposer pour réordonner les habitudes --------------------
//
// Utilise la Pointer Events API (unifie souris/tactile/stylet en une seule
// API) : on attrape la carte via sa poignée (pointerdown), on la fait
// suivre le doigt verticalement avec un simple décalage CSS (transform:
// translateY), et dès qu'elle chevauche le milieu d'une carte voisine, on
// les permute réellement dans le DOM pour un retour visuel immédiat. Au
// relâchement, le nouvel ordre est écrit dans localStorage.
//
// `dragState` garde la carte en cours de déplacement ; les gestionnaires
// globaux (onDragMove/onDragEnd) ne font rien si aucun glisser n'est en
// cours (dragState === null).
let dragState = null;

function startDrag(pointerEvent, card, container) {
  pointerEvent.preventDefault();
  dragState = {
    card,
    container,
    startY: pointerEvent.clientY,
  };
  card.classList.add('dragging');
  // Capture le pointeur sur la poignée : garantit que les événements
  // move/up continuent d'arriver même si le doigt glisse en dehors des
  // limites de la poignée pendant le geste.
  pointerEvent.target.setPointerCapture(pointerEvent.pointerId);
}

function onDragMove(event) {
  if (!dragState) return;
  const { card, container } = dragState;

  card.style.transform = `translateY(${event.clientY - dragState.startY}px)`;

  // Tant que la carte déplacée chevauche le milieu d'une voisine
  // immédiate, on les permute dans le DOM. On compense le saut de position
  // induit par la permutation (le point de référence `startY` est corrigé
  // du même delta), pour que la carte reste visuellement collée au doigt
  // au lieu de sauter au moment de l'échange.
  let swapped = true;
  while (swapped) {
    swapped = false;
    const draggedRect = card.getBoundingClientRect();
    const draggedCenter = draggedRect.top + draggedRect.height / 2;
    const siblings = [...container.children];
    const index = siblings.indexOf(card);
    const prev = siblings[index - 1];
    const next = siblings[index + 1];

    // Ne jamais permuter avec le bouton "+ Ajouter une habitude" : seules
    // les cartes (.habit-card) participent au réordonnancement.
    const prevIsCard = prev && prev.classList.contains('habit-card');
    const nextIsCard = next && next.classList.contains('habit-card');

    if (prevIsCard && draggedCenter < midY(prev)) {
      const before = card.getBoundingClientRect();
      container.insertBefore(card, prev);
      compensateJump(before, card, event);
      swapped = true;
    } else if (nextIsCard && draggedCenter > midY(next)) {
      const before = card.getBoundingClientRect();
      container.insertBefore(card, next.nextSibling);
      compensateJump(before, card, event);
      swapped = true;
    }
  }
}

// Point vertical médian d'un élément, en coordonnées écran.
function midY(el) {
  const rect = el.getBoundingClientRect();
  return rect.top + rect.height / 2;
}

// Après avoir déplacé `card` dans le DOM, sa position de flux (sans le
// transform) a changé. On ajuste dragState.startY du même écart pour que
// le transform recalculé juste après garde la carte exactement là où elle
// était visuellement juste avant la permutation (pas de saut à l'écran).
function compensateJump(beforeRect, card, event) {
  const afterRect = card.getBoundingClientRect();
  dragState.startY += afterRect.top - beforeRect.top;
  card.style.transform = `translateY(${event.clientY - dragState.startY}px)`;
}

function onDragEnd(event) {
  if (!dragState) return;
  const { card } = dragState;

  card.classList.remove('dragging');
  card.style.transform = '';

  // La carte juste après celle qu'on vient de lâcher (s'il y en a une et
  // que c'est bien une autre carte, pas le bouton "+ Ajouter") donne la
  // nouvelle position : "déposée juste avant cette habitude-là". Si rien
  // ne suit, c'est qu'elle a été déposée en toute fin de liste.
  const next = card.nextElementSibling;
  const beforeHabitId = next && next.classList.contains('habit-card') ? next.dataset.habitId : null;

  dragState = null;
  reorderHabit(card.dataset.habitId, beforeHabitId);
  renderAll(); // re-rendu propre depuis les données (source de vérité)
}

// Gestionnaires globaux, branchés une seule fois : ils ne font rien tant
// qu'aucun glisser n'est en cours (dragState === null).
function initDragAndDrop() {
  document.addEventListener('pointermove', onDragMove);
  document.addEventListener('pointerup', onDragEnd);
  document.addEventListener('pointercancel', onDragEnd);
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
// rappel hebdomadaire (voir plus haut) de savoir depuis quand aucun export
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
// habitude (identifiée par son id, stable même si le libellé change plus
// tard). Fonction séparée de exportCsv() pour rester testable seule dans
// la console, sans déclencher de téléchargement.
function buildCsv(data) {
  const today = todayStr();

  // On calcule l'état de chaque habitude une seule fois, et on repère la
  // date la plus ancienne suivie (toutes habitudes confondues) pour savoir
  // où démarrer les lignes du CSV.
  const states = {};
  let minDate = null;
  for (const habit of data.habits) {
    states[habit.id] = computeHabitState(habit.doneDates, today);
    for (const d of habit.doneDates) {
      if (!minDate || d < minDate) minDate = d;
    }
  }

  // Aucune donnée du tout dans l'app : on exporte juste l'en-tête.
  if (!minDate) minDate = today;

  const header = ['date', ...data.habits.map((h) => h.id)];
  const rows = [header];

  let cursor = minDate;
  while (cursor <= today) {
    const row = [cursor];
    for (const habit of data.habits) {
      // 'empty' = jour antérieur au début du suivi de CETTE habitude
      // précise (chaque habitude peut avoir démarré à une date différente).
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

  renderAll(); // le bandeau de rappel doit disparaître si visible
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

// Relance les deux rendus (rappel d'export + liste des habitudes). Point
// d'entrée unique utilisé au chargement de la page et après chaque action
// qui modifie les données, pour garantir que l'écran reste toujours
// synchronisé avec localStorage.
function renderAll() {
  renderExportReminder();
  renderHabitList();
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
  initDragAndDrop();
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
