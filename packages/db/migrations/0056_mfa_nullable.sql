-- G-N3: people.mfa is "unknown" (null) until something has actually read the person's second factors (a sign-in with one, or the provider read at API start).
-- Before this it was false by default, so a provider that was unreachable at start showed everyone as "Not enrolled".
alter table people alter column mfa drop not null;
alter table people alter column mfa drop default;
update people set mfa = null where mfa = false and mfa_checked_at is null;
