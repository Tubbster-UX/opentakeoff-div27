-- brink-merge system of record (D1, re-planned: Postgres / Supabase is the
-- source of truth; the EasySchematic file is rendered from these rows).
-- Internal Brink tool: every table has RLS on and NO anon / authenticated
-- policy, so only the service role (the CLI, the brink MCP server, a future
-- dashboard backend) reads or writes. Tables join the supabase_realtime
-- publication when it exists, for the combined OT + ES dashboard.

create table if not exists brink_projects (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  current_import_id uuid,
  created_at timestamptz not null default now()
);

-- One row per import of an OpenTakeoff export: the raw files are kept so any
-- number on the BOM can be traced back and re-derived.
create table if not exists brink_imports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references brink_projects(id) on delete cascade,
  takeoff jsonb not null,
  report jsonb,
  takeoff_sha256 text not null,
  report_sha256 text,
  ot_schema text not null,
  es_schema_version integer not null,
  errors integer not null default 0,
  warnings integer not null default 0,
  imported_at timestamptz not null default now()
);
create index if not exists brink_imports_project on brink_imports(project_id, imported_at desc);

do $$ begin
  alter table brink_projects add constraint brink_projects_current_import
    foreign key (current_import_id) references brink_imports(id) on delete set null;
exception when duplicate_object then null; end $$;

-- The Brink catalog map (data/catalog-map.json is its seed / export).
create table if not exists brink_catalog_map (
  condition_key text primary key,
  kind text not null check (kind in ('device', 'tr', 'route', 'plain')),
  es_device_type text,
  es_template_ref jsonb,
  label text,
  port jsonb,
  cable_type text,
  portal_sku text,
  status text not null check (status in ('proposed', 'confirmed')),
  note text,
  updated_at timestamptz not null default now()
);

create table if not exists brink_bom_lines (
  import_id uuid not null references brink_imports(id) on delete cascade,
  line_no integer not null,
  kind text not null,
  condition_key text not null,
  description text not null,
  qty numeric not null,
  unit text not null,
  mapping_status text,
  es_device_type text,
  cable_type text,
  net_lf numeric,
  order_lf numeric,
  portal_sku text,
  severity text,
  code text,
  line jsonb not null,
  primary key (import_id, line_no)
);

create table if not exists brink_issues (
  import_id uuid not null references brink_imports(id) on delete cascade,
  seq integer not null,
  severity text not null check (severity in ('error', 'warning')),
  code text not null,
  message text not null,
  condition_key text,
  refs jsonb,
  primary key (import_id, seq)
);

-- The schematic, one row per EasySchematic element.
create table if not exists brink_schematics (
  import_id uuid primary key references brink_imports(id) on delete cascade,
  name text not null,
  version integer not null,
  title_block jsonb,
  custom_templates jsonb not null default '[]'::jsonb,
  extra jsonb not null default '{}'::jsonb
);

create table if not exists brink_schematic_nodes (
  import_id uuid not null references brink_imports(id) on delete cascade,
  seq integer not null,
  node_id text not null,
  node_type text not null,
  parent_id text,
  label text,
  device_type text,
  condition_key text,
  template_id text,
  x numeric not null,
  y numeric not null,
  node jsonb not null,
  primary key (import_id, node_id)
);
create index if not exists brink_schematic_nodes_order on brink_schematic_nodes(import_id, seq);

create table if not exists brink_schematic_connections (
  import_id uuid not null references brink_imports(id) on delete cascade,
  seq integer not null,
  edge_id text not null,
  source_node text not null,
  source_handle text,
  target_node text not null,
  target_handle text,
  signal_type text,
  cable_length_ft numeric,
  cable_type text,
  run_id text,
  edge jsonb not null,
  primary key (import_id, edge_id)
);
create index if not exists brink_schematic_connections_order on brink_schematic_connections(import_id, seq);

alter table brink_projects enable row level security;
alter table brink_imports enable row level security;
alter table brink_catalog_map enable row level security;
alter table brink_bom_lines enable row level security;
alter table brink_issues enable row level security;
alter table brink_schematics enable row level security;
alter table brink_schematic_nodes enable row level security;
alter table brink_schematic_connections enable row level security;

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['brink_projects', 'brink_imports', 'brink_bom_lines', 'brink_issues', 'brink_schematic_nodes', 'brink_schematic_connections'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = t) then
        execute format('alter publication supabase_realtime add table %I', t);
      end if;
    end loop;
  end if;
end $$;
