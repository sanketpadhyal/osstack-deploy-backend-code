export const osstackProjectDataSql = `
create table if not exists public.osstack_deployment_events (
  id uuid primary key default gen_random_uuid(),
  deployment_id uuid not null references public.osstack_deployments(id) on delete cascade,
  user_id uuid not null references public.osstack_profiles(id) on delete cascade,
  project_id uuid not null references public.osstack_projects(id) on delete cascade,
  stage text not null check (stage in ('QUEUED', 'CLONING', 'INSTALLING', 'BUILDING', 'UPLOADING', 'COMPLETED', 'FAILED')),
  message text not null,
  log text,
  live_url text,
  created_at timestamptz not null default now()
);

create index if not exists osstack_deployment_events_deployment_id_created_at_idx
on public.osstack_deployment_events (deployment_id, created_at);

alter table public.osstack_deployment_events enable row level security;
`;
