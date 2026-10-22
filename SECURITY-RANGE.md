# ⚠️ Security Training Range — intentionally vulnerable

This branch (`hunter/vuls`) is a **deliberately vulnerable** build of the CEX Demo,
made as a hands-on security-training target (like OWASP Juice Shop or DVWA). It
contains security weaknesses that were introduced on purpose for people to find
and practice on.

**Do not:**
- deploy this branch anywhere, expose it to the internet, or point it at real
  funds, real keys, or real users;
- treat any code on this branch as a secure reference.

Use it only against the local demo stack (`pnpm demo:up`), which runs on a
simulated chain with test data. The `main` branch is the normal, non-range build.

The specific issues and their locations are not documented in this repository —
finding them is the exercise.
