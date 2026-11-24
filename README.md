# Plan appart

Appli web (PWA, pensée pour le mobile) pour **dessiner le plan d'un appartement**, obtenir la **surface de chaque pièce**, poser des **portes et fenêtres de taille libre** et **aménager** avec du mobilier à l'échelle. Les plans sont enregistrés sur ton serveur, derrière une connexion.

## Fonctions

- Tracé des murs au doigt (accrochage aux points, aux murs et aux angles de 45°) avec **cotes en direct** ; saisie d'une longueur au clavier (`345`, `3,45 m`, `3m45`) puis un sens (← ↑ ↓ →).
- **Corriger une mesure** : toucher un mur, saisir la bonne longueur. Mode « Étirer la pièce » (garde les angles droits, le reste du plan suit) ou « Ce point seul ».
- **Pièces détectées automatiquement** dès que des murs se referment ; surface intérieure (épaisseur des murs déduite), périmètre, côtés, nom et couleur ; total.
- **Portes** (simple, double, sens et charnière réglables), **fenêtres**, **baies vitrées**, **ouvertures** : largeur, hauteur, allège libres ; glissables le long des murs.
- **Mobilier** à l'échelle (catalogue + dimensions personnalisées), déplacement, rotation, duplication.
- Sur PC : **clic droit = quitter le mode en cours** (retour à la sélection), `Échap` idem, molette = zoom, clic molette = déplacer la vue, `Suppr` = supprimer.
- Annuler / rétablir, zoom et déplacement à deux doigts, export PNG, duplication d'un plan (pour tester un autre aménagement).
- Enregistrement automatique, copie locale en cas de coupure réseau, détection de modification depuis un autre appareil.
- Installable sur l'écran d'accueil (Android/iOS/desktop).

Les murs sont cotés **à l'axe** ; les surfaces des pièces sont calculées **à l'intérieur** des murs.

## Lancer

```bash
cp .env.example .env      # facultatif : compte initial
docker compose up -d --build
# → http://localhost:3000   (le premier visiteur crée le compte s'il n'y a pas ADMIN_USER)
```

Sans Docker : `npm install && npm start` (Node ≥ 20 ; données dans `./data`, variable `DATA_DIR`).

Derrière un reverse proxy HTTPS, transmettre `X-Forwarded-Proto` : le cookie de session est alors marqué `Secure` automatiquement. Les données (SQLite) sont dans le volume `/data` : c'est le seul dossier à sauvegarder.

### Comptes

```bash
docker compose exec plan-appart node server/cli.js add  <identifiant> <mot de passe>
docker compose exec plan-appart node server/cli.js passwd <identifiant> <nouveau mot de passe>
docker compose exec plan-appart node server/cli.js list
```

## Tests

```bash
npm test                  # géométrie + API
node scripts/e2e.mjs      # parcours complet dans Chrome en émulation mobile (playwright requis)
```

## Structure

```
server/    Express + SQLite (better-sqlite3), sessions par cookie (scrypt), API /api/plans
public/    PWA sans build : js/geometry.js (moteur pur, testé), render.js (canvas), editor.js (gestes), app.js (écrans)
```

## Idées pour la suite

Calque photo/PDF d'un plan existant à mettre à l'échelle, OIDC (Authentik), plusieurs niveaux, export PDF à l'échelle, rendu 3D.

## Cotes et murs entiers

- **Référence des cotes** : intérieur (défaut), extérieur ou axe. Réglable dans le panneau d'un mur ("Cotes :") ou dans Réglages du plan. Les chiffres affichés, les longueurs saisies (y compris pendant le tracé) suivent cette référence. « ⇄ Autre côté » mesure l'autre face du mur (ex. pièce voisine).
- **Mur entier** : quand un mur est coupé par des cloisons, le panneau propose « Ce segment » (cote de la pièce) et « Mur entier » (longueur totale). Le mode de répartition (ce segment / au bout / réparti) choisit quel segment absorbe la différence.

## Outil Mesure et cotes verrouillées

- **Mesure** : touchez deux points (face de mur, coin, axe). Entre deux murs parallèles, la mesure est perpendiculaire. Saisissez la cote : tout ce qui est au-delà du 2e point (ou en deçà du 1er, au choix) se décale pour l'obtenir.
- **Verrouillage** : une cote saisie (panneau du mur, mur entier ou outil Mesure) est verrouillée par défaut (🔒 affiché sur le plan). Une modification qui la ferait changer est refusée et annulée ; déverrouillez-la d'abord. Retaper une cote verrouillée la met à jour.

## Portes

Portes simple/double (zone de débattement teintée, vantail en bleu), fenêtre, baie vitrée, ouverture, **arche** et **cadre sans porte**. Choisissez le type dans l'outil « Porte / fenêtre » ou en touchant une ouverture existante.

**Mesures conservées** : une mesure posée avec l'outil Mesure reste sur le plan, reportée hors du bâtiment (ligne de cote parallèle, pointillés à chaque extrémité). Elle suit les murs quand ils bougent. Touchez son chiffre (outil Sélection) pour la supprimer ; le bouton ⟷ masque aussi les mesures.

## Version

Le numéro s'affiche en bas à droite de l'écran et dans le menu ⋮ (« Version x.y.z »). Pour une nouvelle version, mettre à jour `package.json`, `public/js/version.js` et le nom du cache dans `public/sw.js`. Si le serveur est plus récent que la page chargée, l'indicateur affiche « v0.4.0 → vX dispo » : rechargez (Ctrl+F5).

**Ajustement des murs** : corriger une longueur répartit par défaut la différence des deux côtés du mur (réglable dans « Options » : « Des 2 côtés » ou un côté fixe). Les murs presque perpendiculaires (±15°) qui s'y accrochent se déplacent parallèlement à eux-mêmes, sans pencher. Pareil pour l'outil Mesure (« Des 2 côtés » par défaut).
