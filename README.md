# سامانه چت‌روم تخصصی و بانک آموزشی بخش‌های بیمارستان

## راه‌اندازی روی GitHub و Render (رایگان)
1. یک مخزن (Repository) جدید در GitHub بسازید و فایل‌های این پوشه (`package.json`, `server.js`, `render.yaml`, `.gitignore` و پوشه `public/index.html`) را در آن آپلود کنید.
2. وارد سایت [Render.com](https://render.com) شوید و روی **New + → Web Service** کلیک کنید.
3. مخزن GitHub خود را انتخاب کنید:
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** `Free`
4. در بخش **Environment Variables** (اختیاری) می‌توانید `ADMIN_CODE` (کد سرپرستار) را به رمز دلخواه خود تغییر دهید.
5. روی **Create Web Service** کلیک کنید تا لینک اختصاصی شما ساخته شود.
