# Classeur PDF (PWA)

Version web de `classeur_pdf.py` : on glisse des PDF de commande, l'app lit le texte, retrouve le **fournisseur**, le **n° d'affaire** et le **n° de commande**, puis copie chaque fichier dans le dossier de l'affaire (`<dossier de classement>/…/<affaire>/<sous-dossier>/<commande>/`). Sans dossier d'affaire trouvé, le PDF va dans `_A_CLASSER`.

## Mettre en ligne (GitHub Pages)
1. Copie tout le contenu de ce dossier à la racine de ton dépôt, puis `git add . && git commit -m "PWA" && git push`.
2. Sur GitHub : **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`**.
3. Après une minute, l'app est sur `https://<ton-compte>.github.io/<nom-du-depot>/`. Envoie ce lien à tes collègues.

## Installer (chaque collègue)
Ouvrir le lien dans **Chrome ou Edge** sur ordinateur, puis cliquer sur « Installer l'app » (ou sur l'icône d'installation dans la barre d'adresse). Au premier PDF, choisir le dossier de classement : il est mémorisé. Au redémarrage, le navigateur peut redemander l'autorisation d'écriture, c'est normal.

## Réglages
Bouton **Réglages** : mêmes règles que l'ancien `config.json` (regex, `sous_dossier`, `dossier_final`, `fournisseurs_connus`, profondeur de recherche). Pour partager des règles identiques, copier-coller le bloc JSON à un collègue. La clé API Claude (option IA) est stockée uniquement dans le navigateur de la personne : à n'utiliser que sur des postes de confiance.

## Différences avec la version Python
- Le navigateur ne peut pas supprimer l'original : les fichiers sont **toujours copiés**, jamais déplacés.
- Chrome ou Edge uniquement (accès aux dossiers). Firefox et Safari ne le permettent pas.
- Fonctionne hors ligne (sauf l'option IA).

## Mise à jour
Après une modification, change `CACHE = 'classeur-pdf-v1'` dans `sw.js` (v2, v3…) pour que les collègues reçoivent la nouvelle version.

pdf.js (Mozilla, licence Apache 2.0) est inclus dans `vendor/`.
