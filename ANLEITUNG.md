# Server-Update 01.11.2026 (Spielversion 0.3.5)

Geändert:
- `server.js`: **Wiederverbinden in der Lobby.** Bricht bei jemandem die Verbindung kurz ab (Netzwechsel, Handy-Sperre, Tab im Hintergrund), hält der Server seinen Platz 20 Sekunden frei (angezeigt als „nicht bereit“). Das Spiel verbindet sich selbst neu und holt den Platz mit dem neuen Befehl `resume` zurück. Kommt er nicht zurück, wird der Platz danach frei. Mitten im Rennen bleibt es wie bisher.
  - Ein abgebrochener Spieler zählt bei „alle bereit“ nicht mit; startet der Countdown, fliegt ein noch nicht zurückgekehrter Platz raus.
  - Schonfrist einstellbar über die Umgebungsvariable `RESUME_GRACE_MS` (Standard 20000 = 20 s, muss in Render nicht gesetzt werden).
- `chat.js`, `classes.js`, `minigames.js`: unverändert (zur Sicherheit dabei).
- `test_resume.js`: Selbsttest (nur für lokal, muss nicht hoch).
- Ohne dieses Update funktioniert 0.3.5 trotzdem. Nur das automatische Wiederverbinden klappt nicht: Dann geht es wie bisher nach dem Verbindungsabbruch zurück ins Menü. Alte Spielversionen laufen mit dem neuen Server weiter.

1. Im GitHub-Repo `abi-game-28-server` die Datei `server.js` ersetzen (die anderen drei können gleich bleiben). Commit.
2. Render baut automatisch neu. Wenn der Deploy hängt: in Render „Manual Deploy“ → „Deploy latest commit“.
3. Prüfen: https://abi-game-28-server.onrender.com aufrufen. Es sollte wie bisher „Klassen: Firestore“ melden.

Lokal geprüft (mit laufendem Server): `test_resume`, `test_leave`, `test_client`, `test_chat`, `test_timeout`, `test_bot_handover`, `test_bots`, `test_items`, `test_modifier`, `test_minigames`, `test_classes`, `test_class_api` → alle grün.
