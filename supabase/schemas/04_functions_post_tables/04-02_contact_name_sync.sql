-- Resolves the saved contact display name for a phone/address.
create function public.resolve_contact_name(
  p_organization_id uuid,
  p_address text
) returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    nullif(trim(ct.name), ''),
    nullif(trim(ca.extra->>'name'), ''),
    nullif(trim(ca.extra->'synced'->>'name'), '')
  )
  from public.contacts_addresses ca
  left join public.contacts ct on ct.id = ca.contact_id
  where ca.organization_id = p_organization_id
    and ca.address = p_address;
$$;

-- Copies a contact name onto conversations when the conversation still has no
-- custom title (null, raw phone, or a previous auto-resolved contact name).
create function public.sync_conversation_names_for_address(
  p_organization_id uuid,
  p_address text,
  p_name text default null,
  p_previous_name text default null
) returns void
language plpgsql
set search_path = ''
as $$
declare
  _name text := coalesce(
    nullif(trim(p_name), ''),
    public.resolve_contact_name(p_organization_id, p_address)
  );
begin
  if _name is null then
    return;
  end if;

  update public.conversations c
  set name = _name
  where c.organization_id = p_organization_id
    and c.contact_address = p_address
    and (
      c.name is null
      or c.name = c.contact_address
      or (p_previous_name is not null and c.name = p_previous_name)
    );
end;
$$;

create function public.sync_conversation_names_on_contact_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.name is not distinct from old.name then
    return new;
  end if;

  if new.name is null then
    return new;
  end if;

  update public.conversations c
  set name = new.name
  from public.contacts_addresses ca
  where ca.contact_id = new.id
    and c.organization_id = ca.organization_id
    and c.contact_address = ca.address
    and (
      c.name is null
      or c.name = c.contact_address
      or c.name = old.name
    );

  return new;
end;
$$;

create function public.sync_conversation_names_on_address_link() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  _name text;
begin
  if new.contact_id is null then
    return new;
  end if;

  select name into _name
  from public.contacts
  where id = new.contact_id;

  perform public.sync_conversation_names_for_address(
    new.organization_id,
    new.address,
    _name
  );

  return new;
end;
$$;

create or replace function public.before_insert_on_messages() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  _contact_name text;
begin
  -- If conversation_id is already provided, proceed as is
  if new.conversation_id is not null then
    return new;
  end if;

  if new.contact_address is not null then
    _contact_name := public.resolve_contact_name(
      new.organization_id,
      new.contact_address
    );
  end if;

  -- Look up conversation_id from conversation table
  select id into new.conversation_id
  from public.conversations
  where organization_address = new.organization_address
    and contact_address is not distinct from new.contact_address
    and group_address is not distinct from new.group_address
    and status = 'active'
  order by created_at desc
  limit 1;

  if new.conversation_id is not null and new.contact_address is not null then
    perform public.sync_conversation_names_for_address(
      new.organization_id,
      new.contact_address,
      _contact_name
    );
  end if;

  -- Create conversation if it doesn't exist
  if new.conversation_id is null then
    insert into public.conversations (
      organization_id,
      organization_address,
      contact_address,
      group_address,
      service,
      name
    ) values (
      new.organization_id,
      new.organization_address,
      new.contact_address,
      new.group_address,
      new.service,
      _contact_name
    )
    returning id into new.conversation_id;
  end if;

  return new;
end;
$$;

-- Saves a contact name for a phone/address and links it safely, including
-- WhatsApp-synced addresses where a plain upsert is blocked by RLS.
create function public.link_contact_to_address(
  p_organization_id uuid,
  p_address text,
  p_name text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  _contact_id uuid;
  _existing_contact_id uuid;
  _address_exists boolean := false;
  _trimmed_name text := nullif(trim(p_name), '');
begin
  if _trimmed_name is null then
    raise exception using
      errcode = '22023',
      message = 'contact name is required';
  end if;

  if p_organization_id not in (select public.get_authorized_orgs('member')) then
    raise exception using
      errcode = '42501',
      message = 'insufficient permissions to link this contact';
  end if;

  select contact_id, true
  into _existing_contact_id, _address_exists
  from public.contacts_addresses
  where organization_id = p_organization_id
    and address = p_address;

  if _existing_contact_id is not null then
    update public.contacts
    set name = _trimmed_name
    where id = _existing_contact_id
      and organization_id = p_organization_id;

    _contact_id := _existing_contact_id;
  else
    insert into public.contacts (organization_id, name)
    values (p_organization_id, _trimmed_name)
    returning id into _contact_id;
  end if;

  if _address_exists then
    update public.contacts_addresses
    set contact_id = _contact_id
    where organization_id = p_organization_id
      and address = p_address;
  else
    insert into public.contacts_addresses (
      organization_id,
      address,
      service,
      contact_id,
      status,
      extra
    ) values (
      p_organization_id,
      p_address,
      'whatsapp',
      _contact_id,
      'active',
      jsonb_build_object('name', _trimmed_name)
    );
  end if;

  perform public.sync_conversation_names_for_address(
    p_organization_id,
    p_address,
    _trimmed_name
  );

  return _contact_id;
end;
$$;

create or replace function public.init_data(
  p_organization_id uuid,
  p_limit integer default 200,
  p_per_conversation integer default 100,
  p_since timestamptz default null,
  p_until timestamptz default null
)
returns json
language plpgsql
stable
security invoker
set search_path to ''
as $$
declare
  _messages json;
  _conversations json;
  _conversation_ids uuid[];
begin
  with windowed as (
    select m.*,
      row_number() over (
        partition by m.conversation_id
        order by m.timestamp desc
      ) as rn
    from public.messages m
    where m.organization_id = p_organization_id
      and (p_since is null or m.timestamp > p_since)
      and (p_until is null or m.timestamp < p_until)
  ),
  limited as (
    select * from windowed
    where rn <= p_per_conversation
    order by timestamp desc
    limit p_limit
  )
  select
    coalesce(json_agg(row_to_json(l.*)), '[]'::json),
    array_agg(distinct l.conversation_id)
  into _messages, _conversation_ids
  from limited l;

  select coalesce(json_agg(enriched.payload), '[]'::json)
  into _conversations
  from (
    select
      (row_to_json(c)::jsonb || jsonb_build_object(
        'name', coalesce(
          nullif(trim(c.name), ''),
          public.resolve_contact_name(c.organization_id, c.contact_address)
        ),
        'contact_name', public.resolve_contact_name(
          c.organization_id,
          c.contact_address
        )
      ))::json as payload
    from public.conversations c
    where c.id = any(_conversation_ids)
  ) enriched;

  return json_build_object(
    'conversations', _conversations,
    'messages', _messages
  );
end;
$$;

create trigger sync_conversation_name_on_contact_update
after update of name
on public.contacts
for each row
execute function public.sync_conversation_names_on_contact_update();

create trigger sync_conversation_name_on_address_link
after insert or update of contact_id
on public.contacts_addresses
for each row
execute function public.sync_conversation_names_on_address_link();
