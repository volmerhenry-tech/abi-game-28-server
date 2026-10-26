# Server-Update 26.10.2026 (Spielversion 0.3.2)

Geändert:
- `minigames.js`: zwei neue Minigames mit eigenen Bestenlisten je Variante:
  - Flaggenraten: `flags` (4 Antworten) und `flags_type` (selbst eintippen)
  - Länder nennen: `countries_all`, `countries_europe`, `countries_asia`, `countries_africa`, `countries_namerica`, `countries_samerica`, `countries_oceania`, `countries_states`
- Ohne dieses Update lehnt der Server Ergebnisse der neuen Spiele als „Unbekanntes Spiel“ ab. Dann zählen sie nur auf dem Gerät, ohne Münzen.
- `server.js` und `classes.js` enthalten den Stand vom 25.10. (Modifier, Bot-Übergabe, Club-Sperre). Falls das Paket vom 25.10. schon oben ist, ändert sich daran nichts. Sonst kommt es hiermit mit.

1. Im GitHub-Repo `abi-game-28-server` die Dateien ersetzen (Commit).
2. Render baut automatisch neu. Wenn der Deploy hängt: in Render „Manual Deploy“ → „Deploy latest commit“.
3. Prüfen: https://abi-game-28-server.onrender.com aufrufen, es sollte wie bisher „Klassen: Firestore“ melden.

Lokal geprüft: `node test_minigames.js` → „alles ok“. Mit laufendem Server `node test_modifier.js` → „Alles OK“.
