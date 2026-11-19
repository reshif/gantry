-- G-N3: people.mfa is "unknown" (null) until something has actually read the person's second factors (a sign-in with one, or the provider read at API start).
-- Before this it was false for everyone, so a provider that was unreachable at start showed everyone as "Not enrolled". New rows keep the
-- default (false: an invited person has not enrolled yet); existing never-checked rows become unknown. Expand only: nothing is dropped.
alter table people alter column mfa drop not null;
update people set mfa = null where mfa = false and mfa_checked_at is null;
