-- M5-2: large withdrawals need two different approvers. The first approval is
-- audited as `first_approved` (review_status = 'pending_second_approval'); the
-- second one is the usual `approved`, followed by `broadcasted`.
alter table withdrawal_audit_logs
  drop constraint if exists withdrawal_audit_logs_action_check;

alter table withdrawal_audit_logs
  add constraint withdrawal_audit_logs_action_check check (
    action in ('requested', 'first_approved', 'approved', 'rejected', 'broadcasted', 'confirmed')
  );

-- The cooldown after adding a withdrawal address reads the newest entry per user.
create index if not exists idx_withdrawal_address_book_user_created_at
  on withdrawal_address_book (user_id, created_at desc);
