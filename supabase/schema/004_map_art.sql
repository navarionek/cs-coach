-- Map emblems and cover screenshots for the map pickers, taken from the game's own files like the
-- radars (panorama/images/map_icons/map_icon_<map>.vsvg_c rendered to PNG, and
-- panorama/images/map_icons/screenshots/720p/<map>_png.vtex_c shrunk to a 960x540 JPEG).
-- Apply with:
--   supabase db query --linked --workdir E:/Projects/WeedOut -f E:/Projects/CsCoach/supabase/schema/004_map_art.sql

create table cs.map_art (
    map text not null,
    kind text not null check (kind in ('icon', 'cover')),
    path text not null,
    primary key (map, kind)
);
alter table cs.map_art enable row level security;
grant all on cs.map_art to service_role;

create or replace function cs.playbook(k text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
    perform cs.require_key(k);
    return jsonb_build_object(
        'members', coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at) from cs.members m), '[]'),
        'tactics', coalesce((select jsonb_agg(to_jsonb(t) order by t.name) from cs.tactics t), '[]'),
        'lineups', coalesce((select jsonb_agg(to_jsonb(l) order by l.title) from cs.lineups l), '[]'),
        'radars', coalesce((select jsonb_agg(to_jsonb(r) order by r.map, r.level) from cs.radars r), '[]'),
        'map_art', coalesce((select jsonb_agg(to_jsonb(a)) from cs.map_art a), '[]')
    );
end;
$$;
