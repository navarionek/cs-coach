# CS Coach

Zbiera dane z naszych meczów CS2 (Premier / Faceit) przez oficjalne Game State Integration i pokazuje je na stronie.

- **Gra → Supabase:** plik `gsi/gamestate_integration_cscoach.cfg` w folderze `game/csgo/cfg` sprawia, że CS2 POST-uje stan gry na edge function `cs-gsi` (projekt Supabase "WeedOut", schemat `cs`).
- **Supabase:** `cs.ingest()` składa z tego mecze (`cs.matches`), rundy (`cs.rounds`: zwycięzca, powód, czas, kasa, sprzęt, kille, dmg, przeżył) i ostatni stan gracza (`cs.live`).
- **Strona:** `index.html` + `app.js` (vanilla JS, supabase-js z CDN), tylko odczyt.

## Wdrożenie

```bash
supabase db query --linked --workdir E:/Projects/WeedOut -f E:/Projects/CsCoach/supabase/schema/001_cs.sql
supabase secrets set CS_GSI_TOKEN=<token z cfg> --project-ref qnhzbnofloghyhbmkvnq
supabase functions deploy cs-gsi --no-verify-jwt --project-ref qnhzbnofloghyhbmkvnq --workdir E:/Projects/CsCoach --use-api
```

`cs` musi być w `[api] schemas` w `WeedOut/supabase/config.toml` (+ `supabase config push`).

Prawdziwy cfg z tokenem jest w `.gitignore`; w repo jest tylko `gamestate_integration_cscoach.cfg.template`.
