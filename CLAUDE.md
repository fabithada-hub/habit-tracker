# CLAUDE.md

## 1. Projet

PWA personnelle de suivi de 3 habitudes quotidiennes sur Android : cohérence
cardiaque, étirements + gainage, lecture.

Le vrai but : que moi, Fabien (débutant en HTML/JS/Python), j'apprenne à
construire des apps avec Claude Code. L'app est le prétexte, l'apprentissage est l'objectif.

## 2. Périmètre V1

Ne rien ajouter sans mon accord explicite.

Dans le périmètre :
- coche quotidienne : fait / pas fait
- séries (streaks) avec gels
- vue des 30 derniers jours, par habitude
- données uniquement locales
- export JSON, puis CSV
- rappel d'export hebdomadaire affiché dans l'app
- PWA installable et fonctionnelle hors-ligne
- aucun backend, aucun compte

Hors périmètre : notifications push, synchronisation entre appareils,
statistiques avancées.

## 3. Règles des séries (par habitude, indépendamment)

- 1 gel gagné tous les 7 jours de série consécutifs, stock maximum de 3 gels
- un jour manqué consomme automatiquement un gel : la série continue, mais le
  jour gelé ne s'ajoute pas au compteur de la série
- sans gel disponible, un jour manqué casse la série
- deux jours manqués consécutifs cassent la série, même avec des gels ; le gel
  consommé pour le premier jour manqué est alors perdu (pas remboursé)

## 4. Choix techniques

- HTML, CSS et JavaScript simples
- aucun framework, aucune étape de build
- stockage dans le navigateur via localStorage
- les dates sont stockées en texte au format "AAAA-MM-JJ", en heure locale

## 5. Façon de travailler

- avant de coder, propose un plan court
- après chaque modification, explique le pourquoi en 2-3 phrases
- challenge mes choix s'ils ne tiennent pas
- une seule question à la fois
- je suis sur PowerShell : donne des commandes exactes, prêtes à coller
