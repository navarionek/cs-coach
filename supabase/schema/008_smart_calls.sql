-- Smarter tactic picking: tactics get a target site and tags, calls remember the economy they were
-- made in (ours and the estimated enemy one) so win rates can be read per situation.
-- Apply with:
--   supabase db query --linked --workdir E:/Projects/WeedOut -f E:/Projects/CsCoach/supabase/schema/008_smart_calls.sql

alter table cs.tactics
    add column site text check (site in ('A', 'B', 'mid')),
    add column tags text[] not null default '{}';

alter table cs.calls
    add column econ text,
    add column enemy_econ text;

create or replace function cs.save_tactic(k text, t jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
    rid uuid := nullif(t ->> 'id', '')::uuid;
    tg text[] := array(select jsonb_array_elements_text(coalesce(t -> 'tags', '[]')));
begin
    perform cs.require_key(k);
    if rid is null then
        insert into cs.tactics (map, side, name, kind, summary, notes, roles, archived, site, tags, created_by)
        values (
            t ->> 'map', t ->> 'side', btrim(t ->> 'name'), coalesce(t ->> 'kind', 'any'), t ->> 'summary',
            t ->> 'notes', coalesce(t -> 'roles', '[]'), coalesce((t ->> 'archived')::boolean, false),
            nullif(t ->> 'site', ''), tg, nullif(t ->> 'created_by', '')::uuid
        )
        returning id into rid;
    else
        update cs.tactics set
            map = t ->> 'map',
            side = t ->> 'side',
            name = btrim(t ->> 'name'),
            kind = coalesce(t ->> 'kind', 'any'),
            summary = t ->> 'summary',
            notes = t ->> 'notes',
            roles = coalesce(t -> 'roles', '[]'),
            archived = coalesce((t ->> 'archived')::boolean, false),
            site = nullif(t ->> 'site', ''),
            tags = tg,
            updated_at = now()
        where id = rid;
    end if;
    return rid;
end;
$$;

drop function cs.make_call(text, text, text, int, uuid, uuid, boolean);
create or replace function cs.make_call(
    k text, p_map text, p_side text, p_round int, p_tactic uuid, p_by uuid, p_auto boolean,
    p_econ text default null, p_enemy text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    existing cs.calls;
    r cs.calls;
begin
    perform cs.require_key(k);
    perform pg_advisory_xact_lock(hashtext('cs-call:' || p_map));
    select * into existing from cs.calls
    where map = p_map and round_no = p_round and created_at > now() - interval '4 minutes'
    order by created_at desc limit 1;
    -- A call made for the wrong side (sides swapped at half time) doesn't count.
    if p_auto and existing.id is not null and existing.side = p_side then
        return to_jsonb(existing);
    end if;
    delete from cs.calls where map = p_map and round_no = p_round and created_at > now() - interval '4 minutes';
    insert into cs.calls (map, side, round_no, tactic_id, called_by, auto, econ, enemy_econ)
    values (p_map, p_side, p_round, p_tactic, p_by, p_auto, p_econ, p_enemy)
    returning * into r;
    return to_jsonb(r);
end;
$$;
revoke execute on function cs.make_call(text, text, text, int, uuid, uuid, boolean, text, text) from public;
grant execute on function cs.make_call(text, text, text, int, uuid, uuid, boolean, text, text) to anon, authenticated, service_role;
