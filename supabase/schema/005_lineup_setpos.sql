-- In-game teleport for a lineup ("setpos x y z;setang p y r"), recorded by the Granko Recorder
-- with F6, so anyone can paste it into the console (sv_cheats 1) and stand exactly on the spot.
-- Apply with:
--   supabase db query --linked --workdir E:/Projects/WeedOut -f E:/Projects/CsCoach/supabase/schema/005_lineup_setpos.sql

alter table cs.lineups add column setpos text;

create or replace function cs.save_lineup(k text, l jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
    rid uuid := nullif(l ->> 'id', '')::uuid;
    sp jsonb := case when jsonb_typeof(l -> 'spot') = 'object' then l -> 'spot' end;
begin
    perform cs.require_key(k);
    if rid is null then
        insert into cs.lineups (map, side, nade, title, target, position, throw, description, images, video_url, spot, setpos, created_by)
        values (
            l ->> 'map', l ->> 'side', l ->> 'nade', btrim(l ->> 'title'), l ->> 'target', l ->> 'position',
            l ->> 'throw', l ->> 'description', coalesce(l -> 'images', '[]'), nullif(l ->> 'video_url', ''),
            sp, nullif(l ->> 'setpos', ''), nullif(l ->> 'created_by', '')::uuid
        )
        returning id into rid;
    else
        update cs.lineups set
            map = l ->> 'map',
            side = l ->> 'side',
            nade = l ->> 'nade',
            title = btrim(l ->> 'title'),
            target = l ->> 'target',
            position = l ->> 'position',
            throw = l ->> 'throw',
            description = l ->> 'description',
            images = coalesce(l -> 'images', '[]'),
            video_url = nullif(l ->> 'video_url', ''),
            spot = sp,
            setpos = nullif(l ->> 'setpos', ''),
            updated_at = now()
        where id = rid;
    end if;
    return rid;
end;
$$;
