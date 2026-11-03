-- Radar images per map (and level, for Nuke) and lineup positions on them.
-- Apply with:
--   supabase db query --linked --workdir E:/Projects/WeedOut -f E:/Projects/CsCoach/supabase/schema/003_radars.sql
--
-- The radars are extracted from the game's own pak01_dir.vpk (panorama/images/overheadmaps/
-- <map>_radar_psd.vtex_c, decompiled with Source 2 Viewer) and uploaded to the cs-lineups bucket
-- like any screenshot, so they never sit in the public repo. Rows are inserted by hand:
--   insert into cs.radars (map, level, path) values ('de_nuke', 'lower', '<uploaded path>');

create table cs.radars (
    map text not null,
    -- 'main', or 'lower' for Nuke's lower floor.
    level text not null default 'main',
    path text not null,
    primary key (map, level)
);
alter table cs.radars enable row level security;
grant all on cs.radars to service_role;

-- {from: {x, y, level}, to: {x, y, level}} with x/y as 0..1 fractions of the radar image.
alter table cs.lineups add column spot jsonb;

create or replace function cs.playbook(k text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
    perform cs.require_key(k);
    return jsonb_build_object(
        'members', coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at) from cs.members m), '[]'),
        'tactics', coalesce((select jsonb_agg(to_jsonb(t) order by t.name) from cs.tactics t), '[]'),
        'lineups', coalesce((select jsonb_agg(to_jsonb(l) order by l.title) from cs.lineups l), '[]'),
        'radars', coalesce((select jsonb_agg(to_jsonb(r) order by r.map, r.level) from cs.radars r), '[]')
    );
end;
$$;

create or replace function cs.save_lineup(k text, l jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
    rid uuid := nullif(l ->> 'id', '')::uuid;
    sp jsonb := case when jsonb_typeof(l -> 'spot') = 'object' then l -> 'spot' end;
begin
    perform cs.require_key(k);
    if rid is null then
        insert into cs.lineups (map, side, nade, title, target, position, throw, description, images, video_url, spot, created_by)
        values (
            l ->> 'map', l ->> 'side', l ->> 'nade', btrim(l ->> 'title'), l ->> 'target', l ->> 'position',
            l ->> 'throw', l ->> 'description', coalesce(l -> 'images', '[]'), nullif(l ->> 'video_url', ''),
            sp, nullif(l ->> 'created_by', '')::uuid
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
            updated_at = now()
        where id = rid;
    end if;
    return rid;
end;
$$;
