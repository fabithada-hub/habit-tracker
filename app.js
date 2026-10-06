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

// Remet en forme un objet de données quelconque vers le format actuel
// attendu par l'app. Gère deux cas :
// - ancien format où data.habits était un objet {id: {doneDates}} au lieu
//   d'un tableau ordonné
// - habitudes sans champ `archived` (créées avant l'ajout du retrait)
// Factorisée à part de loadData() pour être réutilisée par l'import JSON
// (importJsonFile) : un fichier importé doit subir exactement les mêmes
// vérifications qu'une donnée relue depuis localStorage, qu'il vienne d'une
// ancienne version de l'app ou d'un autre appareil.
function normalizeData(data) {
  if (data.habits && !Array.isArray(data.habits)) {
    data.habits = DEFAULT_HABITS
      .filter((h) => data.habits[h.id])
      .map((h) => ({ id: h.id, label: h.label, doneDates: data.habits[h.id].doneDates, archived: false }));
  }

  if (!Array.isArray(data.habits)) data.habits = [];
  for (const habit of data.habits) {
    if (habit.archived === undefined) habit.archived = false;
  }
  if (data.lastExportDate === undefined) data.lastExportDate = null;

  return data;
}

// Lit l'état complet depuis localStorage. Si rien n'existe encore, renvoie
// une structure vide. Passe toujours les données par normalizeData() avant
// de les renvoyer, et sauvegarde si une migration a changé quelque chose
// (pour ne la refaire qu'une seule fois).
function loadData() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return emptyData();

  const before = raw;
  const data = normalizeData(JSON.parse(raw));
  if (JSON.stringify(data) !== before) saveData(data);

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

// Coche ou décoche UNE DATE PRÉCISE pour une habitude donnée (bascule
// l'état). Fonction générale utilisée aussi bien pour "aujourd'hui" (la
// case à cocher) que pour un jour passé (clic sur une case de la bande
// d'historique, voir renderHabitList). Lit l'état, modifie le tableau de
// dates, réécrit immédiatement dans localStorage.
function toggleDoneDate(habitId, dateStr) {
  const data = loadData();
  const habit = data.habits.find((h) => h.id === habitId);
  const idx = habit.doneDates.indexOf(dateStr);
  if (idx >= 0) habit.doneDates.splice(idx, 1); // déjà cochée -> on décoche
  else habit.doneDates.push(dateStr); // pas encore cochée -> on coche
  saveData(data);
}

// Raccourci pour cocher/décocher "aujourd'hui" précisément (le cas le plus
// fréquent, utilisé par la case à cocher principale de chaque carte).
function toggleDoneToday(habitId) {
  toggleDoneDate(habitId, todayStr());
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

// Fait réapparaître une habitude archivée dans l'app (son historique
// n'avait de toute façon jamais été supprimé, voir archiveHabit).
function unarchiveHabit(habitId) {
  const data = loadData();
  const habit = data.habits.find((h) => h.id === habitId);
  if (habit) habit.archived = false;
  saveData(data);
}

// Renomme une habitude existante. Son historique (doneDates) et son id
// technique ne changent pas : seul le libellé affiché change.
function renameHabit(habitId, newLabel) {
  const data = loadData();
  const habit = data.habits.find((h) => h.id === habitId);
  if (habit) habit.label = newLabel.trim();
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
// (voir CLAUDE.md, section 2). Affichée sur 4 lignes pleine largeur de 15
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

// Mémorise l'habitude qu'on vient de cocher, pour lui appliquer une petite
// animation au prochain rendu (voir plus bas et la classe .just-checked
// dans style.css). Remis à null dès que l'animation a été appliquée une
// fois, pour ne pas la rejouer à chaque rendu suivant.
let justCheckedHabitId = null;

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

    // Anime brièvement la carte qu'on vient de cocher (voir plus haut),
    // une seule fois.
    if (habit.id === justCheckedHabitId) {
      card.classList.add('just-checked');
      justCheckedHabitId = null;
    }

    // --- Ligne du haut : poignée, case à cocher, infos, boutons ---
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
    // case de la bande d'historique (voir HISTORY_DAYS). Un petit retour
    // vibreur + visuel accompagne uniquement la coche (pas le décochage) :
    // c'est une confirmation positive, pas utile pour annuler.
    checkbox.addEventListener('change', () => {
      toggleDoneToday(habit.id);
      if (checkbox.checked) {
        justCheckedHabitId = habit.id;
        if (navigator.vibrate) navigator.vibrate(15);
      }
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

    const editBtn = document.createElement('button');
    editBtn.className = 'edit-habit-btn';
    editBtn.textContent = '✎';
    editBtn.title = 'Renommer cette habitude';
    editBtn.addEventListener('click', () => {
      const newLabel = window.prompt('Nouveau nom :', habit.label);
      if (newLabel && newLabel.trim() && newLabel.trim() !== habit.label) {
        renameHabit(habit.id, newLabel);
        renderAll();
      }
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-habit-btn';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Retirer cette habitude';
    // Demande confirmation : retirer une habitude la fait disparaître de la
    // liste principale (mais reste visible dans "Habitudes archivées", et
    // dans les exports JSON/CSV — voir archiveHabit).
    removeBtn.addEventListener('click', () => {
      const ok = window.confirm(
        `Retirer "${habit.label}" ? Tu pourras la restaurer depuis "Habitudes archivées", et elle restera dans tes exports.`
      );
      if (ok) {
        archiveHabit(habit.id);
        renderAll();
      }
    });

    top.appendChild(handle);
    top.appendChild(checkbox);
    top.appendChild(info);
    top.appendChild(editBtn);
    top.appendChild(removeBtn);

    // --- Bande du bas : historique sur HISTORY_DAYS jours ---
    // Chaque case est cliquable : ça permet de cocher/décocher un jour
    // PASSÉ (pas seulement "aujourd'hui" via la case à cocher), par
    // exemple pour rattraper un oubli de saisie. Comme la bande ne
    // contient jamais de jour futur, aucune restriction de date n'est
    // nécessaire ici.
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
      cell.addEventListener('click', () => {
        toggleDoneDate(habit.id, day);
        renderAll();
      });
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

// Reconstruit la liste repliable des habitudes archivées (voir <details>
// dans index.html), avec juste le nom et un bouton pour les restaurer :
// pas besoin de case à cocher ni d'historique ici, puisqu'elles ne sont
// plus suivies tant qu'elles restent archivées.
function renderArchivedHabits() {
  const data = loadData();
  const container = document.getElementById('archived-list');
  container.innerHTML = '';

  const archived = data.habits.filter((h) => h.archived);

  if (archived.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'archived-empty';
    empty.textContent = 'Aucune habitude archivée.';
    container.appendChild(empty);
    return;
  }

  archived.forEach((habit) => {
    const row = document.createElement('div');
    row.className = 'archived-item';

    const label = document.createElement('div');
    label.className = 'archived-label';
    label.textContent = habit.label;

    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'restore-habit-btn';
    restoreBtn.textContent = 'Restaurer';
    restoreBtn.addEventListener('click', () => {
      unarchiveHabit(habit.id);
      renderAll();
    });

    row.appendChild(label);
    row.appendChild(restoreBtn);
    container.appendChild(row);
  });
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

// Lit un fichier JSON choisi par l'utilisateur (voir initImportButton) et
// REMPLACE entièrement les données actuelles par son contenu — après
// confirmation, puisque c'est une action destructrice pour ce qu'il y a
// déjà dans l'app. Utilisé pour restaurer un export (ex: nouveau
// téléphone). Passe par normalizeData() comme loadData(), pour accepter
// aussi bien un export récent qu'un export d'une version plus ancienne.
function importJsonFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch (err) {
      window.alert("Ce fichier n'est pas un JSON valide — import annulé.");
      return;
    }

    if (!parsed || typeof parsed !== 'object') {
      window.alert("Ce fichier ne ressemble pas à un export de l'app — import annulé.");
      return;
    }

    const ok = window.confirm(
      'Importer ce fichier va REMPLACER toutes les données actuelles de l\'app (habitudes et historique). Continuer ?'
    );
    if (!ok) return;

    saveData(normalizeData(parsed));
    renderAll();
    window.alert('Import terminé.');
  };
  reader.readAsText(file);
}


// --- Point d'entrée ----------------------------------------------------

// Relance tous les rendus (rappel d'export + liste des habitudes +
// habitudes archivées). Point d'entrée unique utilisé au chargement de la
// page et après chaque action qui modifie les données, pour garantir que
// l'écran reste toujours synchronisé avec localStorage.
function renderAll() {
  renderExportReminder();
  renderHabitList();
  renderArchivedHabits();
}

// Branche les boutons d'export/import une seule fois au démarrage (pas
// besoin de les reconstruire à chaque rendu, contrairement aux cartes
// d'habitudes qui dépendent des données).
function initExportButtons() {
  document.getElementById('export-json-btn').addEventListener('click', exportJson);
  document.getElementById('export-csv-btn').addEventListener('click', exportCsv);

  // Le bouton visible déclenche un input file invisible (impossible de
  // styler un vrai <input type="file"> proprement) : on relaie juste le
  // clic, puis on lit le fichier choisi.
  const importInput = document.getElementById('import-json-input');
  document.getElementById('import-json-btn').addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', () => {
    if (importInput.files[0]) importJsonFile(importInput.files[0]);
    importInput.value = ''; // permet de réimporter le même fichier une 2e fois si besoin
  });
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
