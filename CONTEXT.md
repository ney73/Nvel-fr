# CONTEXT.md — Contexte du dépôt Ney73 Sources

> Dépôt personnel de sources Synthetiq Books. Langue des modules : français.
> Catalogue : `ney73.sources` ("Ney73 Sources", propriétaire `ney73`).

## Modules publiés (`index.json`)

| Module (`id` / `familyID`) | Site | Version | Type de contenu | Transport |
|---|---|---|---|---|
| `ney73.nvl-fr` / `novelfrance` (dossier `modules/novelfrance`) | https://novelfrance.fr | 0.4.1 | `text` | API JSON (`/api/...`) via `fetchv2` |
| `noveldelaube-v1` / `noveldelaube-v1` (dossier `modules/noveldelaube`) | https://noveldelaube.com | 0.3.0 | `text` | HTML parsé via `fetchv2` (cartes, JSON-LD, données flight Next.js) |

Les dossiers des 43 autres modules du dépôt d'origine ont été supprimés : seuls
les modules listés dans `index.json` sont visibles par l'appli. Détail par module :
voir `modules/<slug>/manifest.json` (identité, capacités, hôtes, limites).

### Spécificités NovelFrance (`ney73.nvl-fr`)
- Recherche côté serveur (`/api/search`) + repli : si une requête multi-mots rend
  0 résultat, réessai mot à mot avec intersection stricte (ET préservé).
- Découverte : flux `popular` (`/api/novels?sort=views`) + `latest`.
- Chapitres : pagination `skip/take` suivie jusqu'au bout, chapitres premium
  exclus, liste complète triée.
- Filtre de sécurité : seuls les marqueurs sexuels explicites bloquent
  (`porn`, `hentai`, `smut`, `explicit`, `erotica`…), jamais les tags grand public
  (`Mature`, `Harem`, `Ecchi`, `Yaoi`, `Yuri`…).

### Spécificités Novel de l'aube (`noveldelaube-v1`)
- Pas d'API : tout est extrait du HTML (cartes `kado_project`, secours
  titres/liens, secours JSON-LD `ItemList`).
- Découverte : flux `all` (catalogue) + `originals` (créations). **Tout identifiant
  de flux inconnu renvoie le catalogue** (jamais d'écran vide).
- Recherche : filtre client insensible aux accents sur le catalogue (+ slug).
- Détails : titre, couverture (`og:image`), auteur, genres, statut mappé
  (`Terminé→Completed`, `En cours→Ongoing`, `En attente→On hold`), synopsis.
- Chapitres : préfixés `Tome X - …` (titres `Tome N` parsés, sinon détecteur :
  `Prologue`/`Chapitre 1` après `Postface`/`Épilogue`/`Bonus`, ou numéros qui
  redémarrent). Pages `illustrations` exclues (pas de texte).
- Texte : paragraphes `<p>` des données flight, plus longue séquence retenue,
  mentions boilerplate écartées, plafond 1 Mio.
- Alias d'affichage : `TITLE_ALIASES` (ex. "Saijo no Osewa" → "Rich Girl Caretaker").
- Sécurité : échec silencieux (listes vides) sur les parcours Browse/Recherche ;
  échec strict sur détails/chapitres/texte (identifiants, hôtes, challenges,
  genres explicites dont `Hentai`). Jamais de `User-Agent` sur `fetchv2`.
- En-têtes pont : `Accept`, `Accept-Language`, `Referer` uniquement.

## Structure des fichiers

```text
index.json                        # catalogue : 2 entrées (chemin + sha256 du manifest et de l'icône)
package.json                      # scripts npm (voir ci-dessous)
docs/                             # guides (FORMAT, AUTHORING, SECURITY, TESTING…)
scripts/                          # validate.mjs, finalize-hashes.mjs, verify-repository.mjs,
                                  # source-contract-audit.mjs, module-tester.mjs, certifier…
tests/                            # source-test-policy.json (1 entrée par module publié),
                                  # documentation.test.mjs (+ anciens tests des modules supprimés, hors suite)
certification/                    # artefacts de certification
modules/novelfrance/              # index.js, manifest.json, icon.png (128×128), fixtures/, test.mjs
modules/noveldelaube/             # idem (fixtures/ + expected.json : sorties exactes attendues)
reports/                          # rapports générés (non versionnés comme sources)
```

`index.json` → `modules/<slug>/manifest.json` → `index.js` + `icon.png` : chaque
niveau épingle le suivant par SHA-256. `legacyIDs` conserve les anciens
identifiants (`novelfrance` pour `ney73.nvl-fr`).

## Règles de versioning (semver)

- `0.0.x → 0.1.x…` : correctif (ex. capacités refusées par l'appli).
- `0.x → 0.y` mineur : nouvelle fonctionnalité (flux discovery, détecteur de tomes…).
- **Bump à chaque changement**, même métadonnées seules.
- Ne jamais modifier les octets d'une version publiée : bumper d'abord.
- Après chaque bump : `node scripts/finalize-hashes.mjs` (NE PAS l'utiliser pour
  autre chose : il reformate aussi les autres manifests), puis `npm test`.
- `manifest.json` et `index.json` doivent porter la **même version**, et l'index
  le **même sha256 du manifest**.

## Commandes

```bash
npm test                                   # suite complète (doit être verte)
node --test modules/<slug>/test.mjs       # tests d'un module
node scripts/validate.mjs --skip-hashes    # itération rapide
node scripts/finalize-hashes.mjs           # APRÈS bump, jamais avant
```

## Publication (appli lit GitHub, pas ce dossier)

1. Pousser les fichiers sur `main` de `ney73/Nvel-fr`.
2. Dans l'appli : supprimer le module → supprimer/ré-ajouter le dépôt
   `https://raw.githubusercontent.com/ney73/Nvel-fr/main/index.json` → réinstaller.
3. Vérifier Browse, Recherche, détails, chapitres, texte des deux sources.

## Limites connues

- Pas de test iOS/WebKit ici : l'installation réelle dans l'appli reste la
  preuve finale (`IOS_RUNTIME_PASS` jamais revendiqué).
- `npm run test:module:fixtures -- <slug>` (harnais générique) est incompatible
  avec ces modules ; les suites dédiées `modules/*/test.mjs` font foi.
- `pagev2`/`interactivePage` : non utilisé, non certifié (fetch direct suffit).
