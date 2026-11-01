-- CW-RUST-M02 fixtures: one seeded dataset shared by the Rust live tests (tests/live.rs) and the parity
-- script (verification/src/m02-parity.ts). Applied by an ADMIN connection to an EPHEMERAL migrated database,
-- inside one transaction. Idempotent: it replaces its own grants, memberships and roles on every run. All ids are fixed so both
-- harnesses address the same actors. Names and emails are invented; no real person or patient.
--
-- Orgs:  A = f0000000-0000-4000-8000-00000000000a   B = f0000000-0000-4000-8000-00000000000b
-- Keys:  real permission keys (FK to `permission`): patient.read, visit.read, encounter.read, role.read,
--        role.manage, audit.read, breakglass.invoke, billing.claim.read, administration.read

-- ---- cleanup (children first) ----
DELETE FROM membership_role WHERE organization_id IN ('f0000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8000-00000000000b');
DELETE FROM membership WHERE organization_id IN ('f0000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8000-00000000000b');
DELETE FROM role_permission WHERE role_id::text LIKE 'f0000000-0000-4000-8001-%';
DELETE FROM role WHERE id::text LIKE 'f0000000-0000-4000-8001-%';
-- Organizations and users are kept (audit_event references them and is append-only); they are upserted below.

-- ---- orgs ----
INSERT INTO organization (id, slug, legal_name, display_name, status) VALUES
  ('f0000000-0000-4000-8000-00000000000a', 'm02-fixture-a', 'M02 Fixture Hospice A', 'Fixture A', 'active'),
  ('f0000000-0000-4000-8000-00000000000b', 'm02-fixture-b', 'M02 Fixture Hospice B', 'Fixture B', 'active')
ON CONFLICT (id) DO NOTHING;

-- ---- users (8002-…NN) ----
INSERT INTO "user" (id, email, name) VALUES
  ('f0000000-0000-4000-8002-000000000001', 'u1@m02.invalid', 'Fixture Multi-Org Staff'),
  ('f0000000-0000-4000-8002-000000000002', 'u2@m02.invalid', 'Fixture Disabled Role'),
  ('f0000000-0000-4000-8002-000000000003', 'u3@m02.invalid', 'Fixture Expiring Grants'),
  ('f0000000-0000-4000-8002-000000000004', 'u4@m02.invalid', 'Fixture Suspended'),
  ('f0000000-0000-4000-8002-000000000005', 'u5@m02.invalid', 'Fixture Revoked'),
  ('f0000000-0000-4000-8002-000000000006', 'u6@m02.invalid', 'Fixture Platform Role'),
  ('f0000000-0000-4000-8002-000000000007', 'u7@m02.invalid', 'Fixture Reserved Tenant Rows'),
  ('f0000000-0000-4000-8002-000000000008', 'u8@m02.invalid', 'Fixture No Membership'),
  ('f0000000-0000-4000-8002-000000000009', 'u9@m02.invalid', 'Fixture Pending')
ON CONFLICT (id) DO NOTHING;

-- ---- roles (8001-…) ----
INSERT INTO role (id, organization_id, key, name, category, enabled) VALUES
  ('f0000000-0000-4000-8001-0000000000a1', 'f0000000-0000-4000-8000-00000000000a', 'm02_rn',        'RN',        'clinical_staff', true),
  ('f0000000-0000-4000-8001-0000000000a2', 'f0000000-0000-4000-8000-00000000000a', 'm02_scheduler', 'Scheduler', 'operations',     true),
  ('f0000000-0000-4000-8001-0000000000a3', 'f0000000-0000-4000-8000-00000000000a', 'm02_disabled',  'Disabled',  'operations',     false),
  ('f0000000-0000-4000-8001-0000000000b1', 'f0000000-0000-4000-8000-00000000000b', 'm02_admin_b',   'Admin B',   'admin_executive', true),
  ('f0000000-0000-4000-8001-0000000000f1', NULL,                                   'platform_m02_fixture', 'Platform fixture', 'platform_staff', true);

-- Legacy tenant rows carrying reserved keys. Migration 0318 added `role_platform_authority_platform_owned` NOT VALID,
-- so such rows can exist only where they predate it. Reproduce that state exactly: drop, insert, re-add NOT VALID.
ALTER TABLE role DROP CONSTRAINT role_platform_authority_platform_owned;
INSERT INTO role (id, organization_id, key, name, category, enabled) VALUES
  ('f0000000-0000-4000-8001-0000000000a5', 'f0000000-0000-4000-8000-00000000000a', 'platform_m02_legacy', 'Legacy platform key', 'operations', true),
  ('f0000000-0000-4000-8001-0000000000a6', 'f0000000-0000-4000-8000-00000000000a', 'ai_safety_owner',     'Legacy AI safety',    'operations', true),
  ('f0000000-0000-4000-8001-0000000000a4', 'f0000000-0000-4000-8000-00000000000a', 'helpdesk_m02',        'Legacy platform staff', 'platform_staff', true);
ALTER TABLE role ADD CONSTRAINT role_platform_authority_platform_owned CHECK (
  (organization_id IS NULL) OR ((key !~~ 'platform\_%'::text) AND (key <> 'ai_safety_owner'::text) AND (category <> 'platform_staff'::role_category))
) NOT VALID;

INSERT INTO role_permission (organization_id, role_id, permission_key) VALUES
  ('f0000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8001-0000000000a1', 'patient.read'),
  ('f0000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8001-0000000000a1', 'visit.read'),
  ('f0000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8001-0000000000a2', 'visit.read'),
  ('f0000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8001-0000000000a2', 'encounter.read'),
  ('f0000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8001-0000000000a3', 'role.manage'),
  ('f0000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8001-0000000000a4', 'billing.claim.read'),
  ('f0000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8001-0000000000a5', 'breakglass.invoke'),
  ('f0000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8001-0000000000a6', 'administration.read'),
  ('f0000000-0000-4000-8000-00000000000b', 'f0000000-0000-4000-8001-0000000000b1', 'role.read'),
  (NULL,                                   'f0000000-0000-4000-8001-0000000000f1', 'audit.read');

-- ---- memberships (8003-…) ----
INSERT INTO membership (id, user_id, organization_id, status) VALUES
  ('f0000000-0000-4000-8003-0000000001a0', 'f0000000-0000-4000-8002-000000000001', 'f0000000-0000-4000-8000-00000000000a', 'active'),
  ('f0000000-0000-4000-8003-0000000001b0', 'f0000000-0000-4000-8002-000000000001', 'f0000000-0000-4000-8000-00000000000b', 'active'),
  ('f0000000-0000-4000-8003-0000000002a0', 'f0000000-0000-4000-8002-000000000002', 'f0000000-0000-4000-8000-00000000000a', 'active'),
  ('f0000000-0000-4000-8003-0000000003a0', 'f0000000-0000-4000-8002-000000000003', 'f0000000-0000-4000-8000-00000000000a', 'active'),
  ('f0000000-0000-4000-8003-0000000004a0', 'f0000000-0000-4000-8002-000000000004', 'f0000000-0000-4000-8000-00000000000a', 'suspended'),
  ('f0000000-0000-4000-8003-0000000005a0', 'f0000000-0000-4000-8002-000000000005', 'f0000000-0000-4000-8000-00000000000a', 'revoked'),
  ('f0000000-0000-4000-8003-0000000006a0', 'f0000000-0000-4000-8002-000000000006', 'f0000000-0000-4000-8000-00000000000a', 'active'),
  ('f0000000-0000-4000-8003-0000000007a0', 'f0000000-0000-4000-8002-000000000007', 'f0000000-0000-4000-8000-00000000000a', 'active'),
  ('f0000000-0000-4000-8003-0000000009a0', 'f0000000-0000-4000-8002-000000000009', 'f0000000-0000-4000-8000-00000000000a', 'pending');

-- ---- grants ----
INSERT INTO membership_role (organization_id, membership_id, role_id, expires_at) VALUES
  -- U1 in A: rn + scheduler; in B: admin_b
  ('f0000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8003-0000000001a0', 'f0000000-0000-4000-8001-0000000000a1', NULL),
  ('f0000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8003-0000000001a0', 'f0000000-0000-4000-8001-0000000000a2', NULL),
  ('f0000000-0000-4000-8000-00000000000b', 'f0000000-0000-4000-8003-0000000001b0', 'f0000000-0000-4000-8001-0000000000b1', NULL),
  -- U2: disabled role only
  ('f0000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8003-0000000002a0', 'f0000000-0000-4000-8001-0000000000a3', NULL),
  -- U3: rn expired an hour ago; scheduler expires tomorrow
  ('f0000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8003-0000000003a0', 'f0000000-0000-4000-8001-0000000000a1', now() - interval '1 hour'),
  ('f0000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8003-0000000003a0', 'f0000000-0000-4000-8001-0000000000a2', now() + interval '1 day'),
  -- U4 suspended, U5 revoked, U9 pending: all hold rn
  ('f0000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8003-0000000004a0', 'f0000000-0000-4000-8001-0000000000a1', NULL),
  ('f0000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8003-0000000005a0', 'f0000000-0000-4000-8001-0000000000a1', NULL),
  ('f0000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8003-0000000009a0', 'f0000000-0000-4000-8001-0000000000a1', NULL),
  -- U6: platform-owned role (organization NULL) confers
  ('f0000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8003-0000000006a0', 'f0000000-0000-4000-8001-0000000000f1', NULL),
  -- U7: rn + three reserved tenant rows (platform_ key, ai_safety_owner, platform_staff category) that confer nothing
  ('f0000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8003-0000000007a0', 'f0000000-0000-4000-8001-0000000000a1', NULL),
  ('f0000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8003-0000000007a0', 'f0000000-0000-4000-8001-0000000000a4', NULL),
  ('f0000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8003-0000000007a0', 'f0000000-0000-4000-8001-0000000000a5', NULL),
  ('f0000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8003-0000000007a0', 'f0000000-0000-4000-8001-0000000000a6', NULL);
