# Granko

(repo: cs-coach) Zbiera dane z naszych meczów CS2 (Premier / Faceit) przez oficjalne Game State Integration, trzyma playbook drużyny (taktyki + line-upy) i w trakcie meczu podpowiada taktykę na kolejną rundę. Strona: https://cs.czytanko.com (PWA).

- **Gra → Supabase:** plik `gsi/gamestate_integration_cscoach.cfg` w folderze `game/csgo/cfg` sprawia, że CS2 POST-uje stan gry na edge function `cs-gsi` (projekt Supabase "WeedOut", schemat `cs`).
- **Statystyki:** `cs.ingest()` składa z tego mecze (`cs.matches`), rundy (`cs.rounds`: zwycięzca, powód, czas, kasa, sprzęt, kille, przeżył) i ostatni stan gracza (`cs.live`). CS2 nie wysyła obrażeń, więc ADR jest pusty.
- **Playbook (za hasłem drużyny):** `cs.members`, `cs.lineups` (screeny w buckecie `cs-lineups`, wrzucane przez edge function `cs-upload`), `cs.tactics` (5 ról: gracz, pozycja, zadanie, line-upy). Odczyt i zapis tylko przez funkcje `cs.playbook()`, `cs.save_*()` itd., które sprawdzają hasło.
- **Live:** strona czyta `cs.live` całej piątki, liczy kasę i rundę, wybiera taktykę (`suggest()` w `js/live.js`: ekonomia, wynik taktyki w tym meczu i ogólnie, seria porażek) i zapisuje ją w `cs.calls`. Wszyscy dostają ją przez Realtime. Po końcu rundy `cs.ingest()` wpisuje do calla, czy taktyka weszła.
- **Mapy:** radary, emblematy i okładki map są wyciągnięte z `pak01_dir.vpk` gry (Source 2 Viewer CLI) i leżą w buckecie `cs-lineups` (tabele `cs.radars`, `cs.map_art`), nie w repo. Line-upy mają `spot` (skąd/gdzie ląduje), role w taktykach mają `path` (trasa: start, punkty, cel). Wszystkie mapy mają zoom (kółko, pinch, +/−).
- **Strona:** `index.html` + `js/*.js` (vanilla JS, moduły ES, supabase-js z CDN), GitHub Pages z gałęzi master.

## Wdrożenie

```bash
supabase db query --linked --workdir E:/Projects/WeedOut -f E:/Projects/CsCoach/supabase/schema/001_cs.sql
supabase db query --linked --workdir E:/Projects/WeedOut -f E:/Projects/CsCoach/supabase/schema/002_playbook.sql
supabase secrets set CS_GSI_TOKEN=<token z cfg> --project-ref qnhzbnofloghyhbmkvnq
supabase functions deploy cs-gsi --no-verify-jwt --project-ref qnhzbnofloghyhbmkvnq --workdir E:/Projects/CsCoach --use-api
supabase functions deploy cs-upload --no-verify-jwt --project-ref qnhzbnofloghyhbmkvnq --workdir E:/Projects/CsCoach --use-api
```

`cs` musi być w `[api] schemas` w `WeedOut/supabase/config.toml` (+ `supabase config push`). Hasło drużyny ustawia się SQL-em z komentarza na górze `002_playbook.sql` (w bazie jest tylko jego hash).

Prawdziwy cfg z tokenem i `team-key.txt` z hasłem są w `.gitignore`; w repo jest tylko `gamestate_integration_cscoach.cfg.template`.
