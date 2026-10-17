-- =====================================================================
-- Tablero de gestión de tareas · HU / HA por usuario
-- Pega este archivo en Supabase > SQL Editor > Run (proyecto nuevo).
-- Cada usuario ve y gestiona solo sus propias HU, HA e historial (RLS).
-- =====================================================================

-- 1. Tablas ------------------------------------------------------------

create table public.hu (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid default auth.uid() references auth.users(id) on delete cascade,
  codigo        text not null,                    -- ID de la HU en Azure DevOps
  titulo        text not null,
  estado        text not null default 'por_hacer'
                check (estado in ('por_hacer', 'en_desarrollo', 'creada')),
  ha_esperadas  int  check (ha_esperadas is null or ha_esperadas >= 0),
  orden         int  not null default 0,
  notas         text default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (owner_id, codigo)
);
create index hu_owner_idx on public.hu(owner_id);

create table public.ha (
  id          uuid primary key default gen_random_uuid(),
  hu_id       uuid not null references public.hu(id) on delete cascade,
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  codigo      text not null,                      -- ID de la HA (obligatorio)
  titulo      text,                               -- opcional
  created_at  timestamptz not null default now(),
  unique (hu_id, codigo)
);
create index ha_hu_idx on public.ha(hu_id);
create index ha_owner_idx on public.ha(owner_id);

create table public.hu_historial (
  id          bigint generated always as identity primary key,
  hu_id       uuid not null references public.hu(id) on delete cascade,
  owner_id    uuid references auth.users(id) on delete cascade,
  evento      text not null,                      -- estado | ha_agregada | ha_eliminada | ha_esperadas
  detalle     text,
  usuario     text,
  created_at  timestamptz not null default now()
);
create index hu_historial_hu_idx on public.hu_historial(hu_id, created_at desc);
create index hu_historial_owner_idx on public.hu_historial(owner_id);

-- 2. Trazabilidad automática -------------------------------------------

create or replace function public.tg_hu_cambios() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  if new.estado is distinct from old.estado then
    insert into public.hu_historial (hu_id, owner_id, evento, detalle, usuario)
    values (new.id, new.owner_id, 'estado', old.estado || ' → ' || new.estado, auth.jwt() ->> 'email');
  end if;
  if new.ha_esperadas is distinct from old.ha_esperadas then
    insert into public.hu_historial (hu_id, owner_id, evento, detalle, usuario)
    values (new.id, new.owner_id, 'ha_esperadas',
            coalesce(old.ha_esperadas::text, '—') || ' → ' || coalesce(new.ha_esperadas::text, '—'),
            auth.jwt() ->> 'email');
  end if;
  return new;
end $$;

create trigger hu_cambios before update on public.hu
  for each row execute function public.tg_hu_cambios();

create or replace function public.tg_ha_log() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.hu_historial (hu_id, owner_id, evento, detalle, usuario)
    values (new.hu_id, new.owner_id, 'ha_agregada', new.codigo || coalesce(' · ' || new.titulo, ''), auth.jwt() ->> 'email');
    return new;
  else
    if exists (select 1 from public.hu where id = old.hu_id) then
      insert into public.hu_historial (hu_id, owner_id, evento, detalle, usuario)
      values (old.hu_id, old.owner_id, 'ha_eliminada', old.codigo || coalesce(' · ' || old.titulo, ''), auth.jwt() ->> 'email');
    end if;
    return old;
  end if;
end $$;

create trigger ha_log after insert or delete on public.ha
  for each row execute function public.tg_ha_log();

-- 3. Seguridad: cada usuario solo ve lo suyo ---------------------------

alter table public.hu           enable row level security;
alter table public.ha           enable row level security;
alter table public.hu_historial enable row level security;

create policy "hu propias" on public.hu for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy "ha propias" on public.ha for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.hu h where h.id = hu_id and h.owner_id = (select auth.uid()))
  );

create policy "historial propio lectura" on public.hu_historial for select to authenticated
  using (owner_id = (select auth.uid()));
create policy "historial propio insercion" on public.hu_historial for insert to authenticated
  with check (owner_id = (select auth.uid()));

-- 4. HU iniciales sin dueño: las reclama la primera cuenta que entra ---

create or replace function public.reclamar_hu_iniciales() returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0;
begin
  if auth.uid() is null then return 0; end if;
  if exists (select 1 from public.hu where owner_id = auth.uid()) then return 0; end if;
  update public.hu set owner_id = auth.uid() where owner_id is null;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.reclamar_hu_iniciales() from public, anon;
grant execute on function public.reclamar_hu_iniciales() to authenticated;

-- 5. Tiempo real -------------------------------------------------------

alter publication supabase_realtime add table public.hu, public.ha, public.hu_historial;

-- 6. Datos iniciales (opcional) -------------------------------------
-- HU sin dueño: las reclama la primera cuenta que inicia sesión.
-- insert into public.hu (owner_id, codigo, titulo, ha_esperadas, orden) values
--   (null, '0000001', 'Ejemplo de HU', 2, 0);
