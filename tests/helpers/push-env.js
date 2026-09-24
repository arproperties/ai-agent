// Throwaway VAPID keys for the tests, and nothing else.
//
// Import this BEFORE helpers/db.js in any test that touches notifications: server/push.js
// decides once, when it is first imported, whether notifications are possible at all, and
// it reads these through config.js. A static import runs before any line of the test body,
// so setting them inside the test file itself would be too late.
//
// Generated with `node scripts/vapid-keys.js` and then thrown away. They were never used
// to send anything to a real device, and the real ones live in .env, not here.
process.env.VAPID_PUBLIC_KEY = 'BK0jO7YNglclHKdyMc9HPtz0vzImUoCiwmxLLSGSyAn3zClBZLfadmnWdIZlkMrOVhKTjtBbHVr8DBZyBu33TVc';
process.env.VAPID_PRIVATE_KEY = 'VN5gvjygqhAV1jdEn7fQe9HvBkudGHmySjpzH_vQR6Y';
process.env.VAPID_SUBJECT = 'mailto:tests@example.com';
