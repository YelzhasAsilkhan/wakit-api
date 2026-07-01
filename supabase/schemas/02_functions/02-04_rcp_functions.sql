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

-- Marks every unread incoming message of a conversation as read.
--
-- Intended as an endpoint for the UI ("clear from waiting" button): once all
-- incoming messages carry a status.read timestamp the conversation's unread
-- count drops to zero, so it leaves the "waiting" filter and shows up only in
-- the general list.
--
-- The messages table has no UPDATE policy on purpose (users cannot edit
-- messages), so this runs as SECURITY DEFINER and authorizes the caller
-- explicitly via get_authorized_orgs. Setting status.read merges into the
-- existing status (set_status trigger) and triggers WhatsApp read receipts
-- (handle_mark_as_read_to_dispatcher).
create function public.mark_conversation_as_read(
  p_conversation_id uuid
)
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare
  _organization_id uuid;
  _updated_count integer;
begin
  select organization_id into _organization_id
  from public.conversations
  where id = p_conversation_id;

  if _organization_id is null then
    raise exception using
      errcode = 'P0002',
      message = 'conversation not found';
  end if;

  -- Caller must be at least a member of the conversation's organization.
  if _organization_id not in (select public.get_authorized_orgs('member')) then
    raise exception using
      errcode = '42501',
      message = 'insufficient permissions to mark this conversation as read';
  end if;

  with updated as (
    update public.messages
    set status = jsonb_build_object('read', now())
    where conversation_id = p_conversation_id
      and direction = 'incoming'
      and (status ->> 'read') is null
    returning 1
  )
  select count(*) into _updated_count from updated;

  return _updated_count;
end;
$$;
