# Repertoire Trainer

A small web app for drilling the lines of your opening repertoire. Add it to your iPhone's home screen and it runs full screen, works offline, and keeps your scores on the phone.

There is no build step. Every file in this folder is served as is.

## Try it on your computer first

Browsers block ES modules and `fetch` on `file://` pages, so serve the folder:

```sh
cd repertoire-trainer
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Put it on GitHub Pages

1. Create a repository and upload the **contents** of this folder to its root (so `index.html` sits at the top level).
2. In the repository, open **Settings → Pages**, choose **Deploy from a branch**, pick `main` and `/ (root)`, and save.
3. After a minute the app is live at `https://<your-username>.github.io/<repo-name>/`.
4. On your iPhone, open that address in Safari, tap **Share**, then **Add to Home Screen**.

On a free GitHub account, Pages only works for public repositories, so your PGN files will be publicly readable. If you'd rather keep them private, Cloudflare Pages and Netlify can deploy from a private repository for free, and this folder works there unchanged.

## Adding your repertoire

Everything is described in `repertoires/index.json`:

```json
{
  "repertoires": [
    {
      "name": "Italian Game",
      "color": "white",
      "chapters": [
        { "name": "Giuoco Piano", "pgn": "italian/giuoco-piano.pgn" },
        { "name": "Two Knights Defense", "pgn": "italian/two-knights.pgn" }
      ]
    }
  ]
}
```

- **`color`** is the side you play. It can also be set on a single chapter. If it's missing, the PGN's `[Orientation "..."]` header is used (Lichess adds it), otherwise White.
- **`pgn`** paths are relative to `index.json`.
- **`id`** (optional, on a chapter) is what your scores are saved under. By default that's the `pgn` path. If you rename or move a PGN file, set `"id"` to the old path to keep its scores.

### One file for a whole repertoire (Lichess studies)

Instead of `chapters`, a repertoire can point to a single PGN file that holds several games. Each game becomes a chapter, named from its `[ChapterName]` header or from the part of `[Event]` after the colon. This matches a Lichess study export, so you can build the repertoire in a study and download it with **Share → Study PGN**:

```json
{ "name": "London System", "color": "white", "pgn": "london/study.pgn" }
```

### How a PGN becomes lines

Every path from the first move to the end of a variation is one line. For example:

```
1. e4 e5 2. Nf3 Nc6 (2... d6 3. d4) 3. Bb5 *
```

gives two lines: `1.e4 e5 2.Nf3 Nc6 3.Bb5` and `1.e4 e5 2.Nf3 d6 3.d4`.

- Variations, nested variations, several games per file, comments, NAGs and `[FEN]` start positions all work.
- Comments `{ like this }` are shown under the board when the move is played. Lichess arrow and clock tags are removed.
- Identical lines are counted once. Lines where you never make a move are skipped.
- If a move can't be played, the line stops there and the problem is listed at the bottom of the chapter screen.

## Practicing

- **Tap a chapter** to practice its lines in random order.
- **Tap the circles** to select chapters from any repertoires, then press **Practice selected**. The circle next to a repertoire selects all of its chapters.
- **Weak lines** practices only the lines you're struggling with (from your selection, or from everything when nothing is selected).

The opponent's moves are played for you. When you play a wrong move, the piece goes back and the line is marked as missed. Try again. After a second wrong try (or when you press **Show move**) an arrow shows the right move, and you play it to continue.

If you play a move that your repertoire has in that position but this particular line doesn't, it's not counted as a mistake. The app tells you and waits for the move this line wants.

Skipping a line only counts as a miss if you already made a mistake in it.

## Scores

- A **chapter's score** is clean lines divided by attempts, over the lines currently in that chapter. The eight-square bar fills up as it rises.
- A **line is weak** when you play it cleanly less than 50% of the time, or when you missed it the last time you played it. Change `WEAK_THRESHOLD` and `WEAK_IF_LAST_MISSED` in `js/config.js` to taste.
- Scores belong to the exact moves of a line. If you change a line's moves, it starts fresh.

## Backup and restore

Scores are stored on the device only. In **Settings**, **Copy backup** gives you a line of text starting with `REPTRAIN1:`. Keep it in a note. To get your scores back, paste it under **Restore progress**. Restoring keeps, for every line, whichever copy has more attempts, so restoring an old backup never wipes newer progress.

On iPhone, the home-screen app and Safari keep separate storage. Practice from the home-screen icon, and use a backup to move scores between the two.

## Updating your PGNs

Push the changed files. GitHub Pages usually updates within a minute or two. The app always tries the network first, so the next launch picks up the change. If it doesn't, use **Settings → Reload files**.

## Files

```
index.html              App shell
manifest.webmanifest    Home-screen name, icon and colors
sw.js                   Offline support
css/app.css             All styles, including the board colors
js/app.js               Screens, practice logic, settings
js/pgn.js               PGN parser and line extraction
js/store.js             Scores, settings, backup format
js/sound.js             Move sounds (generated, no audio files)
js/config.js            Tuning values
vendor/                 chess.js and chessground (prebuilt), piece images
fonts/                  Spectral
icons/                  App icons
repertoires/            Your index.json and PGN files (samples included)
```

## Credits and licenses

- [chessground](https://github.com/lichess-org/chessground) 9.2.1, the Lichess board, GPL-3.0. Because of this, the app as a whole falls under GPL-3.0 if you share it.
- [chess.js](https://github.com/jhlywa/chess.js) 1.4.0, BSD-2-Clause.
- Chess pieces: cburnett set by Colin M.L. Burnett, as shipped with chessground.
- [Spectral](https://github.com/productiontype/Spectral) by Production Type, SIL Open Font License 1.1.
- The sample PGNs are mainstream opening theory written for this project. Replace them with your own.
