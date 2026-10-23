# Klassen & Schulziel einrichten (Render + Firebase)

Stand 23.10.2026 · gehört zu Etappe 3. Ohne diese Einrichtung läuft der Server weiter, die Klassen liegen dann aber nur im Arbeitsspeicher
(gehen bei jedem Neustart von Render verloren). Auf der Startseite des Servers steht, welcher Speicher aktiv ist:
`Abi Game 28 Server ok, Räume: 0, Klassen: Firestore` (richtig) oder `… Klassen: Arbeitsspeicher` (Dienstkonto fehlt).

## 1. Server-Dateien hochladen (GitHub-Repo `abi-game-28-server`)
Aus `Downloads/server_upload_20261023/` ins Repo kopieren und committen:
- `server.js` (neu: Klassen, Token-Prüfung, `/api/class`)
- `classes.js` (**neue Datei** – ohne sie startet der Server nicht)
- `minigames.js` (**neue Datei** – Minigame-Läufe, Prüfung, Münzen, Bestenlisten)
- `package.json` und `package-lock.json` (neu: `firebase-admin`)
- optional `test_classes.js`, `test_class_api.js` (Tests, laufen lokal mit `node test_classes.js`)

Render baut danach automatisch neu (Build-Befehl `npm install`, Start `node server.js`).

## 2. Dienstkonto-Schlüssel aus Firebase holen
1. Firebase-Konsole → Zahnrad **Projekteinstellungen** → Reiter **Dienstkonten**.
2. **Neuen privaten Schlüssel generieren** → bestätigen. Es lädt eine `.json`-Datei herunter.
3. **Diese Datei ist geheim.** Nie ins GitHub-Repo, nie ins Spiel, nicht weitergeben.

## 3. Schlüssel bei Render eintragen
1. Render → dein Server-Dienst → **Environment** → **Add Environment Variable**.
2. Key: `FIREBASE_SERVICE_ACCOUNT`
3. Value: den **kompletten Inhalt** der JSON-Datei (mit Notepad öffnen, alles markieren, kopieren, einfügen).
4. **Save Changes** → Render startet den Server neu.
5. Server-Adresse im Browser öffnen → dort muss `Klassen: Firestore` stehen.

## 4. Firestore-Regeln
Keine Änderung nötig. Die Klassen-Daten (`classes`, `classMembers`, `school`) schreibt nur der Server über das Dienstkonto;
die bestehende Regel „alles andere ist gesperrt“ hält Spieler davon fern.

## Was der Server zählt
- Jedes **Online-Rennen** (öffentlich oder privat), **nicht** das Zeitrennen. Gezählt wird, wer ins Ziel kommt.
- Nur angemeldete Konten (kein Gast). Das Spiel schickt dazu sein Firebase-Token, der Server prüft es.
- Punkte pro Klasse und Rennen: allein 1, sonst Mitfahrer × 1,5 aufgerundet (2 → 3, 4 → 6).
- Wochenziel: 10 Punkte pro Mitglied, mindestens 30, höchstens 250. Wechsel Montag 0 Uhr (Berlin).
- Schulziel: alle zwei Wochen, 12 Rennen pro aktivem Spieler.
- Klassenbox/Schulbox: nur für Mitfahrer, einmal je Woche bzw. Abschnitt, im Spiel unter „Meine Boxen“.

## Platzhalter (gemeinsam festlegen)
- Inhalt von Klassen- und Schulbox (Chancen wie Wochenbox, Schulbox etwas besser).
- Rausgewählte dürfen 7 Tage nicht in dieselbe Klasse zurück, aber sofort in eine andere.
- Anführer: im Club der Gründer, in vorgefertigten Klassen wer am meisten für die Klasse gefahren ist (Titel „Klassensprecher/in“).
- Wortfilter für Club-Namen: kurze Liste harter Beleidigungen (`classes.js` und `ClassModels.cs`), später auch für den Chat.
