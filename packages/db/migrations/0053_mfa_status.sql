-- MFA review (S-124, S-127): what Gantry knows about each person's second factors.
--   mfa             a second factor was part of their last sign-in (it was never written before; the People list showed "No MFA" for everyone)
--   mfa_types       the kinds they hold at the identity provider (otp, webauthn, recovery-authn-codes), when the provider told us
--   mfa_fingerprint a hash of their authenticator ids at the provider; a different one at the next sign-in means a reset behind Gantry's back (audited)
--   mfa_checked_at  when this was last recorded
alter table people
  add column mfa_types text[] not null default '{}',
  add column mfa_fingerprint text,
  add column mfa_checked_at timestamptz;
