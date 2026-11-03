-- Small private files for the team, downloadable from the Drużyna tab with the team key
-- (the GSI .cfg carries the ingest token, so it can't sit on the public page or in the repo).
-- Apply with:
--   supabase db query --linked --workdir E:/Projects/WeedOut -f E:/Projects/CsCoach/supabase/schema/007_team_files.sql
-- Content is loaded separately (not in git), e.g. the cfg from gsi/gamestate_integration_cscoach.cfg.

create table cs.team_files (
    name text primary key,
    content text not null,
    updated_at timestamptz not null default now()
);
alter table cs.team_files enable row level security;
grant all on cs.team_files to service_role;

create or replace function cs.team_file(k text, p_name text) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
    perform cs.require_key(k);
    return (select content from cs.team_files where name = p_name);
end;
$$;

revoke execute on function cs.team_file(text, text) from public;
grant execute on function cs.team_file(text, text) to anon, authenticated, service_role;
