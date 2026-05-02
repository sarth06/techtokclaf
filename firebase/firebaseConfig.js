// Firebase Client-Side Configuration
// Replace these values with your Firebase project settings.
// These values are safe to expose in client-side code.

const firebaseConfig = {
  apiKey: window.ENV_FIREBASE_API_KEY || "YOUR_API_KEY",
  authDomain: window.ENV_FIREBASE_AUTH_DOMAIN || "your-project.firebaseapp.com",
  projectId: window.ENV_FIREBASE_PROJECT_ID || "your-project-id",
  storageBucket: window.ENV_FIREBASE_STORAGE_BUCKET || "your-project.appspot.com",
  messagingSenderId: window.ENV_FIREBASE_MESSAGING_SENDER_ID || "123456789",
  appId: window.ENV_FIREBASE_APP_ID || "1:123456789:web:abcdefabcdef",
};

// Export for use in frontend JavaScript
if (typeof module !== 'undefined' && module.exports) {
  module.exports = firebaseConfig;
}
