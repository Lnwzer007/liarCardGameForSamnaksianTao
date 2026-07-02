// ==========================================================================
// วาง Firebase config ของคุณตรงนี้ (ได้จาก Firebase Console > Project settings)
// ดูขั้นตอนสมัคร/ตั้งค่าใน README.md
// ==========================================================================
const firebaseConfig = {
  apiKey: "AIzaSyD6qXjurbN7lWRGWmRc3MW4A8Q-8XKCGJA",
  authDomain: "liarcardgameapi.firebaseapp.com",
  // ⚠️ ต้องใส่ databaseURL เอง! ไปที่ Firebase Console > Build > Realtime Database
  // (ถ้ายังไม่มีให้กด "Create Database" ก่อน) แล้วคัดลอก URL จากด้านบนของหน้ามาแปะแทนบรรทัดนี้
  databaseURL: "https://liarcardgameapi-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "liarcardgameapi",
  storageBucket: "liarcardgameapi.firebasestorage.app",
  messagingSenderId: "276993407201",
  appId: "1:276993407201:web:168fd9f2b1d53849615fa0",
  measurementId: "G-5XCQLP28L8"
};

firebase.initializeApp(firebaseConfig);