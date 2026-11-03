-- 009: agent jobs can also start CS2 practice and quit it (applied by hand):
alter table cs.agent_jobs drop constraint agent_jobs_kind_check;
alter table cs.agent_jobs add constraint agent_jobs_kind_check check (kind in ('teleport', 'start', 'quit'));

-- Heartbeat on its own, so a long job (cold CS2 start) doesn't make the PC look offline.
create or replace function cs.agent_ping(k text, p_map text, p_info jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
    perform cs.require_key(k);
    insert into cs.agent (id, seen_at, map, info) values (1, now(), p_map, p_info)
    on conflict (id) do update set seen_at = now(), map = excluded.map, info = excluded.info;
end;
$$;
revoke execute on function cs.agent_ping(text, text, jsonb) from public;
grant execute on function cs.agent_ping(text, text, jsonb) to anon, authenticated, service_role;
