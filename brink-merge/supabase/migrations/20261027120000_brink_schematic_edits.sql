-- Schematic edit layer (Phase 2 of the Brink app). Additive only: one new
-- table, nothing existing is altered.
--
-- People edit the schematic in the app's EasySchematic editor. Their edits are
-- NOT written into an import's rows (brink_schematic_nodes / _connections stay
-- exactly what brink-merge generated from the takeoff). Each edit is a row
-- here, keyed by a STABLE target that survives a re-import:
--   device node  dev-<OpenTakeoff shape id>-<copy>
--   TR panel     tr-<OpenTakeoff TR shape id>
--   room         room-<slug>-<hash of the room label>
--   cable        cable-<OpenTakeoff run id>-<copy>-<cable n>
--   connection   conn|<source>|<sourceHandle>|<target>|<targetHandle>  (a connection a person added)
-- brink-merge renders an import's schematic as rows + the project's active
-- edits, and re-applies them on every import. An edit whose target is gone
-- becomes a warning issue on that import; it is never dropped or re-aimed.
-- Rules: brink-merge/docs/schematic-edits.md.
--
-- Append-only history: a newer edit of the same (target, kind) supersedes the
-- older one (superseded_at / superseded_by); a revert sets reverted_at. At most
-- one edit per (project, target, kind) is active (the partial unique index).
create table if not exists brink_schematic_edits (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references brink_projects(id) on delete cascade,
  target_key text not null,
  kind text not null check (kind in ('move', 'rename', 'room_assign', 'connect', 'disconnect', 'property')),
  payload jsonb not null,
  -- What the target was when the edit was made (label, node type, condition key), for messages.
  target_context jsonb,
  -- Who: the email from the verified Cloudflare Access JWT, and how it was established
  -- ('dev-bypass': local wrangler dev only; 'brink-merge': written by a brink-merge process, not the app).
  editor_email text not null,
  editor_auth text not null check (editor_auth in ('cloudflare-access', 'dev-bypass', 'brink-merge')),
  -- Opaque id of the browser tab that wrote it, so that tab can ignore its own echo. Not an identity.
  client_ref text,
  -- The import the editor was looking at.
  base_import_id uuid references brink_imports(id) on delete set null,
  created_at timestamptz not null default now(),
  superseded_at timestamptz,
  superseded_by uuid,
  reverted_at timestamptz,
  reverted_by text
);
create unique index if not exists brink_schematic_edits_active
  on brink_schematic_edits(project_id, target_key, kind) where superseded_at is null and reverted_at is null;
create index if not exists brink_schematic_edits_project on brink_schematic_edits(project_id, created_at);

alter table brink_schematic_edits enable row level security;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'brink_schematic_edits') then
      execute 'alter publication supabase_realtime add table brink_schematic_edits';
    end if;
  end if;
end $$;
