-- Link every activity_log entry to the établissement it is about (issue #8), so the
-- per-établissement history (issue #27) can read it back.
--
-- Nullable, and `on delete set null`: the Backlog is an audit trail, so deleting an
-- établissement keeps its rows — they simply lose the link. Entries about no établissement
-- (none today, but the Backlog is not limited to établissements) leave it unset too.
alter table public.activity_log
  add column if not exists place_ref uuid references public.places (id) on delete set null;

create index if not exists activity_log_place_ref_idx on public.activity_log (user_id, place_ref, at desc);

-- Backfill the rows written before the link existed. A row is linked only when its
-- place_name and address match exactly one of the same account's établissements; a row
-- matching none (the établissement is gone) or several (an ambiguous name + address)
-- stays unlinked rather than being attached to a guess.
update public.activity_log a
   set place_ref = m.place_ref
  from (
    select l.id, min(p.id::text)::uuid as place_ref
      from public.activity_log l
      join public.places p
        on p.user_id = l.user_id
       and p.name = l.place_name
       and p.address = l.address
     where l.place_ref is null
     group by l.id
    having count(*) = 1
  ) m
 where a.id = m.id;
