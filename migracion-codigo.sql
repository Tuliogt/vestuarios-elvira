-- ============================================================
-- Codigo de consulta: dos vocales + tres digitos (ej. AE472)
--
-- Sirve para que cada persona consulte SU pago sin ver los de
-- los demas. Es aleatorio, no correlativo.
-- ============================================================

alter table public.pagos
  add column if not exists codigo text;

-- Unico: dos pagos nunca pueden compartir codigo
create unique index if not exists pagos_codigo_idx
  on public.pagos (codigo)
  where codigo is not null;

-- ============================================================
-- Verificacion
-- ============================================================
-- select column_name from information_schema.columns
--   where table_name = 'pagos' and column_name = 'codigo';
