# CoGo City Backend Linkage QA Checklist

Use this checklist to confirm buttons, links, and dashboard actions are connected to the staging database instead of old browser/local-only storage.

## Test Rule

An action passes only when all four are true:

1. The action changes the current screen.
2. A backend `/api/...` request is recorded.
3. The result survives hard refresh or sign out/sign in.
4. The result appears from a second browser/device or from the other user's account when relevant.

If an action only changes the current browser and disappears in Incognito, it is local/browser-only and must be fixed before production.

## Setup

- Use staging only: `https://staging.cogocity.com`
- Use Stripe test mode only.
- Use a clean Incognito window for each major test section.
- Open DevTools Console and paste `qa/backend-linkage-recorder.js` before testing each section.
- Keep a second Incognito window available for the other test user.

## Test Accounts

- Neighbor: Tatyana, `tanya.lipovich@gmail.com`
- Student: Daniel, `dan.lipovich@gmail.com`
- Employer: Ilya, `ilya.lipovich@getcider.com`
- Admin: Tatyana admin account

## How To Record Each Button

1. Paste the recorder script into the browser Console.
2. Click `Start QA recording` if the button appears, or run:

```js
window.CoGoQaRecorder.start('section name');
```

3. Perform one action, such as `Suspend user`.
4. Run:

```js
window.CoGoQaRecorder.summary();
```

5. Save the result in the table below.

## Pass/Fail Table

| Area | Button / Link | Expected Backend Call | Refresh Check | Second Device/User Check | Result |
| --- | --- | --- | --- | --- | --- |
| Signup | Student signup submit | `POST /api/auth/register` | User can sign in again | Admin Users shows user | |
| Signup | Employer signup submit | `POST /api/auth/register` | User can sign in again | Admin Users shows user | |
| Login | Sign in | `POST /api/auth/login` | Session restored or login works again | N/A | |
| Profile | Save profile | `PATCH /api/user-profile/me` | Profile stays updated | Admin/profile page shows update | |
| Student services | Add service | `POST /api/student-profiles/.../services` or `PATCH /api/student-profiles/...` | Service stays | Browse Students shows service | |
| Student services | Edit service | `PATCH /api/services/...` | Edit stays | Browse Students shows edit | |
| Community | Post normal feed post | `POST /api/community-posts` or `POST /api/sync/posts` | Post stays | Other user sees post | |
| Community | Post job opportunity | `POST /api/community-posts` and/or `POST /api/jobs` | Job post stays | Student can apply | |
| Community | Delete post | `DELETE /api/community-posts/...` | Post stays gone | Other user cannot see post | |
| Jobs | Employer post job | `POST /api/jobs` and Stripe job checkout calls when paid | Job stays | Admin/Jobs sees job | |
| Jobs | Student apply | `POST /api/jobs/.../apply` | Application stays | Employer sees applicant | |
| Jobs | Employer accept applicant | project/application API call | Project stays | Student sees project | |
| Booking | Neighbor books student | `POST /api/projects/start` plus Stripe payment call | Project stays | Student sees project | |
| Project | Student submits final hours | `PATCH /api/projects/.../complete` | Hours stay | Employer sees final invoice | |
| Project | Employer approves invoice | `PATCH /api/projects/.../approve` plus Stripe capture | Transaction stays | Student/Admin transactions match | |
| Transactions | My Transactions | `GET /api/transactions` | Same after refresh | Other device matches | |
| Reviews | Submit review | `POST /api/projects/.../review` | Review stays | Student profile shows review | |
| Messages | Send DM | `POST /api/messages` | Message stays | Recipient sees unread count | |
| Messages | Mark/read/open thread | `GET /api/messages` and read update if available | Unread count updates | Recipient account matches | |
| Notifications | Bell/envelope open | `GET /api/notifications` or `GET /api/messages` | Count updates | N/A | |
| Admin Users | Edit user | `PATCH /api/auth/admin/users/...` | Edit stays | User profile/login reflects edit | |
| Admin Users | Suspend user | `PATCH /api/auth/admin/users/...` | Status stays suspended | User cannot sign in/use account | |
| Admin Users | Unsuspend user | `PATCH /api/auth/admin/users/...` | Status stays active | User can sign in/use account | |
| Admin Users | Delete user | `DELETE /api/auth/admin/users/...` | User stays removed | Public content hidden | |
| Admin Users | Send password reset | `POST /api/auth/password-reset/request` | Email arrives | Link opens reset page | |
| Admin Advertising | Save ad | Advertising backend endpoint or documented backend record | Ad stays after refresh | Other browser sees ad | |

## Red Flags

- The recorder shows only `localStorage` writes and no `/api/...` call.
- The UI says success but the item disappears after hard refresh.
- The item appears on desktop but not mobile.
- Admin sees a user/action but the action says `User not found`.
- Stripe shows a payment but Transactions do not show it after refresh.
- A deleted or suspended user still appears publicly.

## Required Before Production

- Every row above marked Pass.
- Any local-only action either fixed or intentionally documented as temporary.
- Admin delete/suspend/password reset verified against staging database.
- All payment flows verified in Stripe test mode and Transactions.
- Final clean Incognito test completed on desktop and mobile.
