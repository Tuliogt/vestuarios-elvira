-- ============================================================
-- Vestuarios Elvia - Show de Diciembre   (v3)
-- Ejecutar en: Supabase -> SQL Editor -> New query -> Run
--
-- Diseno:
--   * Las imagenes NO se almacenan. Se procesan con Google
--     Vision y se descartan. Por eso no hay bucket.
--   * Los datos del pago los pone el OCR, no la persona. Solo
--     el nombre y el artista los escribe ella.
--   * El navegador del publico NO habla con esta base. Todo
--     pasa por el servidor, que usa la service_role key.
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- Pagos: una fila por comprobante leido
-- ------------------------------------------------------------
create table if not exists public.pagos (
  id                uuid primary key default gen_random_uuid(),
  nombre            text not null,
  artista           text not null,

  -- Todo esto sale del OCR; la persona no lo puede alterar
  fecha_comprobante date,
  remitente         text,
  cuenta_origen     text,
  monto             numeric(12,2),
  detalle           text,
  referencia        text not null unique,
  banco             text,

  ip_origen         text,
  creado_en         timestamptz not null default now()
);

create index if not exists pagos_nombre_idx on public.pagos (nombre);

-- ------------------------------------------------------------
-- Items: los cargos que dona Elvia asigna a cada persona
-- ------------------------------------------------------------
create table if not exists public.items (
  id             uuid primary key default gen_random_uuid(),
  nombre_persona text not null,
  item           text not null,
  precio         numeric(12,2) not null,
  creado_en      timestamptz not null default now()
);

create index if not exists items_persona_idx on public.items (nombre_persona);

-- ------------------------------------------------------------
-- Quien puede entrar al panel
-- ------------------------------------------------------------
create table if not exists public.usuarios_autorizados (
  correo text primary key
);

alter table public.usuarios_autorizados enable row level security;

create or replace function public.es_autorizado()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1 from public.usuarios_autorizados
    where lower(correo) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- >>> CAMBIA ESTE CORREO <<<
insert into public.usuarios_autorizados (correo)
values ('elvia@vestuarios.local')
on conflict (correo) do nothing;

-- ------------------------------------------------------------
-- Row Level Security
-- Sin politicas para "anon": la llave publica no puede nada.
-- ------------------------------------------------------------
alter table public.pagos enable row level security;
alter table public.items enable row level security;

drop policy if exists "Autorizados leen pagos" on public.pagos;
drop policy if exists "Autorizados manejan items" on public.items;

create policy "Autorizados leen pagos"
  on public.pagos for select
  to authenticated
  using (public.es_autorizado());

create policy "Autorizados manejan items"
  on public.items for all
  to authenticated
  using (public.es_autorizado())
  with check (public.es_autorizado());
