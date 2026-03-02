begin;

create table if not exists public.auth_passkeys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  user_email text not null,
  credential_id text not null,
  credential_public_key text not null,
  counter bigint not null default 0,
  transports text[] null,
  device_type text null,
  backed_up boolean null,
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  last_used_at timestamptz null,
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_auth_passkeys_credential_id
  on public.auth_passkeys (credential_id);

create index if not exists idx_auth_passkeys_user_email
  on public.auth_passkeys (lower(user_email));

create index if not exists idx_auth_passkeys_user_id
  on public.auth_passkeys (user_id);

create or replace function public.trg_set_auth_passkeys_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists auth_passkeys_set_updated_at on public.auth_passkeys;

create trigger auth_passkeys_set_updated_at
before update on public.auth_passkeys
for each row
execute function public.trg_set_auth_passkeys_updated_at();

commit;
