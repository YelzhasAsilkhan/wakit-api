create or replace function public.change_contact_address(
  p_organization_id uuid,
  old_address text,
  new_address text
)
returns void
language plpgsql
security invoker
set search_path to ''
as $$
declare
  _contact_id uuid;
  _service public.service;
begin
  -- 1. Search for old contact address and get service & contact_id
  select service, contact_id into _service, _contact_id
  from public.contacts_addresses
  where organization_id = p_organization_id
    and address = old_address;

  if _service is null then
    return; -- Exit if not found
  end if;

  -- 2. Create new contact address (linked to same contact if it exists)
  -- Add extra.replaces_address
  insert into public.contacts_addresses (
    organization_id, service, address, contact_id, status, extra
  )
  values (
    p_organization_id, 
    _service, 
    new_address, 
    _contact_id, 
    'active',
    jsonb_build_object('replaces_address', old_address)
  )
  on conflict (organization_id, address) do update set
    contact_id = EXCLUDED.contact_id,
    status = 'active',
    extra = jsonb_set(
      coalesce(public.contacts_addresses.extra, '{}'::jsonb),
      '{replaces_address}',
      to_jsonb(old_address)
    );

  -- 3. Update old contact address status and add reference to new address
  update public.contacts_addresses set 
    status = 'inactive',
    extra = jsonb_set(
      coalesce(extra, '{}'::jsonb),
      '{replaced_by_address}',
      to_jsonb(new_address)
    )
  where organization_id = p_organization_id
    and address = old_address;
end;
$$;

create function public.init_data(
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
  -- Windowed messages: up to p_per_conversation per conversation, total p_limit
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

  -- Fetch conversations for the messages returned
  select coalesce(json_agg(row_to_json(c.*)), '[]'::json)
  into _conversations
  from public.conversations c
  where c.id = any(_conversation_ids);

  return json_build_object(
    'conversations', _conversations,
    'messages', _messages
  );
end;
$$;

-- Close the active conversation and start a fresh one with the same participants.
-- Old messages remain on the closed conversation; the new one starts empty.
create or replace function public.restart_conversation(
  p_conversation_id uuid
)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $$
declare
  _conv public.conversations%rowtype;
  _new_id uuid;
  _extra jsonb;
begin
  select * into _conv
  from public.conversations
  where id = p_conversation_id
    and status = 'active';

  if not found then
    raise exception 'Active conversation not found: %', p_conversation_id;
  end if;

  update public.conversations
  set
    status = 'closed',
    extra = coalesce(extra, '{}'::jsonb)
      - 'paused'
      - 'memory'
      || jsonb_build_object('closed_reason', 'restart', 'closed_at', now())
  where id = p_conversation_id;

  _extra := coalesce(_conv.extra, '{}'::jsonb)
    - 'paused'
    - 'memory'
    - 'archived';

  insert into public.conversations (
    organization_id,
    service,
    organization_address,
    contact_address,
    group_address,
    name,
    status,
    extra
  )
  values (
    _conv.organization_id,
    _conv.service,
    _conv.organization_address,
    _conv.contact_address,
    _conv.group_address,
    _conv.name,
    'active',
    _extra
  )
  returning id into _new_id;

  return _new_id;
end;
$$;
