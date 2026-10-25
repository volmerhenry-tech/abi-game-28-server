# Server-Update 25.10.2026 (Spielversion 0.3.1)

Geändert:
- `classes.js`: 7-Tage-Sperre nach Rauswurf gilt nur noch für Clubs, nicht für Schulklassen (Test `test_classes.js`)
- `server.js`: Geht der Spieler, der die Bots fährt, mitten im Rennen, übernimmt ein anderer Spieler die Bots (letzte Stelle, Runde, Checkpoint). Vorher verschwanden sie. Neuer Test `test_bot_handover.js`.
- `server.js` (Nachtrag am Abend): Spiel-Modifier. Der Gastgeber einer privaten Lobby wählt ihn (neue Nachricht `modifier`, nur im Modus Rennen). In öffentlichen Lobbys würfelt der Server bei jeder Kartenwahl, Chance 50 %, ohne Turbo-Wahnsinn (Einstellung `publicModifierChance`). Neuer Test `test_modifier.js`. Die neuen Items Kaugummi und Strafarbeit laufen über die vorhandene Nachricht `ie`, dafür ist nichts nötig.

Das Spiel ab Version 0.3.1 versteht die Übergabe. Ältere Spielversionen bekommen die neue Nachricht, ignorieren sie aber: Dort bleiben die Bots dann stehen, statt zu verschwinden. Deshalb Server und Spiel am selben Tag hochladen.

1. Im GitHub-Repo `abi-game-28-server` die Dateien ersetzen bzw. hinzufügen (Commit).
2. Render baut automatisch neu. Wenn der Deploy hängt: in Render „Manual Deploy“ → „Deploy latest commit“.
3. Prüfen: https://abi-game-28-server.onrender.com aufrufen, es sollte wie bisher „Klassen: Firestore“ melden.

Lokal geprüft: `node test_classes.js` → „alles ok“; mit laufendem Server `node test_bot_handover.js`, `node test_bots.js`, `node test_leave.js` → „Alles in Ordnung“. Nach dem Modifier-Nachtrag zusätzlich `node test_modifier.js` → „Alles OK“, `test_items.js`, `test_client.js`, `test_timeout.js` weiterhin grün.
