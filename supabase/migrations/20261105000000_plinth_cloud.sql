-- Plinth cloud: projects, who may open them, and every change to them.
--
-- A project's content is a Yjs document. Its changes are kept as rows of
-- project_changes (base64 Yjs updates); opening a project loads them all
-- and merges them. Copies open at the same time pass changes to each other
-- live over a private Realtime channel named "project:<id>". From time to
-- time a client folds the rows into one (compaction).

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null default 'Untitled',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.project_members (
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'editor' check (role in ('editor', 'viewer')),
  primary key (project_id, user_id)
);

create table public.project_changes (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  author uuid default auth.uid() references auth.users (id) on delete set null,
  change text not null,
  created_at timestamptz not null default now()
);

create index project_changes_by_project on public.project_changes (project_id, id);
create index project_members_by_user on public.project_members (user_id);

-- Who may see and who may change a project: its owner and its members.

create function public.can_read_project(project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from projects where id = project and owner = auth.uid())
      or exists (select 1 from project_members where project_id = project and user_id = auth.uid())
$$;

create function public.can_edit_project(project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from projects where id = project and owner = auth.uid())
      or exists (select 1 from project_members where project_id = project and user_id = auth.uid() and role = 'editor')
$$;

alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.project_changes enable row level security;

create policy "members see projects" on public.projects
  for select to authenticated using (public.can_read_project(id));
create policy "anyone signed in makes projects" on public.projects
  for insert to authenticated with check (owner = auth.uid());
create policy "editors rename projects" on public.projects
  for update to authenticated using (public.can_edit_project(id));
create policy "owners delete projects" on public.projects
  for delete to authenticated using (owner = auth.uid());

create policy "members see who else is in" on public.project_members
  for select to authenticated using (public.can_read_project(project_id));
create policy "owners remove members" on public.project_members
  for delete to authenticated
  using (exists (select 1 from public.projects where id = project_id and owner = auth.uid()) or user_id = auth.uid());

create policy "members read changes" on public.project_changes
  for select to authenticated using (public.can_read_project(project_id));
create policy "editors add changes" on public.project_changes
  for insert to authenticated with check (public.can_edit_project(project_id));
create policy "editors fold changes together" on public.project_changes
  for delete to authenticated using (public.can_edit_project(project_id));

-- Keeps a project's time of last change up to date.
create function public.touch_project() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update projects set updated_at = now() where id = new.project_id;
  return new;
end
$$;

create trigger project_changed after insert on public.project_changes
  for each row execute function public.touch_project();

-- Inviting someone by the email address they signed in with.
create function public.invite_to_project(project uuid, email text, member_role text default 'editor') returns void
language plpgsql security definer set search_path = public as $$
declare
  invitee uuid;
begin
  if not exists (select 1 from projects where id = project and owner = auth.uid()) then
    raise exception 'Only the owner of a project can invite people to it.';
  end if;
  select id into invitee from auth.users where lower(auth.users.email) = lower(invite_to_project.email);
  if invitee is null then
    raise exception 'Nobody has signed in with that email address yet.';
  end if;
  insert into project_members (project_id, user_id, role) values (project, invitee, member_role)
    on conflict (project_id, user_id) do update set role = excluded.role;
end
$$;

-- Live channels: "project:<id>", private, open to the project's members.
create policy "members listen to their projects" on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and public.can_read_project(split_part(realtime.topic(), ':', 2)::uuid)
  );
create policy "members talk on their projects" on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and public.can_read_project(split_part(realtime.topic(), ':', 2)::uuid)
  );
