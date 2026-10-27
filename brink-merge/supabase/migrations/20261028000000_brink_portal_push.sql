-- Portal push (additive only: new tables, nothing existing is altered).
-- Same access model as the init migration: RLS on, no policies, so only the
-- service role reads or writes. No credential or token is ever stored here.

-- Cable type -> Portal part (data/catalog-map.json "cableParts" is the seed).
-- portal_sku is Portal's numeric partId, as in brink_catalog_map.
create table if not exists brink_portal_cable_parts (
  cable_type text primary key,
  portal_sku text,
  order_basis text not null check (order_basis in ('box', 'ft')),
  package_ft numeric,
  portal_unit_of_measure text,
  status text not null check (status in ('proposed', 'confirmed')),
  note text,
  updated_at timestamptz not null default now()
);

-- One row per push attempt, dry run or live, so a re-run never silently
-- creates a second Portal proposal. plan is the ordered request plan with
-- placeholders for values Portal returns; it never holds a token.
create table if not exists brink_portal_pushes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references brink_projects(id) on delete cascade,
  import_id uuid not null references brink_imports(id) on delete cascade,
  dry_run boolean not null,
  status text not null check (status in ('planned', 'aborted', 'started', 'succeeded', 'failed')),
  plan_hash text not null,
  plan jsonb not null,
  errors jsonb not null default '[]'::jsonb,
  app_version text not null,
  portal_proposal_id bigint,
  portal_area_id bigint,
  portal_area_option_id bigint,
  portal_item_ids jsonb not null default '[]'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists brink_portal_pushes_import on brink_portal_pushes(import_id, created_at desc);
create index if not exists brink_portal_pushes_project on brink_portal_pushes(project_id, created_at desc);

alter table brink_portal_cable_parts enable row level security;
alter table brink_portal_pushes enable row level security;

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['brink_portal_pushes'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = t) then
        execute format('alter publication supabase_realtime add table %I', t);
      end if;
    end loop;
  end if;
end $$;
