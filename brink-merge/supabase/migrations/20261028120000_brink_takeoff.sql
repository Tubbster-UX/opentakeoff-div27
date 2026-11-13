-- Takeoff canvas in the Brink app (Phase 3). Additive only: two new tables and
-- one private Storage bucket; nothing existing is altered, dropped or renamed.
--
-- 1. brink_sheets: the plan PDFs a project's takeoff is drawn on. The bytes live
--    in Supabase Storage (bucket brink-plans, private); this table is the index.
--    Only the app's Worker reads or writes the bucket, with the service-role key
--    (a Worker secret). Browsers read a sheet through the Worker.
--
-- 2. brink_takeoff_edits: people's edits to the takeoff, made in the app's
--    OpenTakeoff canvas. Like brink_schematic_edits, they are a LAYER: the
--    import's raw takeoff (brink_imports.takeoff, the machine original that
--    OpenTakeoff / an agent exported) is never rewritten. brink-merge renders
--    the takeoff people see as that original + the project's active edits, and
--    re-applies them on every import (src/takeoffEdits.ts,
--    docs/takeoff-edits.md). Keyed by OpenTakeoff's own stable ids:
--      shape_put / shape_delete   target = the shape id   (shp-…)
--      condition_put              target = the condition id (cnd-…)
--      sheet_scale                target = the sheet id   (file.pdf, file.pdf#2)
--    Append-only history: a newer edit of the same target supersedes the older
--    one; a revert sets reverted_at. At most one edit per (project, target type,
--    target) is active (the partial unique index).
--
-- Every table: RLS on with no policies (service role only), and in the
-- supabase_realtime publication when it exists, like the other brink tables.

create table if not exists brink_sheets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references brink_projects(id) on delete cascade,
  -- The file name: OpenTakeoff's sheet key for page 1 (page n is "<name>#n").
  name text not null,
  -- Object path inside the bucket: <project id>/<sheet id>/<sha256>.pdf
  storage_bucket text not null default 'brink-plans',
  storage_path text not null,
  content_type text not null default 'application/pdf',
  byte_size bigint not null check (byte_size > 0),
  sha256 text not null,
  -- Pages in the file, when the uploader read it (pdf.js in the browser); null when not known.
  page_count integer check (page_count is null or page_count > 0),
  -- 1, then +1 each time a file of the same name with other bytes replaces it.
  rev integer not null default 1 check (rev > 0),
  -- Who uploaded it: the verified Cloudflare Access email (see brink_schematic_edits.editor_auth).
  uploaded_by text not null,
  uploaded_auth text not null check (uploaded_auth in ('cloudflare-access', 'dev-bypass', 'brink-merge')),
  client_ref text,
  created_at timestamptz not null default now(),
  -- A replaced or removed file keeps its row (and its object) as history.
  replaced_by uuid,
  removed_at timestamptz,
  removed_by text
);
-- One current file per (project, name).
create unique index if not exists brink_sheets_current
  on brink_sheets(project_id, name) where removed_at is null and replaced_by is null;
create index if not exists brink_sheets_project on brink_sheets(project_id, created_at);

create table if not exists brink_takeoff_edits (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references brink_projects(id) on delete cascade,
  target_type text not null check (target_type in ('shape', 'condition', 'sheet')),
  target_key text not null,
  kind text not null check (kind in ('shape_put', 'shape_delete', 'condition_put', 'sheet_scale')),
  payload jsonb not null,
  -- What the target was when edited (finish tag, measure role, a hash of the machine original), for messages.
  target_context jsonb,
  editor_email text not null,
  editor_auth text not null check (editor_auth in ('cloudflare-access', 'dev-bypass', 'brink-merge')),
  -- Opaque id of the browser tab that wrote it, so that tab ignores its own realtime echo. Not an identity.
  client_ref text,
  -- The import the editor was looking at.
  base_import_id uuid references brink_imports(id) on delete set null,
  created_at timestamptz not null default now(),
  superseded_at timestamptz,
  superseded_by uuid,
  reverted_at timestamptz,
  reverted_by text,
  check ((target_type = 'shape') = (kind in ('shape_put', 'shape_delete'))),
  check ((target_type = 'condition') = (kind = 'condition_put')),
  check ((target_type = 'sheet') = (kind = 'sheet_scale'))
);
create unique index if not exists brink_takeoff_edits_active
  on brink_takeoff_edits(project_id, target_type, target_key) where superseded_at is null and reverted_at is null;
create index if not exists brink_takeoff_edits_project on brink_takeoff_edits(project_id, created_at);

alter table brink_sheets enable row level security;
alter table brink_takeoff_edits enable row level security;

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['brink_sheets', 'brink_takeoff_edits'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = t) then
        execute format('alter publication supabase_realtime add table %I', t);
      end if;
    end loop;
  end if;
end $$;

-- The private bucket for plan PDFs (Supabase Storage). Only where Storage is
-- installed (a plain Postgres or PGlite has no storage schema). Not public: no
-- object in it has a public URL, and with no storage.objects policies only the
-- service role reaches it.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'storage' and c.relname = 'buckets') then
    execute $q$
      insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('brink-plans', 'brink-plans', false, 104857600, array['application/pdf'])
      on conflict (id) do nothing
    $q$;
  end if;
end $$;
