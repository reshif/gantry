-- Factory Admins must sign in with a second factor. The sign-in records whether the identity provider's token carried evidence of one
-- (acr/amr); the API refuses a Factory Admin's request on a session without it. Existing sessions default to false, so an admin's
-- current session ends at the next request and they sign in again with the code.
alter table sessions add column second_factor boolean not null default false;
