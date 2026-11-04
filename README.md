# Granko

(repo: cs-coach) Zbiera dane z naszych meczów CS2 (Premier / Faceit) przez oficjalne Game State Integration, trzyma playbook drużyny (taktyki + line-upy) i w trakcie meczu podpowiada taktykę na kolejną rundę. Strona: https://cs.czytanko.com (PWA).

- **Gra → Supabase:** plik `gsi/gamestate_integration_cscoach.cfg` w folderze `game/csgo/cfg` sprawia, że CS2 POST-uje stan gry na edge function `cs-gsi` (projekt Supabase "WeedOut", schemat `cs`).
- **Statystyki:** `cs.ingest()` składa z tego mecze (`cs.matches`), rundy (`cs.rounds`: zwycięzca, powód, czas, kasa, sprzęt, kille, przeżył) i ostatni stan gracza (`cs.live`). CS2 nie wysyła obrażeń, więc ADR jest pusty.
- **Playbook (za hasłem drużyny):** `cs.members`, `cs.lineups` (screeny w buckecie `cs-lineups`, wrzucane przez edge function `cs-upload`), `cs.tactics` (5 ról: gracz, pozycja, zadanie, line-upy). Odczyt i zapis tylko przez funkcje `cs.playbook()`, `cs.save_*()` itd., które sprawdzają hasło.
- **Live:** strona czyta `cs.live` całej piątki, liczy kasę i rundę, wybiera taktykę (`suggest()` w `js/live.js`: ekonomia, wynik taktyki w tym meczu i ogólnie, seria porażek) i zapisuje ją w `cs.calls`. Wszyscy dostają ją przez Realtime. Po końcu rundy `cs.ingest()` wpisuje do calla, czy taktyka weszła.
- **Mapy:** radary, emblematy i okładki map są wyciągnięte z `pak01_dir.vpk` gry (Source 2 Viewer CLI) i leżą w buckecie `cs-lineups` (tabele `cs.radars`, `cs.map_art`), nie w repo. Line-upy mają `spot` (skąd/gdzie ląduje), role w taktykach mają `path` (trasa: start, punkty, cel). Wszystkie mapy mają zoom (kółko, pinch, +/−). Na każdym radarze są callouty z gry (strefy `env_cs_place` z encji mapy, nazwy z `csgo_english.txt`, `js/calloutdata.js`, generuje je `tools/extract-callouts.js`; 🏷 je chowa). Trasy ról czytają się jako ciąg calloutów, a rolę można jednym wyborem wysłać „na callout”. Trasy idą po nav meshu gry (`data/nav/<mapa>.json` z `maps/<mapa>.nav`, generuje `tools/extract-nav.js`): A* po obszarach i najkrótsza linia przez przejścia, więc omijają ściany i przechodzą przez kolejne callouty. Rola trzyma klikane punkty w `path` i wyliczoną linię w `track`; „🧭 Po mapie” w edytorze to wyłącza.
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

## Granko Recorder (line-upy prosto z gry)

Na PC z CS2 i Node:

```bash
cp recorder/config.example.json recorder/config.json   # wpisz hasło drużyny i swój nick
node recorder/granko-recorder.js de_ancient            # albo de_inferno / de_nuke
```

Recorder odpala CS2 offline (z `-condebug`), sam wpisuje `exec granko` (cheaty, bez botów, nieskończona rozgrzewka, kasa i granaty, celownik bez reszty HUD-a) i czyta `console.log`:

- **F6** – stoisz w miejscu rzutu i celujesz: nowy line-up z `setpos/setang`, screenem z celownikiem i punktem na radarze,
- **F7** – po rzucie: screen efektu,
- **F8** – stoisz tam, gdzie granat wylądował: punkt lądowania na radarze,
- **F5** – powrót na ostatnią pozycję z F6.

CS2 nie ma zdalnej konsoli, więc klawisze odpalają małe cfg (`grankopos` itd.), a ich `execing …` i `getpos` widać w logu. Na koniec `exec grankooff` przywraca HUD i broń.

### Podgląd ze strony (zdalne sterowanie)

Gdy Recorder działa, zakładka **Podgląd** w Granko (z dowolnego urządzenia, także z telefonu) może nim sterować: klikasz na radarze „Stań tu” i opcjonalnie „Patrz tam”, wciskasz **Pokaż w grze**, a PC z CS2 teleportuje postać i odsyła screena (z teleportem do skopiowania i opcją „Zapisz jako line-up”).

Pod spodem: strona dodaje zadanie do `cs.agent_jobs` (`cs.agent_submit`), Recorder co ~1 s woła `cs.agent_take` (to też jego heartbeat w `cs.agent`), wpisuje komendy do `grankojob.cfg`, sam wciska **F9** i odsyła wynik przez `cs.agent_finish`. Radar nie zna wysokości, więc postać spada z niewielkiej wysokości nad najbliższym znanym punktem; każda pozycja z gry trafia do `recorder/zcache.json`, więc z czasem trafia coraz lepiej. Jeśli zadanie jest na inną mapę, Recorder sam ją zmienia.

### Agent w tle (status PC i start ze strony)

`recorder/Granko Agent.vbs` uruchamia ten sam program w trybie `--agent`, ukryty, z logiem w `recorder/agent.log`. Agent co 3 s zgłasza się do Granko (`cs.agent_ping`) ze stanem: PC online i CS2 wyłączony / w normalnej grze / trening / Recorder gotowy. Zakładka **Podgląd** pokazuje ten stan i ma przyciski **Uruchom CS2 + Recorder** (na wybranej mapie) i **Zamknij CS2**; teleport sam odpala grę, jeśli jest wyłączona. Normalnej gry (CS2 bez `-condebug`) agent nigdy nie rusza.

Autostart z Windowsem (skrót w folderze Autostart):

```powershell
powershell -ExecutionPolicy Bypass -File E:\Projects\CsCoach\recorder\install-autostart.ps1
```

Usunięcie: ten sam skrypt z `-Remove`. Druga kopia programu (np. `Granko Recorder.cmd`, gdy agent już działa) nie startuje równolegle, tylko prosi agenta o uruchomienie CS2.
