-- ============================================================
-- Guardar los comprobantes para que dona Elvia los pueda ver
--
-- Correr en: Supabase -> SQL Editor -> New query -> Run
-- (sobre el proyecto de dona Elvia, no el de la academia)
-- ============================================================

-- 1. Columna con la ruta de la imagen dentro del bucket
alter table public.pagos
  add column if not exists imagen_path text;

-- 2. Bucket privado, solo imagenes, 5 MB por archivo
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('comprobantes', 'comprobantes', false, 5242880,
        array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = 5242880,
      allowed_mime_types = array['image/jpeg','image/png','image/webp'];

-- 3. Sin politicas para "anon": las imagenes las sube y las
--    entrega el servidor, nunca el navegador directamente.
drop policy if exists "Publico sube comprobantes" on storage.objects;
drop policy if exists "Autenticados leen comprobantes" on storage.objects;
drop policy if exists "Autorizados leen comprobantes" on storage.objects;

create policy "Autorizados leen comprobantes"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'comprobantes' and public.es_autorizado());

-- ============================================================
-- Verificacion
-- ============================================================
-- select column_name from information_schema.columns
--   where table_name = 'pagos' and column_name = 'imagen_path';
-- select id, public, file_size_limit from storage.buckets;
