-- Fine Edge Wardrobe Designer — run once in the Supabase SQL editor.

create table if not exists public.designs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name       text not null,
  client     text,
  project    text,
  data       jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists designs_user_updated_idx
  on public.designs (user_id, updated_at desc);

alter table public.designs enable row level security;

drop policy if exists "designs are private to their owner" on public.designs;
create policy "designs are private to their owner"
  on public.designs
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
